#!/usr/bin/env node
// revit-mcp — the MCP server in front of the Revit add-in.
//
//   node server.mjs                          # talk to a running Revit on 127.0.0.1:8712
//   node server.mjs --mock                   # the sample model, no Revit required
//   node server.mjs --allow-writes           # permit the write tools (the add-in has its own switch)
//
// An AI client (Claude Desktop, Claude Code, DSCode, any MCP client) speaks MCP over stdio to this
// process; this process speaks one loopback HTTP call per tool to the add-in inside Revit, which is the
// only place the Revit API can be touched, and only on Revit's own thread. Nothing here decides what a
// model contains — every number is Revit's, read live at call time, and every write is a single undoable
// transaction in the document the user has open. See docs/security.md for what that gate is and is not.
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS } from './tools.mjs';
import { PROMPTS } from './prompts.mjs';
import { RESOURCES } from './resources.mjs';
import { Bridge, DEFAULT_BRIDGE_URL, DEFAULT_TIMEOUT_MS, discoverToken, TOKEN_FILE } from './bridge.mjs';
import { MockRevit } from './mock.mjs';
import { buildRenderArgs } from './camera.mjs';
import { findBlender, buildJob, runBlender, encodeMp4, BLENDER_MISSING } from './blender.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, statSync } from 'node:fs';

export const VERSION = '0.3.0';

const INSTRUCTIONS = [
  'revit-mcp reads the Autodesk Revit model the user has open, and can change one parameter at a time if the operator allowed it.',
  'Start with revit_status (is the bridge up, which document) and model_overview (what is in it).',
  'Element ids come from query_elements or current_selection — never invent one.',
  'Writes: set_parameter previews by default. Say what will change, in which document and on which element, and get a yes before calling it with apply: true. Each write is one Revit transaction, undoable with a single Ctrl+Z in Revit.',
  'Pictures: render_scene (one camera) and render_gallery (a set) return the image itself. Look at it, say what works and what does not, and iterate: change the preset, the mood or the hidden categories. They never change the model.',
  'Everything here is a live read of a working model, not a QA report or an audit: warnings and counts are prompts to look, not findings. Say what you read and what you did not look at.',
].join(' ');

const USAGE = `revit-mcp ${VERSION}

  node server.mjs [options]

  --mock                 use the built-in sample model instead of Revit (for demos and tests)
  --bridge <url>         add-in address (default ${DEFAULT_BRIDGE_URL})
  --token <token>        bearer token, if the add-in asks for one (default: $REVIT_MCP_TOKEN, else ${TOKEN_FILE})
  --timeout <seconds>    per-call timeout (default ${DEFAULT_TIMEOUT_MS / 1000})
  --allow-writes         permit the write tools; the add-in must be started with its own switch too
  --help                 this text

Environment: REVIT_MCP_BRIDGE, REVIT_MCP_TOKEN, REVIT_MCP_TIMEOUT, REVIT_MCP_MOCK=1, REVIT_MCP_ALLOW_WRITES=1
Client config: see README.md ("Add the server to your client").
`;

/** Flags, with the environment as the default so a client config can stay a one-liner. */
export function parseArgs(argv = [], env = process.env) {
  const args = {
    bridgeUrl: env.REVIT_MCP_BRIDGE || DEFAULT_BRIDGE_URL,
    token: env.REVIT_MCP_TOKEN ?? '',
    timeoutMs: Number(env.REVIT_MCP_TIMEOUT) > 0 ? Number(env.REVIT_MCP_TIMEOUT) * 1000 : DEFAULT_TIMEOUT_MS,
    mock: env.REVIT_MCP_MOCK === '1',
    allowWrites: env.REVIT_MCP_ALLOW_WRITES === '1',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--mock') args.mock = true;
    else if (flag === '--allow-writes') args.allowWrites = true;
    else if (flag === '--bridge') args.bridgeUrl = argv[++i];
    else if (flag === '--token') args.token = argv[++i];
    else if (flag === '--timeout') args.timeoutMs = Number(argv[++i]) * 1000;
    else throw new Error(`Unknown argument '${flag}' (try --help)`);
  }
  if (!args.bridgeUrl && !args.mock) throw new Error('--bridge needs a URL, e.g. --bridge http://127.0.0.1:8712');
  return args;
}

/** The mock for demos and tests, the real bridge otherwise. Same two methods either way. */
export function createBridge(args) {
  if (args.mock) return new MockRevit({ writesAllowed: args.allowWrites });
  return new Bridge({ url: args.bridgeUrl, token: args.token || discoverToken(), timeoutMs: args.timeoutMs });
}

