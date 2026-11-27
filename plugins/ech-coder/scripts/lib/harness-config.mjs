#!/usr/bin/env node
// Which engines a developer allows this harness to use, and with which model.
//
// Three layers, lowest first: the defaults below, then ~/.config/claude-harness/config.json,
// then environment variables. Env wins so CI and a one-off run can override without editing a
// file; the file wins over defaults so a developer's choice survives a plugin update.
//
// The agents are markdown and cannot read any of this. They call `show --json` and use what it
// says, and the runners refuse with exit 3 when asked for an engine that is switched off. Both
// paths read this one module, so an agent can never believe an engine is available while the
// runner refuses it.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_PATH =
  process.env.HARNESS_CONFIG || join(homedir(), '.config/claude-harness/config.json');

// `model` is the engine's own notation: composer takes composer-2.5, the delegation service
// takes a Claude alias plus an effort, codex takes codex@<effort>.
const DEFAULTS = {
  engines: {
    composer:   { enabled: true,  model: 'composer-2.5' },
    delegation: { enabled: true,  model: 'sonnet', effort: 'medium' },
    codex:      { enabled: false, model: 'codex@medium' },
    astra:      { enabled: false },
  },
  // Ordinary coding. Composer first because it works in place against the live repository;
  // the delegation service next because it keeps the files out of the caller's context.
  lanes: {
    coder:   { order: ['composer', 'delegation', 'codex'] },
    // Guarded paths — migrations, auth, payments, secrets, CI, git hooks. The delegation
    // service leads, and it runs opus at high effort: effort pays in proportion to how many
    // edge cases hide in a task, and this lane is defined by exactly that.
    guarded: { order: ['delegation', 'composer'], model: 'opus', effort: 'high' },
  },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  if (!isObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function falsy(v) {
  return /^(0|false|no|off)$/i.test(String(v).trim());
}

/** HARNESS_ENGINE_<NAME>=0|1 and HARNESS_MODEL_<NAME>=<model[@effort]> override the file. */
function fromEnv(config) {
  const out = merge(config, {});
  for (const name of Object.keys(out.engines)) {
    const on = process.env[`HARNESS_ENGINE_${name.toUpperCase()}`];
    if (on !== undefined) {
      if (truthy(on)) out.engines[name] = { ...out.engines[name], enabled: true };
      else if (falsy(on)) out.engines[name] = { ...out.engines[name], enabled: false };
    }
    const model = process.env[`HARNESS_MODEL_${name.toUpperCase()}`];
    if (model) {
      const [m, effort] = model.split('@');
      out.engines[name] = { ...out.engines[name], model: effort ? model : m };
      if (effort && name === 'delegation') out.engines[name] = { ...out.engines[name], model: m, effort };
    }
  }
  return out;
}

export function load() {
  let fileConfig = {};
  let source = 'defaults';
  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      source = CONFIG_PATH;
    } catch (error) {
      // A broken config must not silently fall back to defaults the developer did not choose.
      throw new Error(`${CONFIG_PATH} is not valid JSON: ${error.message}`);
    }
  }
  const config = fromEnv(merge(DEFAULTS, fileConfig));
  config.source = source;
  return config;
}

export function isEnabled(name, config = load()) {
  return config.engines[name]?.enabled === true;
}

/**
 * The first enabled engine for a lane, with the model to run it with.
 * Returns null when the developer has switched every engine in the lane off.
 */
export function pick(lane, config = load()) {
  const spec = config.lanes[lane];
  if (!spec) throw new Error(`Unknown lane ${lane}. Known: ${Object.keys(config.lanes).join(', ')}`);
  for (const name of spec.order) {
    const engine = config.engines[name];
    if (engine?.enabled !== true) continue;
    return {
      engine: name,
      model: spec.model ?? engine.model,
      effort: spec.effort ?? engine.effort ?? null,
      skipped: spec.order.slice(0, spec.order.indexOf(name)),
    };
  }
  return null;
}

/** Exit 3 from a runner that was asked for an engine the developer switched off. */
export function requireEngine(name, config = load()) {
  if (isEnabled(name, config)) return config.engines[name];
  const on = Object.entries(config.engines).filter(([, e]) => e.enabled).map(([n]) => n);
  console.error(
    `harness: the "${name}" engine is switched off in ${config.source}.\n` +
    `         Enabled: ${on.length ? on.join(', ') : '(none)'}\n` +
    `         Turn it on there, or set HARNESS_ENGINE_${name.toUpperCase()}=1 for one run.`,
  );
  process.exit(3);
}

// ---- CLI --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd = 'show', ...rest] = process.argv.slice(2);
  let config;
  try {
    config = load();
  } catch (error) {
    console.error(`harness: ${error.message}`);
    process.exit(2);
  }

  if (cmd === 'show') {
    if (rest.includes('--json')) {
      console.log(JSON.stringify({ source: config.source, engines: config.engines, lanes: config.lanes }, null, 2));
    } else {
      console.log(`config: ${config.source}`);
      for (const [name, e] of Object.entries(config.engines)) {
        const model = e.model ? `${e.model}${e.effort ? '@' + e.effort : ''}` : '-';
        console.log(` ${e.enabled ? 'on ' : 'OFF'}  ${name.padEnd(11)} ${model}`);
      }
      for (const lane of Object.keys(config.lanes)) {
        const chosen = pick(lane, config);
        console.log(` lane ${lane.padEnd(8)} -> ${chosen ? `${chosen.engine} ${chosen.model}${chosen.effort ? '@' + chosen.effort : ''}` : 'NO ENGINE ENABLED'}`);
      }
    }
    process.exit(0);
  }

  if (cmd === 'pick') {
    const lane = rest[0];
    if (!lane) { console.error('usage: harness-config.mjs pick <lane>'); process.exit(2); }
    const chosen = pick(lane, config);
    if (!chosen) {
      console.error(`harness: every engine for lane "${lane}" is switched off in ${config.source}.`);
      process.exit(3);
    }
    console.log(JSON.stringify(chosen));
    process.exit(0);
  }

  console.error('usage: harness-config.mjs show [--json] | pick <lane>');
  process.exit(2);
}
