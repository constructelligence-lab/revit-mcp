#!/usr/bin/env node
// Prints the tool table for README.md from the catalogue, so the docs cannot drift from the code.
//   npm run tools:table
import { TOOLS } from './tools.mjs';

const escape = s => s.replace(/\|/g, '\\|');
console.log('| Tool | What it does | Changes the model |');
console.log('|---|---|---|');
for (const tool of TOOLS) {
  console.log(`| \`${tool.name}\` | ${escape(tool.description)} | ${tool.write ? '**yes** — preview by default' : 'no'} |`);
}
