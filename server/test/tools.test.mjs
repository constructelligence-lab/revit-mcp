// The catalogue's own invariants: names, schemas, and which tools may change the model. These are the
// tests that catch a copy-paste when a tool is added — a duplicate op, a missing description, a write
// tool without a preview switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, WRITE_TOOLS, schemaFor } from '../tools.mjs';

test('every tool is fully described and named like an MCP tool', () => {
  const names = new Set();
  for (const tool of TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} is not snake_case`);
    assert.ok(!names.has(tool.name), `duplicate tool ${tool.name}`);
    names.add(tool.name);
    assert.ok(tool.title?.length > 2, `${tool.name} needs a title`);
    assert.ok(tool.description?.length > 40, `${tool.name} needs a real description`);
    assert.match(tool.op, /^[a-z][a-z0-9_.]*$/, `${tool.name} has a malformed op`);
    assert.equal(typeof tool.write, 'boolean', `${tool.name} must say whether it writes`);
    assert.equal(schemaFor(tool), tool.params);
  }
  const ops = new Set();
  for (const tool of TOOLS) {
    assert.ok(!ops.has(tool.op), `two tools share op ${tool.op}`);
    ops.add(tool.op);
  }
});

test('the only tools that change the model are set_parameter and create_schedule, and both preview by default', () => {
  assert.deepEqual(WRITE_TOOLS.map(t => t.name).sort(), ['create_schedule', 'set_parameter']);
  for (const tool of WRITE_TOOLS) {
    assert.ok('apply' in tool.params, `${tool.name} must take an apply flag`);
    // The description has to tell the model that the default is a preview, or an agent will assume a change.
    assert.match(tool.description, /preview/i, `${tool.name} must say it previews`);
  }
});

test('query_elements demands a category and rejects a paging abuse', () => {
  const schema = TOOLS.find(t => t.name === 'query_elements').params;
  assert.throws(() => schema.category.parse(undefined));
  assert.throws(() => schema.limit.parse(5000));
  assert.equal(schema.limit.parse(100), 100);
});

test('element ids are validated as positive integers', () => {
  for (const name of ['element_details', 'set_parameter']) {
    const schema = TOOLS.find(t => t.name === name).params;
    assert.throws(() => schema.element_id.parse(0));
    assert.throws(() => schema.element_id.parse('100123'));
    assert.equal(schema.element_id.parse(100123), 100123);
  }
});
