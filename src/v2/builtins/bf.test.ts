import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {mkdtemp, realpath, rm, writeFile, mkdir} from "node:fs/promises";
import {readFileSync, mkdtempSync, realpathSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {Api} from "teleproto";
import type {TelegramClient} from "teleproto";
import {returnBigInt} from "teleproto/Helpers";
import {PluginHost} from "../host";
import {ResourceScope} from "../lifecycle";
import {ScopedFiles} from "../files";
import {messageEnvelope} from "../telegram";
import type {CommandInvocation, PluginContext, PluginLogger} from "../sdk";
import type {ProcessResult} from "../processes";
import createBf from "./bf";
import {createHelp} from "./help";

const SELF = "1001";
const PEER = "2002";
const CHANNEL = "3003";

interface Upload { peer: unknown; options: Record<string, unknown>; bytes: Buffer; }

async function fixture(t: TestContext, options: {entries?: string[]} = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mibot-bf-")));
  for (const entry of options.entries ?? ["package.json", ".env"]) {
    const target = path.join(root, entry);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, `fixture:${entry}`);
  }
  const uploads: Upload[] = [];
  const edits: string[] = [];
  const events: string[] = [];
  const host = new PluginHost({
    storageRoot: path.join(root, "assets"), tempRoot: path.join(root, "temp"), prefixes: ["."],
    logger: {info(event) {events.push(`info:${event}`);}, error(event) {events.push(`error:${event}`);}},
    telegram: {
      async edit(_message, text) {edits.push(text);},
      async reply() {},
      async invoke() {},
      async getReply() {return undefined;},
      async withClient(operation, signal) {
        return operation({
          async sendFile(peer: unknown, upload: Record<string, unknown> & {file: string}) {
            uploads.push({peer, options: upload, bytes: readFileSync(upload.file)});
            return {};
          },
        } as unknown as TelegramClient, signal);
      },
    },
  });
  t.after(async () => {
    await host.shutdown(2000);
    await rm(root, {recursive: true, force: true});
  });
  await host.load(createBf(root, SELF));
  return {host, root, uploads, edits, events};
}

function ownerPrivate(peerId: Api.TypePeer, fromId?: Api.TypePeer, id = 1) {
  return messageEnvelope(new Api.Message({id, peerId, fromId, out: true, message: ".bf", date: 1}), {selfId: SELF});
}

test("bf sends the archive to InputPeerSelf from Saved Messages, private chats and group send-as", async t => {
  const f = await fixture(t);
  const cases: Array<{label: string; peerId: Api.TypePeer; fromId?: Api.TypePeer}> = [
    {label: "saved", peerId: new Api.PeerUser({userId: returnBigInt(SELF)})},
    {label: "private", peerId: new Api.PeerUser({userId: returnBigInt(PEER)})},
    {label: "send-as", peerId: new Api.PeerChannel({channelId: returnBigInt("4004")}),
      fromId: new Api.PeerChannel({channelId: returnBigInt(CHANNEL)})},
  ];
  for (const [index, item] of cases.entries()) {
    f.uploads.length = 0;
    f.edits.length = 0;
    assert.equal(await f.host.dispatchPrimary(ownerPrivate(item.peerId, item.fromId, index + 1)), true, item.label);
    assert.equal(f.uploads.length, 1, item.label);
    if (!(f.uploads[0].peer instanceof Api.InputPeerSelf)) assert.fail(`${item.label}: target must be InputPeerSelf`);
    assert.match(String(f.uploads[0].options.file), /mi-box-[0-9a-f-]+\.tar\.gz$/, item.label);
    assert.equal(f.uploads[0].bytes[0], 0x1f, `${item.label}: gzip magic`);
    assert.equal(f.uploads[0].bytes[1], 0x8b, `${item.label}: gzip magic`);
    assert.ok(!String(f.uploads[0].options.file).includes(".env"), item.label);
    assert.match(f.edits.at(-1)!, /已发送到收藏夹/, item.label);
  }
});

test("bf never uses the invoking chat as the upload target", async t => {
  const f = await fixture(t);
  const commanding = ownerPrivate(new Api.PeerChannel({channelId: returnBigInt("4004")}), new Api.PeerChannel({channelId: returnBigInt(CHANNEL)}));
  assert.equal(commanding.chatId, "-1004004");
  await f.host.dispatchPrimary(commanding);
  assert.equal(f.uploads.length, 1);
  assert.ok(f.uploads[0].peer instanceof Api.InputPeerSelf);
  assert.equal((f.uploads[0].peer as {className: string}).className, "InputPeerSelf");
});

