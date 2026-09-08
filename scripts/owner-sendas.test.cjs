'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {Api} = require('teleproto');
const {messageEnvelope} = require('../dist/v2/telegram.js');
const {buildPlugin} = require('./build-v2-plugin.cjs');
const root = path.resolve(__dirname, '..');
const {artifactDir} = buildPlugin({id: 'sure', packageRoot: path.resolve(root, '../TeleBox-Plugins/sure'), entry: 'v2.ts'});
const factories = {
  exec: () => require('../dist/v2/builtins/exec.js').default(),
  bf: () => require('../dist/v2/builtins/bf.js').default(root),
  sudo: () => require('../dist/v2/builtins/sudo.js').default(),
  privacy: () => require('../dist/v2/builtins/privacy.js').default('123'),
  help: () => require('../dist/v2/builtins/help.js').createHelp({}, '123'),
  sure: () => require(path.join(artifactDir, 'index.cjs')).default(),
};
const args = {exec: ['/bin/echo', 'ok'], bf: [], sudo: ['add', '456'], privacy: ['ip', 'hide'], help: ['name', 'Channel Bot'], sure: ['user', 'add', '456']};
function envelope() {
  return messageEnvelope(new Api.Message({id: 7, peerId: new Api.PeerChannel({channelId: 456n}),
    fromId: new Api.PeerChannel({channelId: 789n}), out: true, date: 1, message: '.test'}));
}
for (const id of Object.keys(factories)) test(`${id} authorizes owner group send-as and rejects unproven channel identities`, async t => {
  const previous = process.env.TB_OWNER_ID;
  process.env.TB_OWNER_ID = '123';
  t.after(() => {if (previous === undefined) delete process.env.TB_OWNER_ID; else process.env.TB_OWNER_ID = previous;});
  const branding = require('../dist/v2/branding.js');
  const oldName = branding.getBotName();
  t.after(() => branding.setBotName(oldName));
  const privacy = require('../dist/v2/ip-privacy.js');
  const oldPrivacy = {...privacy.getIpPrivacy()};
  t.after(() => privacy.setIpPrivacy(oldPrivacy));
  let effects = 0, state = {users: [], chats: [], messages: {}};
  const edits = [];
  const ctx = {
    signal: new AbortController().signal,
    storage: {json: () => ({read: async () => state, update: async fn => {effects++; state = fn(state); return state;}})},
    processes: {run: async () => {effects++; return {stdout: Buffer.from('ok'), stderr: Buffer.alloc(0)};}},
    files: {withTemp: async fn => fn('/tmp', new AbortController().signal)},
    telegram: {edit: async (_m, text) => edits.push(text), withClient: async fn => fn({getMe: async () => ({id: 123n}), sendFile: async () => {effects++;}})},
  };
  const plugin = factories[id]();
  const run = message => plugin.commands[id].handle({message, args: args[id], command: id, prefix: '.'}, ctx);
  const skin = envelope();
  for (const patch of [{outgoing: false}, {forwarded: true}, {edited: true}, {raw: {...skin.raw, post: true}},
    {raw: undefined}, {senderId: '999'}, {chatId: '123'}]) {
    const before = effects;
    await run({...skin, ...patch});
    assert.equal(effects, before, Object.keys(patch).join(","));
    assert.match(edits.at(-1), /权限|owner|账号本人/);
  }
  await run(skin);
  assert.ok(effects > 0, 'channel command must execute its operation');
  const before = effects;
  await run({...skin, senderId: '123'});
  assert.ok(effects > before, 'personal owner remains authorized');
});
