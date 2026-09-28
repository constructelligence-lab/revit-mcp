#!/usr/bin/env node
// A worked transcript against the sample model, over the real MCP protocol: this is what a client sees.
//
//   npm run demo            # pretty printed for a person
//   npm run demo -- --json  # the raw result of each call, for pasting into a document
//
// It starts the server exactly as a client would (stdio, --mock), so what is printed here is what the
// tests assert and what a real session returns — not a mock-up of one.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const raw = process.argv.includes('--json');
const server = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const transport = new StdioClientTransport({ command: process.execPath, args: [server, '--mock'], env: { ...process.env }, stderr: 'ignore' });
const client = new Client({ name: 'revit-mcp-demo', version: '0.1.0' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content.filter(c => c.type === 'text').map(c => c.text).join('');
  const value = JSON.parse(text);
  if (raw) {
    console.log(`\n### ${name}${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}\n`);
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(`\n${name}${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}`);
    console.log('-'.repeat(60));
    console.log(JSON.stringify(value, null, 2));
  }
  return value;
};

if (!raw) {
  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts();
  const { resources } = await client.listResources();
  console.log(`revit-mcp demo — sample model, no Revit required\n`);
  console.log(`tools (${tools.length}):     ${tools.map(t => t.name).join(', ')}`);
  console.log(`prompts (${prompts.length}):   ${prompts.map(p => p.name).join(', ')}`);
  console.log(`resources (${resources.length}): ${resources.map(r => r.uri).join(', ')}`);
}

await call('revit_status');
await call('model_overview');
await call('list_levels');
await call('query_elements', { category: 'Doors', parameter: 'Fire Rating', value: '90', limit: 3 });
await call('element_details', { element_id: 100043 });
await call('read_schedule', { schedule: 'Door Schedule' });
await call('model_warnings');
await call('set_parameter', { element_id: 100043, parameter: 'Mark', value: 'D-999' });

if (!raw) console.log('\n(set_parameter with no apply: previewed, nothing changed — the server is read-only in this demo)');
await client.close();
