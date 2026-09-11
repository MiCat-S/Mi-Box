'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const createTpm = require(path.join(root, 'dist/v2/builtins/tpm.js')).default;

function harness(installed = [], pluginState = () => false, plugins = []) {
  const calls = [], edits = [], activated = [], removed = [];
  let reply = {ids: ['git_PR', 'nezha']};
  const host = {listPlugins: () => plugins, pluginState};
  const releases = {
    snapshot: () => ({generations: installed.map(id => ({id, state: 'active'}))}),
    remove: async id => {removed.push(id);},
    activate: async (id, revision) => {activated.push({id, revision});},
  };
  const ctx = {
    signal: new AbortController().signal,
    log: {error() {}, info() {}},
    telegram: {async edit(_m, text) {edits.push(text);}, async reply(_m, text) {edits.push(text);}},
    processes: {async run(_exe, argv) {calls.push(argv.slice(1)); return {stdout: Buffer.from(JSON.stringify(reply))};}},
  };
  const plugin = createTpm(host, releases, root, '123');
  const message = {id: 1, chatId: '123', senderId: '123', outgoing: true, text: '.tpm test'};
  return {
    run: args => plugin.commands.tpm.handle({message, args, command: 'tpm', prefix: '.'}, ctx),
    setReply: value => {reply = value;},
    calls, edits, activated, removed,
  };
}

test('tpm resolves a case-insensitive install to the declared id', async () => {
  const h = harness();
  h.setReply({id: 'git_PR', revision: 'b'.repeat(64)});
  await h.run(['install', 'git_pr']);
  assert.deepEqual(h.calls[0], ['build', 'git_pr']);
  assert.deepEqual(h.activated, [{id: 'git_PR', revision: 'b'.repeat(64)}]);
  assert.match(h.edits.at(-1), /git_PR/);
  assert.match(h.edits.at(-1), /安装完成/);
});

test('tpm removes an installed plugin through its declared id', async () => {
  const h = harness(['git_PR']);
  await h.run(['remove', 'git_pr']);
  assert.deepEqual(h.removed, ['git_PR']);
  assert.deepEqual(h.activated, []);
  assert.match(h.edits.at(-1), /卸载完成/);
});

test('tpm reports a missing plugin instead of inventing an uninstall', async () => {
  const h = harness();
  await h.run(['remove', 'git_pr']);
  assert.deepEqual(h.removed, []);
  assert.match(h.edits.at(-1), /未安装扩展/);
});

test('tpm refuses to replace a default module even with different casing', async () => {
  const h = harness([], id => id === 'help', [{id: 'help'}]);
  h.setReply({id: 'help', revision: 'c'.repeat(64)});
  await h.run(['install', 'HELP']);
  assert.deepEqual(h.calls, [], 'default modules must not reach the repository');
  assert.deepEqual(h.activated, []);
  assert.match(h.edits.at(-1), /默认模块/);
});

test('tpm protects an exact default module before any repository access', async () => {
  const h = harness([], id => id === 'help', [{id: 'help'}]);
  h.setReply(new Error('V2 plugin not available'));
  await h.run(['install', 'help']);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.activated, []);
  assert.match(h.edits.at(-1), /默认模块/);
});

test('tpm presents a repository ambiguity with declared ids', async () => {
  const h = harness();
  h.setReply({id: 'git_pr', error: 'AMBIGUOUS', ids: ['git_PR', 'GIT_pr']});
  await h.run(['install', 'git_pr']);
  assert.deepEqual(h.activated, []);
  assert.match(h.edits.at(-1), /大小写冲突/);
  assert.match(h.edits.at(-1), /git_PR/);
  assert.match(h.edits.at(-1), /GIT_pr/);
});

test('tpm presents a structured not-found without an access-failure hint', async () => {
  const h = harness();
  h.setReply({id: 'missing', error: 'NOT_FOUND'});
  await h.run(['install', 'missing']);
  assert.deepEqual(h.activated, []);
  assert.match(h.edits.at(-1), /不存在或不可用/);
  assert.doesNotMatch(h.edits.at(-1), /检查仓库访问/);
});

