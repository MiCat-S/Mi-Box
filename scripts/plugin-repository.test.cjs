'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const builder = require('./build-v2-plugin.cjs');

function fixture(t, broken = new Set(), extra = '', index = '{}') {
  const gitCalls = [], built = [];
  let stage;
  t.mock.method(child, 'spawnSync', (_command, args, options) => {
    const command = args.slice(2);
    gitCalls.push(command);
    if (command[0] === 'clone') stage = options.cwd;
    if (command[0] === 'show') return {status: index === null ? 1 : 0, stdout: index ?? ''};
    return {status: 0, stdout: command[0] === 'ls-tree'
      ? 'ai/v2.ts\nbad/v2.ts\ndig/v2.ts\nweather/v2.ts\noutdated/old/v2.ts\nlegacy/old.ts\n' + extra : ''};
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

test('search reads descriptions from the same HEAD and keeps only actual V2 entries', t => {
  const f = fixture(t, new Set(), 'git_PR/v2.ts\nconstructor/v2.ts\n', JSON.stringify({
    dig: {desc: ' DNS\n记录查询 ', url: 'legacy/dig.ts'},
    git_PR: {desc: 'GitHub 拉取请求'}, legacy: {desc: 'legacy-only'},
    weather: {desc: 12}, bad: {},
  }));
  const result = f.run('search');
  assert.deepEqual({...result.descriptions}, {dig: 'DNS 记录查询', git_PR: 'GitHub 拉取请求'});
  assert.equal(result.descriptionsAvailable, true);
  assert.ok(result.ids.includes('weather'));
  assert.ok(result.ids.includes('constructor'));
  assert.ok(!result.ids.includes('legacy'));
  assert.deepEqual(f.gitCalls.filter(args => ['show', 'clone'].includes(args[0])).map(args => args[0]), ['clone', 'show']);
  assert.deepEqual(f.gitCalls.find(args => args[0] === 'show'), ['show', 'HEAD:plugins.json']);
  assert.equal(f.gitCalls.some(args => ['checkout', 'sparse-checkout'].includes(args[0])), false);
  assert.deepEqual(f.built, []);
  assert.equal(f.cleaned(), true);
});

for (const index of [null, '{broken', '[]', 'null', '12']) {
  test(`search preserves names and reports unavailable description index: ${index}`, t => {
    const f = fixture(t, new Set(), '', index);
    const result = f.run('search');
    assert.deepEqual(result.ids, ['ai', 'bad', 'dig', 'weather']);
    assert.equal(result.descriptionsAvailable, false);
    assert.deepEqual(Object.keys(result.descriptions), []);
    assert.equal(f.cleaned(), true);
  });
}

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

test('selected batch builds installed targets once and reports missing entries individually', t => {
  const f = fixture(t, new Set(['bad']));
  const result = f.run('build-selected', 'dig', 'absent', 'bad', 'dig');
  assert.deepEqual(f.built, ['dig', 'bad']);
  assert.deepEqual(result.candidates, [
    {id: 'dig', revision: 'a'.repeat(64)}, {id: 'bad', error: 'BUILD'}, {id: 'absent', error: 'NOT_FOUND'},
  ]);
  assert.equal(f.gitCalls.filter(args => args[0] === 'clone').length, 1);
  assert.deepEqual(f.gitCalls.find(args => args[0] === 'sparse-checkout'),
    ['sparse-checkout', 'set', '--no-cone', '/dig/v2.ts', '/dig/v2/', '/bad/v2.ts', '/bad/v2/']);
  assert.equal(f.cleaned(), true);
});

test('unavailable selected batch reports all targets without checking out source', t => {
  const f = fixture(t);
  assert.deepEqual(f.run('build-selected', 'absent').candidates, [{id: 'absent', error: 'NOT_FOUND'}]);
  assert.equal(f.gitCalls.some(args => args[0] === 'checkout'), false);
  assert.deepEqual(f.built, []);
  assert.equal(f.cleaned(), true);
  assert.throws(() => f.run('build-selected', '../bad'), /Invalid plugin request/);
});

test('declared ids may contain upper case and resolve case-insensitively', t => {
  const f = fixture(t, new Set(), 'git_PR/v2.ts\n');
  assert.ok(f.run('search').ids.includes('git_PR'));
  assert.deepEqual(f.run('search').collisions, []);
  assert.deepEqual(f.run('build', 'git_pr'), {id: 'git_PR', revision: 'a'.repeat(64)});
  assert.deepEqual(f.run('build', 'missing'), {id: 'missing', error: 'NOT_FOUND'});
  assert.deepEqual(f.built, ['git_PR']);
  assert.deepEqual(f.gitCalls.find(args => args[0] === 'sparse-checkout'),
    ['sparse-checkout', 'set', '--no-cone', '/git_PR/v2.ts', '/git_PR/v2/']);
  assert.equal(f.cleaned(), true);
});

test('repository, builder and SDK share one declared id pattern', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const pattern = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
  for (const file of ['scripts/plugin-repository.cjs', 'scripts/build-v2-plugin.cjs', 'src/v2/plugin-id.ts']) {
    assert.ok(read(file).includes(pattern), `${file} must use the shared id pattern`);
  }
});

test('case collisions are reported with declared ids and exact matches still build', t => {
  const f = fixture(t, new Set(), 'git_PR/v2.ts\nGIT_pr/v2.ts\n');
  assert.deepEqual(f.run('search').collisions, [['GIT_pr', 'git_PR']]);
  assert.deepEqual(f.run('build', 'git_pr'), {id: 'git_pr', error: 'AMBIGUOUS', ids: ['GIT_pr', 'git_PR']});
  assert.deepEqual(f.built, []);
  assert.deepEqual(f.run('build', 'git_PR'), {id: 'git_PR', revision: 'a'.repeat(64)});
  assert.deepEqual(f.built, ['git_PR']);
  assert.equal(f.cleaned(), true);
});

test('batch builds isolate case-fold collision groups instead of sharing a checkout', t => {
  const f = fixture(t, new Set(), 'git_PR/v2.ts\nGIT_pr/v2.ts\n');
  const result = f.run('build-all');
  assert.deepEqual(result.candidates.filter(item => item.error === 'AMBIGUOUS'), [
    {id: 'GIT_pr', error: 'AMBIGUOUS', ids: ['GIT_pr', 'git_PR']},
    {id: 'git_PR', error: 'AMBIGUOUS', ids: ['GIT_pr', 'git_PR']},
  ]);
  assert.deepEqual(result.candidates.filter(item => item.revision).map(item => item.id).sort(), ['ai', 'bad', 'dig', 'weather']);
  const sparse = f.gitCalls.find(args => args[0] === 'sparse-checkout');
  assert.ok(sparse.every(value => !value.includes('GIT_pr') && !value.includes('git_PR')), 'collision paths must not be checked out');
  assert.equal(f.cleaned(), true);
});

test('selected batch builds a single exact collision member but blocks two spellings together', t => {
  const f = fixture(t, new Set(), 'git_PR/v2.ts\nGIT_pr/v2.ts\n');
  assert.deepEqual(f.run('build-selected', 'git_PR'), {ids: ['GIT_pr', 'ai', 'bad', 'dig', 'git_PR', 'weather'],
    collisions: [['GIT_pr', 'git_PR']], candidates: [{id: 'git_PR', revision: 'a'.repeat(64)}]});
  assert.deepEqual(f.built, ['git_PR']);
  assert.deepEqual(f.run('build-selected', 'git_PR', 'GIT_pr'), {ids: ['GIT_pr', 'ai', 'bad', 'dig', 'git_PR', 'weather'],
    collisions: [['GIT_pr', 'git_PR']], candidates: [
      {id: 'git_PR', error: 'AMBIGUOUS', ids: ['GIT_pr', 'git_PR']},
      {id: 'GIT_pr', error: 'AMBIGUOUS', ids: ['GIT_pr', 'git_PR']},
    ]});
  assert.deepEqual(f.built, ['git_PR']);
  assert.equal(f.cleaned(), true);
});
