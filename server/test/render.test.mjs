// The picture tools: camera planning is plain maths, so it is tested exactly; the tools are tested end to end
// over stdio against the mock, including that an image actually comes back to the client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PRESETS, MOODS, planCamera, buildRenderArgs, unitsPerMetre } from '../camera.mjs';
import { MockRevit } from '../mock.mjs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const scene = new MockRevit().call('scene.info');

test('unit ids map to metres', () => {
  assert.equal(unitsPerMetre('autodesk.unit.unit:millimeters-1.0.1'), 1000);
  assert.equal(unitsPerMetre('autodesk.unit.unit:meters-1.0.1'), 1);
  assert.ok(Math.abs(unitsPerMetre('autodesk.unit.unit:feetFractionalInches-1.0.1') - 3.2808) < 0.01);
});

test('every preset plans a camera that looks at the building from outside or inside it', async () => {
  const s = await scene;
  const centre = [15000, 10000];
  for (const preset of PRESETS) {
    const cam = planCamera(s, { preset });
    assert.equal(cam.eye.length, 3);
    assert.equal(cam.target.length, 3);
    assert.ok(cam.eye.every(Number.isFinite) && cam.target.every(Number.isFinite), preset);
    assert.notDeepEqual(cam.eye, cam.target, `${preset}: eye and target must differ`);
    if (preset !== 'interior' && preset !== 'top') {
      const outside = Math.hypot(cam.eye[0] - centre[0], cam.eye[1] - centre[1]) > 20000;
      assert.ok(outside, `${preset} should stand outside the 30 x 20 m footprint`);
    }
  }
});

test('corner presets sit on the right diagonal, aerials look down, the top view is orthographic', async () => {
  const s = await scene;
  const ne = planCamera(s, { preset: 'exterior_ne' });
  assert.ok(ne.eye[0] > 15000 && ne.eye[1] > 10000);
  const sw = planCamera(s, { preset: 'exterior_sw' });
  assert.ok(sw.eye[0] < 15000 && sw.eye[1] < 10000);
  const aerial = planCamera(s, { preset: 'aerial_se' });
  assert.ok(aerial.eye[2] > 10800, 'an aerial is above the roof');
  assert.equal(planCamera(s, { preset: 'top' }).perspective, false);
});

test('an interior stands at eye height in the named room, and says why when it cannot', async () => {
  const s = await scene;
  const cam = planCamera(s, { preset: 'interior', room: 'Meeting', look: 'east' });
  assert.equal(cam.room.name, 'Meeting');
  assert.equal(cam.eye[2], 1500);
  assert.ok(cam.target[0] > cam.eye[0], 'looking east');
  assert.equal(planCamera(s, { preset: 'interior' }).room.number, '101', 'defaults to the largest room');
  assert.throws(() => planCamera(s, { preset: 'interior', room: 'Boiler house' }), /No room matches/);
  assert.throws(() => planCamera({ ...s, rooms: [] }, { preset: 'interior' }), /no placed rooms/);
  assert.throws(() => planCamera({ ...s, bounds: null }, { preset: 'front' }), /no bounds/);
  assert.throws(() => planCamera(s, { preset: 'sideways' }), /Unknown preset/);
});

test('upper-level rooms stand on their own floor', async () => {
  const s = await scene;
  const cam = planCamera(s, { preset: 'interior', room: '201' });
  assert.equal(cam.eye[2], 3600 + 1500);
});

test('mood and explicit sun combine, and the explicit sun wins', async () => {
  const s = await scene;
  const { args } = buildRenderArgs(s, { preset: 'front', mood: 'golden_hour', sun: { hour: 20 }, style: 'realistic', hide_categories: ['Furniture'] });
  assert.equal(args.sun.hour, 20);
  assert.equal(args.sun.month, MOODS.golden_hour.sun.month);
  assert.equal(args.background, 'few_clouds');
  assert.deepEqual(args.hide_categories, ['Furniture']);
  assert.throws(() => buildRenderArgs(s, { preset: 'front', mood: 'noir' }), /Unknown mood/);
  assert.throws(() => buildRenderArgs(s, {}), /preset .* or both eye and target/);
});

async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, '--mock'], env: { ...process.env }, stderr: 'ignore' });
  const client = new Client({ name: 'render-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

test('render_scene returns the camera it chose and the image itself', async () => {
  const client = await connect();
  try {
    const response = await client.callTool({ name: 'render_scene', arguments: { preset: 'exterior_ne', mood: 'golden_hour', outlines: true } });
    assert.equal(Boolean(response.isError), false);
    const text = JSON.parse(response.content.find(c => c.type === 'text').text);
    assert.equal(text.model_changed, false);
    assert.equal(text.sun.hour, 19);
    assert.equal(text.background, 'few_clouds');
    const image = response.content.find(c => c.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG');
  } finally {
    await client.close();
  }
});

test('render_scene takes an explicit camera and refuses a degenerate one with a reason', async () => {
  const client = await connect();
  try {
    const ok = await client.callTool({ name: 'render_scene', arguments: { eye: [40000, -20000, 2000], target: [15000, 10000, 4000], style: 'shaded' } });
    assert.equal(Boolean(ok.isError), false);
    const bad = await client.callTool({ name: 'render_scene', arguments: { eye: [1, 2, 3], target: [1, 2, 3] } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /same point/);
    const noCamera = await client.callTool({ name: 'render_scene', arguments: {} });
    assert.equal(noCamera.isError, true);
    assert.match(noCamera.content[0].text, /preset/);
  } finally {
    await client.close();
  }
});

test('render_gallery takes the default four corners, and a failed shot does not sink the rest', async () => {
  const client = await connect();
  try {
    const four = await client.callTool({ name: 'render_gallery', arguments: {} });
    const shots = JSON.parse(four.content.find(c => c.type === 'text').text).shots;
    assert.deepEqual(shots.map(s => s.preset), ['exterior_ne', 'exterior_nw', 'exterior_se', 'exterior_sw']);
    assert.equal(four.content.filter(c => c.type === 'image').length, 4);

    const mixed = await client.callTool({ name: 'render_gallery', arguments: { presets: ['front', 'interior'], mood: 'day' } });
    const result = JSON.parse(mixed.content.find(c => c.type === 'text').text).shots;
    assert.equal(result.length, 2);
    assert.ok(result[0].path && !result[0].error);
    assert.ok(result[1].path, 'the mock model has rooms, so the interior works too');
  } finally {
    await client.close();
  }
});

test('scene_info and export_view_image: the first is data, the second also hands back the picture', async () => {
  const client = await connect();
  try {
    const info = await client.callTool({ name: 'scene_info', arguments: {} });
    const json = JSON.parse(info.content[0].text);
    assert.equal(json.bounds.max[2], 10800);
    assert.ok(json.site.latitude);
    // The mock's export writes no file, so the server must degrade to the path rather than fail.
    const exported = await client.callTool({ name: 'export_view_image', arguments: {} });
    assert.equal(Boolean(exported.isError), false);
    assert.ok(JSON.parse(exported.content[0].text).path);
  } finally {
    await client.close();
  }
});

test('the render tools never claim to change the model, and the gallery is capped', async () => {
  const { TOOLS } = await import('../tools.mjs');
  for (const name of ['scene_info', 'render_scene', 'render_gallery']) assert.equal(TOOLS.find(t => t.name === name).write, false);
  assert.throws(() => TOOLS.find(t => t.name === 'render_gallery').params.presets.parse(PRESETS.slice(0, 7)));
});