const asText = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

const IMAGE_LIMIT_BYTES = 6 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 180_000;

/** An image block for a file the add-in wrote, when this process can read it (same machine) and it is a sane size. */
function imageBlock(path) {
  try {
    if (!path || statSync(path).size > IMAGE_LIMIT_BYTES) return null;
    const mimeType = /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png';
    return { type: 'image', data: readFileSync(path).toString('base64'), mimeType };
  } catch {
    return null;
  }
}

/** Text first (what was made, with the camera), then the pictures themselves. */
const withImages = (value, paths) => {
  const images = paths.map(imageBlock).filter(Boolean);
  const note = images.length < paths.filter(Boolean).length
    ? { image_note: 'The image file exists on the Revit machine but this server could not read it (different machine, or over 6 MB). Open the path instead.' }
    : {};
  return { content: [{ type: 'text', text: JSON.stringify({ ...value, ...note }, null, 2) }, ...images] };
};

const DEFAULT_GALLERY = ['exterior_ne', 'exterior_nw', 'exterior_se', 'exterior_sw'];

const EXPORT_TIMEOUT_MS = 300_000;

const ENGINE = { find: findBlender, run: runBlender, mp4: encodeMp4 };

/** Tools that are more than one bridge call: they plan a camera from the model, then render or export. */
async function runComposite(tool, input, bridge, engine = ENGINE) {
  if (tool.kind === 'export') {
    const { format, ...rest } = input;
    const result = await bridge.call(`export.${format}`, rest, { timeoutMs: EXPORT_TIMEOUT_MS });
    return asText(result);
  }
  if (tool.kind === 'photoreal' || tool.kind === 'turntable') return runBlenderTool(tool, input, bridge, engine);

  const scene = tool.kind === 'render' && !input.preset ? null : await bridge.call('scene.info', {});
  if (tool.kind === 'render') {
    const { args } = buildRenderArgs(scene, input);
    const result = await bridge.call('scene.render', args, { timeoutMs: RENDER_TIMEOUT_MS });
    return withImages(result, [result.path]);
  }
  const { presets = DEFAULT_GALLERY, ...shared } = input;
  const shots = [];
  for (const preset of presets) {
    try {
      const { args } = buildRenderArgs(scene, { ...shared, preset, width: shared.width ?? 1600 });
      shots.push({ preset, ...(await bridge.call('scene.render', args, { timeoutMs: RENDER_TIMEOUT_MS })) });
    } catch (error) {
      // One bad shot (no rooms for an interior, say) must not throw away the others.
      shots.push({ preset, error: error?.message ?? String(error), code: error?.code });
    }
  }
  return withImages({ shots }, shots.map(s => s.path));
}

/**
 * Ray-traced pictures. The add-in exports the geometry once; Blender renders it here. Failures say what to
 * do (install Blender, lower the quality) rather than surfacing a stack trace.
 */
async function runBlenderTool(tool, input, bridge, engine) {
  const exe = engine.find();
  if (!exe) return asError(BLENDER_MISSING, { code: 'blender_missing' });

  const turntable = tool.kind === 'turntable';
  const scene = await bridge.call('scene.info', {});
  const wanted = turntable && !input.preset && !input.eye ? { ...input, preset: 'aerial_se' } : input;
  const { args, planned } = buildRenderArgs(scene, wanted);

  const exported = await bridge.call('export.gltf', {
    name: args.name ?? 'scene',
    ...(input.hide_categories ? { hide_categories: input.hide_categories } : {}),
    ...(input.section_box ? { section_box: input.section_box } : {}),
  }, { timeoutMs: EXPORT_TIMEOUT_MS });
  const gltf = exported?.extra?.gltf ?? exported?.files?.map(f => f.path).find(p => p.endsWith('.gltf'));
  if (!gltf) return asError('The add-in did not return a glTF file path.', { code: 'export_failed' });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = turntable ? join(tmpdir(), 'revit-mcp', `turntable-${stamp}`) : join(tmpdir(), 'revit-mcp', `photoreal-${args.name ?? 'render'}-${stamp}.png`);
  const job = buildJob({
    gltf, scene, camera: { eye: args.eye, target: args.target }, mood: input.mood, sun: args.sun,
    quality: input.quality ?? (turntable ? 'draft' : 'standard'),
    width: input.width ?? (turntable ? 1280 : 1920),
    ground: input.ground ?? 'grass', exposure: input.exposure ?? 0, gpu: Boolean(input.gpu), output,
    turntable: turntable ? { frames: input.frames ?? 36 } : null,
  });

  const result = await engine.run({ exe, job });
  const summary = {
    engine: 'Blender Cycles', quality: input.quality ?? (turntable ? 'draft' : 'standard'), device: result.device,
    camera: { eye: args.eye, target: args.target, shot: planned?.name ?? args.name },
    sun: job.sun, geometry: gltf, model_changed: false, notes: result.notes,
  };
  if (!turntable) return withImages({ ...summary, path: result.path, width: job.width, height: job.height }, [result.path]);

  const mp4 = await engine.mp4({ framesDir: result.frames_dir, fps: input.fps ?? 24 });
  return withImages({
    ...summary, frames_dir: result.frames_dir, frames: result.frames, mp4,
    ...(mp4 ? {} : { mp4_note: 'ffmpeg was not found, so there is no MP4: the frames are in frames_dir (frame_0001.png …). Install ffmpeg or set FFMPEG_PATH to encode them.' }),
  }, [result.middle]);
}