test('tpm search filters declared ids case-insensitively', async () => {
  const h = harness();
  h.setReply({ids: ['git_PR', 'nezha', 'ai', 'gt']});
  await h.run(['search', 'git']);
  const output = h.edits.join('\n');
  assert.match(output, /git_PR/);
  assert.doesNotMatch(output, /nezha/);
  assert.doesNotMatch(output, /· ai/);
});

test('tpm search and batch results surface case-fold collision groups accurately', async () => {
  const search = harness();
  search.setReply({ids: ['git_PR', 'GIT_pr', 'nezha'], collisions: [['GIT_pr', 'git_PR']]});
  await search.run(['search', 'git']);
  const searchOutput = search.edits.join('\n');
  assert.match(searchOutput, /仓库存在大小写冲突组/);
  assert.match(searchOutput, /精确单项仍可安装/);
  assert.match(searchOutput, /GIT_pr \/ git_PR/);
  assert.doesNotMatch(searchOutput, /本次已阻止/);

  const batch = harness();
  batch.setReply({ids: ['git_PR', 'GIT_pr'], collisions: [['GIT_pr', 'git_PR']], candidates: [
    {id: 'GIT_pr', error: 'AMBIGUOUS', ids: ['GIT_pr', 'git_PR']},
    {id: 'git_PR', error: 'AMBIGUOUS', ids: ['GIT_pr', 'git_PR']},
  ]});
  await batch.run(['install', 'all']);
  const batchOutput = batch.edits.join('\n');
  assert.match(batchOutput, /本次已阻止大小写冲突组/);
  assert.match(batchOutput, /GIT_pr \/ git_PR/);
  assert.deepEqual(batch.activated, []);
});

test('tpm reports a repository collision warning when a single exact member still updates', async () => {
  const h = harness(['git_PR']);
  h.setReply({ids: ['GIT_pr', 'git_PR'], collisions: [['GIT_pr', 'git_PR']],
    candidates: [{id: 'git_PR', revision: 'a'.repeat(64)}]});
  await h.run(['update', 'all']);
  assert.deepEqual(h.activated, [{id: 'git_PR', revision: 'a'.repeat(64)}]);
  const output = h.edits.join('\n');
  assert.match(output, /仓库存在大小写冲突组/);
  assert.match(output, /精确单项仍可安装/);
  assert.doesNotMatch(output, /本次已阻止/);
});

test('tpm reports a case collision instead of guessing an installed target', async () => {
  const h = harness(['git_PR', 'GIT_pr']);
  await h.run(['remove', 'git_pr']);
  assert.deepEqual(h.removed, []);
  assert.match(h.edits.at(-1), /大小写冲突/);
  assert.match(h.edits.at(-1), /git_PR/);
  assert.match(h.edits.at(-1), /GIT_pr/);
});

test('selected installation deduplicates aliases after repository resolution', async () => {
  const h = harness();
  h.setReply({ids: ['git_PR', 'nezha'], candidates: [{id: 'git_PR', revision: 'a'.repeat(64)}, {id: 'nezha', revision: 'a'.repeat(64)}]});
  await h.run(['install', 'git_pr', 'git_PR', 'nezha']);
  assert.deepEqual(h.calls, [['build-selected', 'git_pr', 'git_PR', 'nezha']]);
  assert.deepEqual(h.activated.map(item => item.id), ['git_PR', 'nezha']);
});

test('selected installation reports ambiguous names and processes independent plugins', async () => {
  const h = harness();
  h.setReply({ids: ['git_PR', 'GIT_pr', 'nezha'], candidates: [
    {id: 'git_pr', error: 'AMBIGUOUS', ids: ['GIT_pr', 'git_PR']}, {id: 'nezha', revision: 'a'.repeat(64)},
  ]});
  await h.run(['install', 'git_pr', 'nezha']);
  assert.deepEqual(h.activated.map(item => item.id), ['nezha']);
  assert.match(h.edits.at(-1), /AMBIGUOUS/);
});
