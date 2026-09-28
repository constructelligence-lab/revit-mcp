// The prompt and resource menus: prompts are the workflows (text, no Revit needed), resources are live
// reads of the open model. Both are part of what a client sees, so both are tested like the tools are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PROMPTS } from '../prompts.mjs';
import { RESOURCES } from '../resources.mjs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

async function connect(args = []) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, ...args], env: { ...process.env }, stderr: 'ignore' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

test('the prompt catalogue is complete and named like a tool', () => {
  const names = new Set();
  for (const prompt of PROMPTS) {
    assert.match(prompt.name, /^[a-z][a-z0-9_]*$/, `${prompt.name} is not snake_case`);
    assert.ok(!names.has(prompt.name), `duplicate prompt ${prompt.name}`);
    names.add(prompt.name);
    assert.ok(prompt.description?.length > 40, `${prompt.name} needs a real description`);
    assert.equal(typeof prompt.build, 'function', `${prompt.name} needs a body`);
  }
  assert.ok(PROMPTS.length >= 4, 'the workflows people actually run should be here');
});

test('every prompt tells the model to read before it writes, and to say what it read', () => {
  for (const prompt of PROMPTS) {
    const text = prompt.build({});
    assert.match(text, /revit_status|list_|model_overview|query_elements|sheets\.list|list_schedules/, `${prompt.name} must name the reads it needs`);
    if (/set_parameter/.test(text)) assert.match(text, /confirm|preview|say what will change/i, `${prompt.name} writes: it must ask first`);
  }
});

test('a client sees the prompts with their arguments', async () => {
  const { client, close } = await connect(['--mock']);
  try {
    const { prompts } = await client.listPrompts();
    const names = prompts.map(p => p.name);
    assert.ok(names.includes('model_health_check'));
    assert.ok(names.includes('parameter_audit'));
    const audit = prompts.find(p => p.name === 'parameter_audit');
    assert.ok(audit.arguments.some(a => a.name === 'category'));

    const { messages } = await client.getPrompt({ name: 'model_health_check', arguments: { level: 'L2' } });
    const text = messages.map(m => m.content.text).join('\n');
    assert.match(text, /L2/, 'the argument reaches the prompt');
    assert.match(text, /revit_status/);

    const defaults = await client.getPrompt({ name: 'parameter_audit', arguments: {} });
    const defaultText = defaults.messages.map(m => m.content.text).join('\n');
    assert.match(defaultText, /Doors/);
    assert.match(defaultText, /Mark/);
  } finally {
    await close();
  }
});

test('resources are listed and read live from the model', async () => {
  const { client, close } = await connect(['--mock']);
  try {
    const { resources } = await client.listResources();
    const uris = resources.map(r => r.uri);
    assert.ok(uris.includes('revit://status'));
    assert.ok(uris.includes('revit://warnings'));

    const status = await client.readResource({ uri: 'revit://status' });
    const parsed = JSON.parse(status.contents[0].text);
    assert.equal(parsed.revit.document, 'Sample Tower.rvt');
    assert.equal(parsed.mock, true);

    const warnings = await client.readResource({ uri: 'revit://warnings' });
    assert.ok(JSON.parse(warnings.contents[0].text).warnings.length >= 3);
  } finally {
    await close();
  }
});

test('resources are the same reads the tools do — no second source of truth', () => {
  const ops = new Set(RESOURCES.map(r => r.op));
  for (const op of ops) assert.match(op, /^[a-z][a-z0-9_.]*$/, `${op} is not an op name`);
  assert.equal(ops.size, RESOURCES.length, 'each resource should read a distinct op');
});
