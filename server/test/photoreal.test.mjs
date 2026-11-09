// The ray-traced path and the new model reads/exports. Blender is not needed: the engine is injected, and the
// geometry the mock exports is a real glTF whose structure is checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sunPosition } from '../camera.mjs';
import { findBlender, buildJob, runBlender, encodeMp4, QUALITY } from '../blender.mjs';
import { buildServer } from '../server.mjs';
import { MockRevit } from '../mock.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('the sun is where an almanac says: solstice noon in Dublin, equinox sunrise side, winter low', () => {
  const noon = sunPosition(53.35, 6, 21, 12);
  assert.ok(Math.abs(noon.elevation - 60.1) < 0.8, `elevation ${noon.elevation}`);
  assert.ok(Math.abs(noon.azimuth - 180) < 1, `azimuth ${noon.azimuth}`);
  const morning = sunPosition(53.35, 3, 20, 8);
  assert.ok(morning.azimuth > 90 && morning.azimuth < 130, `morning sun is east-south-east, got ${morning.azimuth}`);
  const afternoon = sunPosition(53.35, 3, 20, 16);
  assert.ok(afternoon.azimuth > 230 && afternoon.azimuth < 270, `afternoon sun is west-south-west, got ${afternoon.azimuth}`);
  assert.ok(sunPosition(53.35, 12, 21, 12).elevation < 15, 'a Dublin winter noon is low');
  assert.ok(sunPosition(-33.9, 12, 21, 12).elevation > 75, 'and a Sydney summer noon is high');
});

test('findBlender honours BLENDER_PATH, then PATH, then the install folders, else null', () => {
  const only = paths => p => paths.includes(p);
  assert.equal(findBlender({ BLENDER_PATH: '/x/blender' }, only(['/x/blender'])), '/x/blender');
  assert.equal(findBlender({ PATH: '/opt/bin:/usr/bin' }, only(['/opt/bin/blender'])), '/opt/bin/blender');
  assert.equal(findBlender({ PATH: '' }, only(['/Applications/Blender.app/Contents/MacOS/Blender'])), '/Applications/Blender.app/Contents/MacOS/Blender');
  const windows = findBlender({ ProgramFiles: 'C:\\PF' }, p => p.includes('Blender 4.2'));
  assert.ok(windows?.includes('Blender Foundation') && windows.endsWith('blender.exe'), `found ${windows}`);
  assert.equal(findBlender({ PATH: '' }, () => false), null);
});

test('a job carries the camera in metres, the sun from the site latitude, and the quality preset', async () => {
  const scene = await new MockRevit().call('scene.info');
  const job = buildJob({ gltf: '/tmp/a.gltf', scene, camera: { eye: [47979, -22979, 3072], target: [15000, 10000, 4032] }, mood: 'golden_hour', quality: 'draft', width: 1280, output: '/tmp/o.png' });
  assert.deepEqual(job.camera.eye, [47.979, -22.979, 3.072]);
  assert.equal(job.width, 1280);
  assert.equal(job.height, 720);
  assert.equal(job.samples, QUALITY.draft.samples);
  assert.equal(job.sun.hour, 19);
  assert.ok(job.sun.elevation > 0 && job.sun.elevation < 25, `evening sun is low, got ${job.sun.elevation}`);
  assert.ok(job.sun.azimuth > 270 && job.sun.azimuth < 330, `evening sun is north-west in Dublin in June, got ${job.sun.azimuth}`);
  const overcast = buildJob({ gltf: 'g', scene, camera: { eye: [0, 0, 1], target: [1, 1, 1] }, mood: 'overcast', output: 'o' });
  assert.equal(overcast.overcast, true);
  assert.throws(() => buildJob({ gltf: 'g', scene, camera: { eye: [0, 0, 1], target: [1, 1, 1] }, quality: 'ludicrous', output: 'o' }), /Unknown quality/);
});

