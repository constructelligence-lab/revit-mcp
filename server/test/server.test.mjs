// End to end over stdio: a real MCP client, spawning a real server process, against the sample model and
// against a scripted fake add-in. This is the test that would catch the server failing to boot, a tool
// registered with a schema the SDK rejects, or the write gate leaking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

/** Connect a client to a freshly spawned server, and give back both so the test can close them. */
async function connect(args = [], env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, ...args], env: { ...process.env, ...env }, stderr: 'ignore' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** The JSON a tool answered with. */
async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content.filter(c => c.type === 'text').map(c => c.text).join('');
  return { json: JSON.parse(text), isError: Boolean(response.isError) };
}

test('the server lists the catalogue and reads the sample model without Revit', async () => {
  const { client, close } = await connect(['--mock']);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 14, `expected the catalogue, got ${tools.length} tools`);
    assert.ok(tools.some(t => t.name === 'revit_status'));
    assert.ok(tools.every(t => t.annotations?.readOnlyHint !== undefined), 'every tool declares whether it reads or writes');

    const status = await call(client, 'revit_status');
    assert.equal(status.isError, false);
    assert.equal(status.json.revit.document, 'Sample Tower.rvt');
    assert.equal(status.json.mock, true, 'mock results are labelled');

    const levels = await call(client, 'list_levels');
    assert.deepEqual(levels.json.levels.map(l => l.name), ['L1', 'L2', 'L3']);
    assert.ok(levels.json.levels.every(l => typeof l.elements === 'number'));

    const walls = await call(client, 'query_elements', { category: 'Walls', limit: 5 });
    assert.equal(walls.json.rows.length, 5);
    assert.equal(walls.json.total, 42);
    assert.ok(walls.json.rows[0].id > 100000);
  } finally {
    await close();
  }
});

test('a read-only server refuses set_parameter and says how to allow it', async () => {
  const { client, close } = await connect(['--mock']);
  try {
    const refused = await call(client, 'set_parameter', { element_id: 100001, parameter: 'Mark', value: 'W-999' });
    assert.equal(refused.isError, true);
    assert.equal(refused.json.code, 'read_only_server');
    assert.match(refused.json.error, /--allow-writes/);
  } finally {
    await close();
  }
});

test('with writes allowed, set_parameter previews first and applies only when asked', async () => {
  const { client, close } = await connect(['--mock', '--allow-writes']);
  try {
    const preview = await call(client, 'set_parameter', { element_id: 100001, parameter: 'Mark', value: 'W-999' });
    assert.equal(preview.isError, false);
    assert.equal(preview.json.applied, false);
    assert.equal(preview.json.new_value, 'W-999');
    assert.notEqual(preview.json.old_value, 'W-999');
    assert.match(preview.json.note, /preview/i);

    const applied = await call(client, 'set_parameter', { element_id: 100001, parameter: 'Mark', value: 'W-999', apply: true });
    assert.equal(applied.json.applied, true);

    const details = await call(client, 'element_details', { element_id: 100001 });
    assert.equal(details.json.element.parameters.Mark, 'W-999', 'the change landed on the element');
  } finally {
    await close();
  }
});

test('a bridge error reaches the client as an error result, with a hint', async () => {
  const { client, close } = await connect(['--mock']);
  try {
    const missing = await call(client, 'element_details', { element_id: 999999 });
    assert.equal(missing.isError, true);
    assert.match(missing.json.error, /No element with id 999999/);
  } finally {
    await close();
  }
});

test('against a scripted add-in, a tool call forwards the op and returns what Revit said', async () => {
  const seen = [];
  const addin = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { document: 'Live Model.rvt', warnings: 7 } }));
    });
  });
  await new Promise(resolve => addin.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${addin.address().port}`;

  const { client, close } = await connect(['--bridge', url]);
  try {
    const overview = await call(client, 'model_overview');
    assert.deepEqual(overview.json, { document: 'Live Model.rvt', warnings: 7 });
    assert.equal(seen[0].url, '/op');
    assert.deepEqual(seen[0].body, { op: 'model.overview', args: {} });
  } finally {
    await close();
    await new Promise(resolve => addin.close(resolve));
  }
});

test('with no add-in running, the error says so and points at the mock', async () => {
  const { client, close } = await connect(['--bridge', 'http://127.0.0.1:1']);
  try {
    const failed = await call(client, 'revit_status');
    assert.equal(failed.isError, true);
    assert.equal(failed.json.code, 'unreachable');
    assert.match(failed.json.hint, /--mock/);
  } finally {
    await close();
  }
});
