#!/usr/bin/env node
// Fails when the documented menus no longer match the catalogues. The README's tool/prompt/resource tables
// are generated between markers, so drift is a build failure rather than a wrong answer to a user.
//
//   npm run check:docs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const generated = execFileSync(process.execPath, [join(here, 'tools-table.mjs')], { encoding: 'utf8' }).trim();

const begin = '<!-- Generated from server/tools.mjs';
const end = '<!-- end menus -->';
const from = readme.indexOf(begin);
const to = readme.indexOf(end);
if (from === -1 || to === -1) {
  console.error('README.md is missing the generated menu block. Add:\n\n<!-- Generated from server/tools.mjs by `npm run tools:table` — do not edit by hand. -->\n...\n<!-- end menus -->');
  process.exit(1);
}

// Compare only the tables: the markers and the sentence above them may change.
const documented = readme.slice(from, to).split('\n').filter(line => line.startsWith('|')).map(l => l.trim()).join('\n');
const expected = generated.split('\n').filter(line => line.startsWith('|')).map(l => l.trim()).join('\n');

if (documented !== expected) {
  console.error('The menus in README.md are out of date. Run `npm run tools:table` and paste the output into the block.');
  const expectedLines = expected.split('\n');
  const actualLines = documented.split('\n');
  for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i++) {
    if (expectedLines[i] !== actualLines[i]) console.error(`first difference at line ${i + 1}:\n  README:    ${actualLines[i] ?? '(missing)'}\n  generated: ${expectedLines[i] ?? '(missing)'}`);
  }
  process.exit(1);
}
console.log('README menus match the catalogues.');
