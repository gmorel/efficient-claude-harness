#!/usr/bin/env node
// node --test tests/harness-config.test.mjs
//
// What matters here is not that the module parses JSON. It is that an agent and a runner can
// never disagree about which engine is available: both read this module, so a disabled engine
// must disappear from `pick` AND make `requireEngine` refuse, under the same inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'plugins', 'ech', 'scripts', 'lib', 'harness-config.mjs');

function cli(args, env = {}) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_CONFIG: '/nonexistent/harness.json', ...env },
  });
}

function cliFails(args, env = {}) {
  try {
    cli(args, env);
    return null;
  } catch (error) {
    return { status: error.status, stderr: String(error.stderr) };
  }
}

test('with nothing configured, the coder lane runs Composer', () => {
  assert.deepEqual(JSON.parse(cli(['pick', 'coder'])).engine, 'composer');
});

test('the guarded lane leads with the delegation service at opus/high', () => {
  const picked = JSON.parse(cli(['pick', 'guarded']));
  assert.equal(picked.engine, 'delegation');
  assert.equal(picked.model, 'opus');
  assert.equal(picked.effort, 'high');
});

test('switching Composer off falls to the delegation service on sonnet, not opus', () => {
  const picked = JSON.parse(cli(['pick', 'coder'], { HARNESS_ENGINE_COMPOSER: '0' }));
  assert.equal(picked.engine, 'delegation');
  assert.equal(picked.model, 'sonnet');
  assert.deepEqual(picked.skipped, ['composer']);
});

test('a lane with every engine off refuses instead of choosing one anyway', () => {
  const failed = cliFails(['pick', 'coder'], { HARNESS_ENGINE_COMPOSER: '0', HARNESS_ENGINE_DELEGATION: '0' });
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, /every engine for lane "coder" is switched off/);
});

test('a file switches an engine on, and the environment still overrides the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ engines: { codex: { enabled: true } } }));

  const fromFile = JSON.parse(cli(['show', '--json'], { HARNESS_CONFIG: path }));
  assert.equal(fromFile.engines.codex.enabled, true);
  assert.equal(fromFile.engines.composer.enabled, true, 'omitted engines keep their default');

  const overridden = JSON.parse(cli(['show', '--json'], { HARNESS_CONFIG: path, HARNESS_ENGINE_CODEX: '0' }));
  assert.equal(overridden.engines.codex.enabled, false);
});

test('a broken config file is an error, never a silent fall back to defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, '{ not json');
  const failed = cliFails(['show'], { HARNESS_CONFIG: path });
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /not valid JSON/);
});

test('HARNESS_MODEL_DELEGATION carries an effort through the @ notation', () => {
  const picked = JSON.parse(cli(['pick', 'coder'], {
    HARNESS_ENGINE_COMPOSER: '0',
    HARNESS_MODEL_DELEGATION: 'haiku@low',
  }));
  assert.equal(picked.model, 'haiku');
  assert.equal(picked.effort, 'low');
});
