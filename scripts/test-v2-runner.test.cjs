'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');

function fixture(t, {plugins = false, explicit = false, broken = false, failCore = false} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-test-runner-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'core');
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts, {recursive: true});
  fs.mkdirSync(path.join(root, 'dist/v2'), {recursive: true});
  fs.writeFileSync(path.join(root, 'dist/v2/core.test.js'), '');
  for (const name of ['test-v2.cjs', 'test-v2-paths.cjs']) {
    const source = path.join(__dirname, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(scripts, name));
  }
  const pluginRoot = path.join(base, explicit ? 'custom-plugins' : 'TeleBox-Plugins');
  if (plugins) {
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), {recursive: true});
    fs.writeFileSync(path.join(pluginRoot, 'scripts/example-v2.test.js'), '');
    if (!broken) fs.writeFileSync(path.join(pluginRoot, 'tsconfig.v2.json'), '{}');
  }
  const env = explicit ? {TELEBOX_PLUGINS_ROOT: pluginRoot} : {};
  const calls = [], warnings = [];
  const localRequire = createRequire(path.join(scripts, 'test-v2.cjs'));
  function load(name) {
    if (name === 'node:child_process') return {spawnSync: (_node, args, options) => {
      calls.push({args, options});
      return {status: failCore && args.includes('tsconfig.v2.json') ? 7 : 0};
    }};
    if (name === './test-v2-paths.cjs') {
      return {...localRequire(name), findPlugins: root => localRequire(name).findPlugins(root, env)};
    }
    return localRequire(name);
  }
  const run = () => vm.runInNewContext(fs.readFileSync(path.join(scripts, 'test-v2.cjs'), 'utf8'), {
    __dirname: scripts, require: load,
    console: {warn: text => warnings.push(text)},
    process: {execPath: process.execPath, argv: [process.execPath, path.join(scripts, 'test-v2.cjs')], env,
      exit: status => {throw new Error(`EXIT:${status}`);}},
  });
  return {run, calls, warnings, root, pluginRoot};
}

test('standalone checkout still compiles and executes Core tests with an explicit extension skip', t => {
  const f = fixture(t);
  f.run();
  assert.ok(f.calls.some(call => call.args.includes('tsconfig.v2.json')));
  assert.ok(f.calls.some(call => call.args.includes('--test') && call.args.some(arg => arg.endsWith('core.test.js'))));
  assert.equal(f.calls.some(call => call.args.some(arg => arg.startsWith(f.pluginRoot))), false);
  assert.ok(f.warnings.some(text => /跳过.*插件|skip.*extension/i.test(text)));
});

test('present plugin checkout includes its typecheck and tests', t => {
  const f = fixture(t, {plugins: true});
  f.run();
  assert.ok(f.calls.some(call => call.args.includes(path.join(f.pluginRoot, 'tsconfig.v2.json'))));
  assert.ok(f.calls.some(call => call.args.includes(path.join(f.pluginRoot, 'scripts/example-v2.test.js'))));
});

test('explicit plugin path is used by the runner and propagated to cross-repository tests', t => {
  const f = fixture(t, {plugins: true, explicit: true});
  f.run();
  const call = f.calls.find(call => call.args.includes(path.join(f.pluginRoot, 'scripts/example-v2.test.js')));
  assert.ok(call);
  assert.equal(call.options.env.TELEBOX_PLUGINS_ROOT, f.pluginRoot);
});

for (const options of [{explicit: true}, {plugins: true, broken: true}]) {
  test(`missing explicit or malformed checkout fails instead of silently skipping: ${JSON.stringify(options)}`, t => {
    const f = fixture(t, options);
    assert.throws(f.run);
  });
}

test('standalone Core typecheck failure remains a failing exit', t => {
  const f = fixture(t, {failCore: true});
  assert.throws(f.run, /EXIT:7/);
});
