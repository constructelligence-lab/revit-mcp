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
import { Bridge, DEFAULT_BRIDGE_URL, DEFAULT_TIMEOUT_MS, discoverToken, TOKEN_FILE } from './bridge.mjs';
import { MockRevit } from './mock.mjs';

export const VERSION = '0.1.0';

const INSTRUCTIONS = [
  'revit-mcp reads the Autodesk Revit model the user has open, and can change one parameter at a time if the operator allowed it.',
  'Start with revit_status (is the bridge up, which document) and model_overview (what is in it).',
  'Element ids come from query_elements or current_selection — never invent one.',
  'Writes: set_parameter previews by default. Say what will change, in which document and on which element, and get a yes before calling it with apply: true. Each write is one Revit transaction, undoable with a single Ctrl+Z in Revit.',
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
const asError = (message, extra = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true });

/** The MCP server: one registration per catalogue entry, and the write gate in one place. */
export function buildServer({ bridge, allowWrites = false, version = VERSION } = {}) {
  const server = new McpServer({ name: 'revit-mcp', version }, { instructions: INSTRUCTIONS });

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
        const result = await bridge.call(tool.op, input ?? {});
        return asText(result);
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