const asError = (message, extra = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true });

/**
 * The MCP server: the tool menu, the prompt menu (the workflows people actually run), live resources, and
 * the write gate in one place.
 */
export function buildServer({ bridge, allowWrites = false, version = VERSION, engine = ENGINE } = {}) {
  const server = new McpServer({ name: 'revit-mcp', version }, { instructions: INSTRUCTIONS });

  registerPrompts(server);
  registerResources(server, bridge);

  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.params,
      annotations: { readOnlyHint: !tool.write, destructiveHint: Boolean(tool.write), idempotentHint: !tool.write, openWorldHint: false },
    }, async input => {
      if (tool.write && !allowWrites) {
        return asError(
          `${tool.name} changes the model, and this server is read-only. Start it with --allow-writes (and the add-in with writes enabled) if that is what the user wants.`,
          { code: 'read_only_server' },
        );
      }
      try {
        if (tool.kind) return await runComposite(tool, input ?? {}, bridge, engine);
        const result = await bridge.call(tool.op, input ?? {});
        // A view export is a picture: hand the client the image, not just a path on another process's disk.
        return tool.op === 'view.export_image' ? withImages(result, [result?.path]) : asText(result);
      } catch (error) {
        const extra = { code: error?.code ?? 'error' };
        if (error?.code === 'unreachable') extra.hint = 'Open Revit with the add-in, or restart this server with --mock to work against the sample model.';
        if (error?.code === 'timeout') extra.hint = 'A modal dialog in Revit blocks the add-in; close it and retry.';
        if (error?.code === 'unauthorized') extra.hint = `Set REVIT_MCP_TOKEN, or read the add-in's token from ${TOKEN_FILE}.`;
        if (error?.code === 'writes_disabled') extra.hint = 'Enable writes in the add-in (its RevitMCP tab or appsettings), then retry.';
        return asError(error?.message ?? String(error), extra);
      }
    });
  }
  return server;
}

/**
 * Prompts are text, so they are the same for every session and cost nothing: the client asks for one by
 * name with its arguments and gets the instructions a competent person would have written down.
 */
function registerPrompts(server) {
  for (const prompt of PROMPTS) {
    server.registerPrompt(prompt.name, {
      title: prompt.title,
      description: prompt.description,
      argsSchema: prompt.args,
    }, args => ({
      messages: [{ role: 'user', content: { type: 'text', text: prompt.build(args ?? {}) } }],
    }));
  }
}

/**
 * Resources are live reads of the open model, addressed as revit://… so a client can attach one to a
 * conversation without spending a tool call. They run through the same bridge and the same errors as a
 * tool: a resource that cannot be read is a resource that says why.
 */
function registerResources(server, bridge) {
  for (const resource of RESOURCES) {
    server.registerResource(resource.name, resource.uri, {
      title: resource.name,
      description: resource.description,
      mimeType: 'application/json',
    }, async uri => {
      const result = await bridge.call(resource.op, {});
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result, null, 2) }] };
    });
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, env);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const bridge = createBridge(args);
  const server = buildServer({ bridge, allowWrites: args.allowWrites });
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; anything a human should read goes to stderr.
  console.error(`revit-mcp ${VERSION} · ${args.mock ? 'mock model (no Revit)' : args.bridgeUrl} · ${args.allowWrites ? 'writes ALLOWED' : 'read-only'}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`revit-mcp could not start: ${error.message}`);
    process.exit(1);
  });
}