test("bf denies send-as that is unproven and incoming private commands", async t => {
  const f = await fixture(t);
  const denied = [
    // Ordinary user message in a supergroup: senderId is a user, not a channel.
    messageEnvelope(new Api.Message({id: 2, peerId: new Api.PeerChannel({channelId: returnBigInt("4004")}),
      fromId: new Api.PeerUser({userId: returnBigInt(PEER)}), out: true, message: ".bf", date: 1}), {selfId: SELF}),
    // Channel broadcast post.
    messageEnvelope(new Api.Message({id: 4, peerId: new Api.PeerChannel({channelId: returnBigInt("4004")}),
      fromId: new Api.PeerChannel({channelId: returnBigInt(CHANNEL)}), out: true, post: true, message: ".bf", date: 1}), {selfId: SELF}),
  ];
  for (const envelope of denied) {
    assert.equal(await f.host.dispatchPrimary(envelope), true);
    assert.match(f.edits.at(-1)!, /没有创建备份的权限/);
  }
  assert.equal(f.uploads.length, 0);
  const incoming = messageEnvelope(new Api.Message({id: 5, peerId: new Api.PeerUser({userId: returnBigInt(PEER)}),
    out: false, message: ".bf", date: 1}), {selfId: SELF});
  assert.equal(await f.host.dispatchPrimary(incoming), false);
  assert.equal(f.uploads.length, 0);
});

test("bf drops forwarded commands at admission, including owned outgoing private messages", async t => {
  const f = await fixture(t);
  const forwarded = [
    // Forwarded group send-as was previously caught only inside the handler.
    messageEnvelope(new Api.Message({id: 6, peerId: new Api.PeerChannel({channelId: returnBigInt("4004")}),
      fromId: new Api.PeerChannel({channelId: returnBigInt(CHANNEL)}), out: true, message: ".bf", date: 1,
      fwdFrom: new Api.MessageFwdHeader({date: 1})}), {selfId: SELF}),
    // The identity fix resolves own private forwards to the owner; admission must reject them.
    messageEnvelope(new Api.Message({id: 7, peerId: new Api.PeerUser({userId: returnBigInt(PEER)}),
      out: true, message: ".bf", date: 1, fwdFrom: new Api.MessageFwdHeader({date: 1})}), {selfId: SELF}),
  ];
  assert.equal(forwarded[1].senderId, SELF, "private forward resolves to the owner");
  assert.equal(forwarded[1].forwarded, true);
  for (const envelope of forwarded) {
    assert.equal(envelope.forwarded, true);
    assert.equal(await f.host.dispatchPrimary(envelope), false);
  }
  assert.deepEqual(f.edits, []);
  assert.equal(f.uploads.length, 0);
});

test("bf still admits a non-forwarded saved incoming envelope", async t => {
  const f = await fixture(t);
  const saved = messageEnvelope(new Api.Message({id: 9, peerId: new Api.PeerUser({userId: returnBigInt(SELF)}),
    out: false, message: ".bf", date: 1}), {selfId: SELF});
  assert.equal(saved.saved, true);
  assert.equal(saved.outgoing, false);
  assert.equal(await f.host.dispatchPrimary(saved), true);
  assert.equal(f.uploads.length, 1);
  assert.ok(f.uploads[0].peer instanceof Api.InputPeerSelf);
  assert.match(f.edits.at(-1)!, /已发送到收藏夹/);
});

test("bf help is served without packaging or Telegram work", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mibot-bf-help-")));
  const sent: string[] = [];
  const forbidden = async (): Promise<never> => assert.fail("help must not invoke external work");
  const host = new PluginHost({storageRoot: root, tempRoot: path.join(root, "temp"),
    logger: {info() {}, error() {}},
    telegram: {async edit(_message, text) {sent.push(text);}, async reply(_message, text) {sent.push(text);},
      invoke: forbidden, getReply: forbidden, withClient: forbidden}});
  t.after(async () => {await host.shutdown(2000); await rm(root, {recursive: true, force: true});});
  await host.load(createHelp(host, SELF));
  await host.load(createBf(root, SELF));
  for (const [index, text] of [".bf help", ".bf h", ".help bf"].entries()) {
    sent.length = 0;
    const message = ownerPrivate(new Api.PeerUser({userId: returnBigInt(PEER)}), undefined, index + 1);
    await host.dispatchPrimary({...message, text});
    assert.ok(sent.length, text);
    assert.ok(sent.join("\n").includes("收藏夹"), `${text}: destination is documented`);
  }
});

