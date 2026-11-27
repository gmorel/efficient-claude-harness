#!/usr/bin/env node
// Runs the tests of one plugin folder: node:test files with node, mod tests (*.test.ts, *.test.tsx) with `claude plugin test`.
// Usage: node scripts/run-plugin-tests.mjs plugins/<name>
// Exit: 0 all pass, 1 a test failed, 2 the plugin has no tests, 3 bad usage.

import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const dir = process.argv[2];
if (!dir || process.argv.length > 3 || !existsSync(dir)) { process.stderr.write('usage: run-plugin-tests.mjs plugins/<name>\n'); process.exit(3); }

const testsDir = path.join(dir, 'tests');
const files = existsSync(testsDir) ? readdirSync(testsDir) : [];
const nodeTests = files.filter(f => /\.test\.mjs$/.test(f)).map(f => path.join(testsDir, f));
const modTests = files.filter(f => /\.test\.tsx?$/.test(f));
if (!nodeTests.length && !modTests.length) { process.stderr.write(`${dir}: no tests found\n`); process.exit(2); }

let failed = false;
if (nodeTests.length) {
  console.log(`$ node --test ${nodeTests.join(' ')}`);
  failed ||= spawnSync(process.execPath, ['--test', ...nodeTests], { stdio: 'inherit' }).status !== 0;
}
if (modTests.length) {
  console.log(`$ claude plugin test ${dir}`);
  failed ||= spawnSync('claude', ['plugin', 'test', dir], { stdio: 'inherit' }).status !== 0;
}
process.exit(failed ? 1 : 0);
