'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const builder = require('./build-v2-plugin.cjs');

function fixture(t, broken = new Set()) {
  const gitCalls = [], built = [];
  let stage;
  t.mock.method(child, 'spawnSync', (_command, args, options) => {
    const command = args.slice(2);
    gitCalls.push(command);
    if (command[0] === 'clone') stage = options.cwd;
    return {status: 0, stdout: command[0] === 'ls-tree'
      ? 'ai/v2.ts\nbad/v2.ts\ndig/v2.ts\nweather/v2.ts\noutdated/old/v2.ts\nlegacy/old.ts\n' : ''};
  });
  t.mock.method(builder, 'buildPlugin', ({id}) => {
    built.push(id);
    if (broken.has(id)) throw new Error('private-build-path');
    return {manifest: {revision: 'a'.repeat(64)}};
  });
  const modulePath = require.resolve('./plugin-repository.cjs');
  delete require.cache[modulePath];
  t.after(() => {delete require.cache[modulePath];});
  return {run: require(modulePath).run, gitCalls, built, cleaned: () => !fs.existsSync(stage)};
}

test('batch preparation uses one checkout, excludes loaded entries and isolates build failures', t => {
  const f = fixture(t, new Set(['bad']));
  const result = f.run('build-all', 'ai', 'dig');
  assert.deepEqual(result.ids, ['ai', 'bad', 'dig', 'weather']);
  assert.deepEqual(result.candidates, [{id: 'bad', error: 'BUILD'}, {id: 'weather', revision: 'a'.repeat(64)}]);
  assert.deepEqual(f.built, ['bad', 'weather']);
  assert.equal(f.gitCalls.filter(args => args[0] === 'clone').length, 1);
  assert.deepEqual(f.gitCalls.find(args => args[0] === 'sparse-checkout'),
    ['sparse-checkout', 'set', '--no-cone', '/bad/v2.ts', '/bad/v2/', '/weather/v2.ts', '/weather/v2/']);
  assert.equal(f.cleaned(), true);
  assert.doesNotMatch(JSON.stringify(result), /private-build-path/);
});

test('an already installed batch needs no checkout or builds', t => {
  const f = fixture(t);
  const result = f.run('build-all', 'ai', 'bad', 'dig', 'weather');
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(f.built, []);
  assert.equal(f.gitCalls.some(args => args[0] === 'checkout'), false);
  assert.equal(f.cleaned(), true);
});

test('single plugin build retains its response contract and cleans up after failure', t => {
  const f = fixture(t, new Set(['bad']));
  assert.deepEqual(f.run('build', 'dig'), {id: 'dig', revision: 'a'.repeat(64)});
  assert.throws(() => f.run('build', 'bad'), /private-build-path/);
  assert.equal(f.cleaned(), true);
  assert.throws(() => f.run('build-all', '../bad'), /Invalid plugin request/);
});