function failureFixture(t: TestContext, options: {
  run?: (command: string, args: string[]) => Promise<ProcessResult> | never;
  send?: (upload: Record<string, unknown>) => void;
} = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mibot-bf-failure-")));
  const root = path.join(base, "root");
  const scope = new ResourceScope();
  const edits: string[] = [];
  const events: string[] = [];
  const calls: Array<{command: string; args: string[]}> = [];
  const files = new ScopedFiles(scope, path.join(base, "data"), path.join(base, "temp"), "bf");
  const logger: PluginLogger = {info(event) {events.push(`info:${event}`);}, error(event) {events.push(`error:${event}`);}};
  const processes = {run: async (command: string, args: string[]) => {
    calls.push({command, args});
    if (options.run) return options.run(command, args);
    return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0} as ProcessResult;
  }};
  const telegram = {
    async edit(_message: unknown, text: string) {edits.push(text);},
    async withClient(operation: (client: TelegramClient, signal: AbortSignal) => Promise<unknown>) {
      return operation({async sendFile(_peer: unknown, upload: Record<string, unknown>) {
        options.send?.(upload);
      }} as unknown as TelegramClient, scope.signal);
    },
  };
  const ctx = {signal: scope.signal, tasks: scope, log: logger, files, processes, telegram} as unknown as PluginContext;
  const invocation: CommandInvocation = {command: "bf", prefix: ".", args: [],
    message: {id: 1, chatId: PEER, senderId: SELF, outgoing: true, text: ".bf"}};
  t.after(async () => {await scope.drain(); await rm(base, {recursive: true, force: true});});
  return {ctx, invocation, edits, events, calls, root, base, scope};
}

test("bf reports packaging failures with a fixed prompt and structured event", async t => {
  const f = failureFixture(t, {run: async () => {throw new Error("tar failed reading /secret/.env credential-4ae7");}});
  // Give the packer a real entry so the failure happens inside the tar step.
  await mkdir(f.root, {recursive: true});
  await writeFile(path.join(f.root, "package.json"), "{}");
  await createBf(f.root, SELF).commands.bf.handle(f.invocation, f.ctx);
  assert.equal(f.edits.at(-1), "❌ 备份打包失败，请稍后重试");
  assert.deepEqual(f.events, ["error:bf.pack_failed"]);
  assert.ok(!JSON.stringify(f.edits).includes("secret"));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, "/usr/bin/tar");
  assert.equal(f.calls[0].args[0], "-czf");
  assert.equal(f.calls[0].args[2], "-C");
  assert.equal(f.calls[0].args[3], f.root);
});

test("bf reports send failures with a fixed prompt and structured event", async t => {
  const f = failureFixture(t, {run: async () => ({stdout: Buffer.from("archive"), stderr: Buffer.alloc(0), exitCode: 0}),
    send: () => {throw new Error("upload failed for /tmp/secret mi-box.tar.gz");}});
  await mkdir(f.root, {recursive: true});
  await writeFile(path.join(f.root, "package.json"), "{}");
  await createBf(f.root, SELF).commands.bf.handle(f.invocation, f.ctx);
  assert.equal(f.edits.at(-1), "❌ 备份发送失败，请稍后重试");
  assert.deepEqual(f.events, ["error:bf.send_failed"]);
  assert.ok(!JSON.stringify(f.edits).includes("secret"));
});

test("bf reports missing inputs without spawning the packer", async t => {
  const f = failureFixture(t);
  await createBf(path.join(f.root, "absent"), SELF).commands.bf.handle(f.invocation, f.ctx);
  assert.equal(f.edits.at(-1), "❌ 没有可备份的文件");
  assert.deepEqual(f.events, ["error:bf.no_input"]);
  assert.deepEqual(f.calls, []);
});

test("bf cancellation keeps no late reply or event", async t => {
  const f = failureFixture(t, {run: async () => {
    await new Promise((_resolve, reject) => setTimeout(() => reject(new Error("packed late")), 50));
    return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};
  }});
  await mkdir(f.root, {recursive: true});
  await writeFile(path.join(f.root, "package.json"), "{}");
  const running = Promise.resolve(createBf(f.root, SELF).commands.bf.handle(f.invocation, f.ctx));
  f.scope.abort(new Error("cancel"));
  await assert.rejects(running);
  assert.deepEqual(f.edits, []);
  assert.deepEqual(f.events, []);
});