test('runBlender passes the job, reads the result line, and explains a failure', async () => {
  const fake = (code, text) => (exe, args) => {
    const handlers = {};
    const stream = { on: (e, f) => { if (e === 'data') handlers.data = f; } };
    const child = { stdout: stream, stderr: { on() {} }, on: (e, f) => { handlers[e] = f; }, kill() {} };
    child.args = args;
    fake.last = { exe, args };
    setTimeout(() => { handlers.data?.(text); handlers.close?.(code); }, 5);
    return child;
  };
  const ok = await runBlender({ exe: '/b', job: { x: 1 }, workDir: join(tmpdir(), 'revit-mcp-test'), spawnImpl: fake(0, 'noise\nREVITMCP_RESULT {"path":"/tmp/p.png","notes":["n"],"device":"CPU"}\n') });
  assert.equal(ok.path, '/tmp/p.png');
  assert.deepEqual(fake.last.args.slice(0, 3), ['-b', '--factory-startup', '--python']);
  assert.ok(existsSync(fake.last.args.at(-1)), 'the job file is written for Blender to read');
  assert.equal(JSON.parse(readFileSync(fake.last.args.at(-1), 'utf8')).x, 1);
  await assert.rejects(runBlender({ exe: '/b', job: {}, workDir: join(tmpdir(), 'revit-mcp-test'), spawnImpl: fake(1, 'Traceback: boom') }), /exited with code 1[\s\S]*boom/);
  assert.equal(await encodeMp4({ framesDir: '/nope', spawnImpl: () => ({ on: (e, f) => e === 'error' && setTimeout(() => f(new Error('ENOENT')), 1) }) }), null);
});

async function client(engine) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ bridge: new MockRevit(), allowWrites: true, engine });
  await server.connect(b);
  const c = new Client({ name: 'photoreal-test', version: '0.0.0' });
  await c.connect(a);
  return c;
}
const textOf = r => JSON.parse(r.content.find(x => x.type === 'text').text);

test('render_photoreal exports the geometry, hands Blender a job, and returns the image', async () => {
  let seen;
  const engine = {
    find: () => '/fake/blender',
    run: async ({ job }) => { seen = job; mkdirSync(dirname(job.output), { recursive: true }); writeFileSync(job.output, PNG); return { path: job.output, notes: [], device: 'CPU' }; },
    mp4: async () => null,
  };
  const c = await client(engine);
  try {
    const r = await c.callTool({ name: 'render_photoreal', arguments: { preset: 'exterior_ne', mood: 'golden_hour', quality: 'draft', hide_categories: ['Furniture'] } });
    assert.equal(Boolean(r.isError), false, JSON.stringify(r.content[0]));
    assert.equal(textOf(r).model_changed, false);
    assert.equal(textOf(r).quality, 'draft');
    assert.ok(r.content.some(x => x.type === 'image'), 'the picture comes back');
    assert.ok(seen.gltf.endsWith('.gltf') && existsSync(seen.gltf), 'Blender is given the exported glTF');
    assert.equal(seen.samples, QUALITY.draft.samples);
    assert.ok(seen.camera.eye[0] > 15 && seen.camera.eye[0] < 80, 'eye is in metres (the mock model is in mm)');
  } finally { await c.close(); }
});

test('without Blender the photoreal tools say how to get it instead of failing obscurely', async () => {
  const c = await client({ find: () => null, run: async () => { throw new Error('unreachable'); }, mp4: async () => null });
  try {
    for (const name of ['render_photoreal', 'render_turntable']) {
      const r = await c.callTool({ name, arguments: { preset: 'front' } });
      assert.equal(r.isError, true);
      assert.equal(textOf(r).code, 'blender_missing');
      assert.match(textOf(r).error, /BLENDER_PATH/);
    }
  } finally { await c.close(); }
});

test('render_turntable renders a frame sequence, reports the missing mp4 honestly, and shows the middle frame', async () => {
  let seen;
  const engine = {
    find: () => '/fake/blender',
    run: async ({ job }) => { seen = job; const mid = join(tmpdir(), 'revit-mcp-test', 'mid.png'); mkdirSync(join(tmpdir(), 'revit-mcp-test'), { recursive: true }); writeFileSync(mid, PNG); return { frames_dir: job.output, frames: job.turntable.frames, middle: mid, notes: [], device: 'CPU' }; },
    mp4: async () => null,
  };
  const c = await client(engine);
  try {
    const r = await c.callTool({ name: 'render_turntable', arguments: { frames: 24 } });
    assert.equal(Boolean(r.isError), false);
    assert.equal(seen.turntable.frames, 24);
    assert.equal(seen.samples, QUALITY.draft.samples, 'turntables default to draft');
    assert.equal(textOf(r).mp4, null);
    assert.match(textOf(r).mp4_note, /ffmpeg/);
    assert.ok(r.content.some(x => x.type === 'image'));
  } finally { await c.close(); }
});

