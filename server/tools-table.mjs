#!/usr/bin/env node
// Prints the menu tables for the README and docs/guide.md from the catalogues, so the documentation
// cannot drift from the code.
//   npm run tools:table
import { TOOLS } from './tools.mjs';
import { PROMPTS } from './prompts.mjs';
import { RESOURCES } from './resources.mjs';

const escape = s => s.replace(/\|/g, '\\|');
const only = process.argv.includes('--tools') ? 'tools' : process.argv.includes('--prompts') ? 'prompts' : process.argv.includes('--resources') ? 'resources' : 'all';

if (only === 'all' || only === 'tools') {
  console.log('## Tools\n');
  console.log('| Tool | What it does | Changes the model |');
  console.log('|---|---|---|');
  for (const tool of TOOLS) console.log(`| \`${tool.name}\` | ${escape(tool.description)} | ${tool.write ? '**yes** — preview by default' : 'no'} |`);
}

if (only === 'all' || only === 'prompts') {
  console.log('\n## Prompts\n');
  console.log('| Prompt | The workflow it writes out |');
  console.log('|---|---|');
  for (const prompt of PROMPTS) console.log(`| \`${prompt.name}\` | ${escape(prompt.description)} |`);
}

if (only === 'all' || only === 'resources') {
  console.log('\n## Resources\n');
  console.log('| Resource | What a client gets |');
  console.log('|---|---|');
  for (const resource of RESOURCES) console.log(`| \`${resource.uri}\` | ${escape(resource.description)} |`);
}