test('export_model writes pdf, dwg, ifc and a structurally valid glTF', async () => {
  const c = await client();
  try {
    for (const format of ['pdf', 'dwg', 'ifc']) {
      const r = textOf(await c.callTool({ name: 'export_model', arguments: { format } }));
      assert.equal(r.format, format);
      assert.equal(r.model_changed, false);
      assert.ok(existsSync(r.files[0].path));
    }
    const g = textOf(await c.callTool({ name: 'export_model', arguments: { format: 'gltf', hide_categories: ['Furniture'] } }));
    const gltf = JSON.parse(readFileSync(g.extra.gltf, 'utf8'));
    assert.equal(gltf.asset.version, '2.0');
    const bin = readFileSync(join(g.folder, gltf.buffers[0].uri));
    assert.equal(bin.length, gltf.buffers[0].byteLength, 'buffer length matches the descriptor');
    assert.equal(gltf.accessors[0].count * 12, gltf.bufferViews[0].byteLength);
    assert.equal(gltf.accessors[1].count * 4, gltf.bufferViews[1].byteLength);
  } finally { await c.close(); }
});

test('the new model reads answer with the shapes the tools promise', async () => {
  const c = await client();
  try {
    const rooms = textOf(await c.callTool({ name: 'list_rooms', arguments: { level: 'L1', boundaries: true } }));
    assert.equal(rooms.total, 2);
    assert.equal(rooms.rows[0].boundaries[0].length, 4);
    for (const kind of ['grids', 'links', 'phases', 'design_options', 'worksets', 'revisions']) {
      assert.ok(textOf(await c.callTool({ name: 'project_structure', arguments: { kind } })).rows.length > 0, kind);
    }
    assert.equal(textOf(await c.callTool({ name: 'list_materials', arguments: { name: 'glass' } })).total, 1);
    const layers = textOf(await c.callTool({ name: 'wall_layers', arguments: { element_id: 100001 } }));
    assert.equal(layers.total_thickness, layers.layers.reduce((a, l) => a + l.thickness, 0));
    const bad = await c.callTool({ name: 'wall_layers', arguments: { element_id: 100043 } });
    assert.equal(bad.isError, true);
    assert.ok(textOf(await c.callTool({ name: 'geometry_quantities', arguments: { category: 'Walls' } })).totals.count > 0);
    assert.equal(textOf(await c.callTool({ name: 'check_clashes', arguments: { category_a: 'Walls', category_b: 'Doors' } })).clashes_found, 1);
    assert.equal((await c.callTool({ name: 'check_clashes', arguments: { category_a: 'Walls', category_b: 'Spaceships' } })).isError, true);
  } finally { await c.close(); }
});

test('create_schedule previews by default, reports unknown fields, applies only on request, and is blocked on a read-only server', async () => {
  const c = await client();
  try {
    const preview = textOf(await c.callTool({ name: 'create_schedule', arguments: { category: 'Doors', fields: ['Mark', 'fire rating', 'Nonsense'] } }));
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.preview.fields, ['Mark', 'Fire Rating']);
    assert.deepEqual(preview.preview.not_found, ['Nonsense']);
    const applied = textOf(await c.callTool({ name: 'create_schedule', arguments: { category: 'Doors', fields: ['Mark'], apply: true } }));
    assert.equal(applied.applied, true);
  } finally { await c.close(); }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer({ bridge: new MockRevit(), allowWrites: false }).connect(b);
  const ro = new Client({ name: 'ro', version: '0' });
  await ro.connect(a);
  try {
    const refused = await ro.callTool({ name: 'create_schedule', arguments: { category: 'Doors', fields: ['Mark'], apply: true } });
    assert.equal(refused.isError, true);
    assert.equal(textOf(refused).code, 'read_only_server');
  } finally { await ro.close(); }
});
