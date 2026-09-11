import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {readFileSync, mkdtempSync, realpathSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {Api} from "teleproto";
import type {TelegramClient} from "teleproto";
import {PluginHost} from "../host";
import {ResourceScope} from "../lifecycle";
import {ScopedFiles} from "../files";
import type {CommandInvocation, PluginContext, PluginLogger} from "../sdk";
import type {ProcessResult, ProcessRunOptions} from "../processes";
import {createLogLevel} from "./loglevel";
import {createHelp} from "./help";

const SELF = "1";
const PEER = "2";
const EXPECTED = "journal line one\njournal line two\n";

function control() {
  return {
    async initialize() {},
    getLevelName() {return "INFO";},
    getProtocolLevel() {return "info" as const;},
    async setLevel() {},
  };
}

interface Upload { peer: unknown; options: Record<string, unknown>; bytes: Buffer; }
interface Call { command: string; args: string[]; options: ProcessRunOptions; }

function fixture(t: TestContext, options: {
  stdout?: Buffer;
  run?: (command: string, args: string[], runOptions: ProcessRunOptions) => Promise<ProcessResult> | never;
  sendError?: Error;
  beforeWrite?: (temp: string) => void | Promise<void>;
} = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mibot-log-")));
  const scope = new ResourceScope();
  const scoped = new ScopedFiles(scope, path.join(base, "data"), path.join(base, "temp"), "loglevel");
  // Real ScopedFiles temp lifecycle; the hook only models a filesystem failure
  // between journalctl and the output write.
  const files = options.beforeWrite
    ? {...scoped, withTemp: (use: Parameters<ScopedFiles["withTemp"]>[0]) => scoped.withTemp(async (temp, signal) => {
      await options.beforeWrite!(temp);
      return use(temp, signal);
    })}
    : scoped;
  const edits: string[] = [];
  const events: string[] = [];
  const calls: Call[] = [];
  const uploads: Upload[] = [];
  const logger: PluginLogger = {info(event) {events.push(`info:${event}`);}, error(event) {events.push(`error:${event}`);}};
  const processes = {run: async (command: string, args: string[], runOptions: ProcessRunOptions) => {
    calls.push({command, args, options: runOptions});
    if (options.run) return options.run(command, args, runOptions);
    return {stdout: options.stdout ?? Buffer.from(EXPECTED), stderr: Buffer.alloc(0), exitCode: 0} as ProcessResult;
  }};
  const telegram = {
    async edit(_message: unknown, text: string) {edits.push(text);},
    async withClient(operation: (client: TelegramClient, signal: AbortSignal) => Promise<unknown>) {
      return operation({async sendFile(peer: unknown, upload: Record<string, unknown> & {file: string}) {
        if (options.sendError) throw options.sendError;
        uploads.push({peer, options: upload, bytes: readFileSync(upload.file)});
      }} as unknown as TelegramClient, scope.signal);
    },
  };
  const ctx = {signal: scope.signal, tasks: scope, log: logger, files, processes, telegram} as unknown as PluginContext;
  const plugin = createLogLevel(control() as unknown as Parameters<typeof createLogLevel>[0], SELF);
  const invoke = async (args: string[] = [], message: Partial<CommandInvocation["message"]> = {}) => {
    const invocation = {command: "log", prefix: ".", args,
      message: {id: 1, chatId: PEER, senderId: SELF, outgoing: true, text: ".log", ...message}} as CommandInvocation;
    await plugin.commands.log.handle(invocation, ctx);
  };
  t.after(async () => {await scope.drain(); await rm(base, {recursive: true, force: true});});
  return {ctx, scope, invoke, edits, events, calls, uploads, base};
}

test(".log reads the exact journalctl argv and sends mibot.log only to InputPeerSelf", async t => {
  const f = fixture(t);
  await f.invoke([]);
  assert.deepEqual(f.calls, [{command: "/usr/bin/journalctl",
    args: ["-u", "mibot.service", "-n", "100", "--no-pager"],
    options: {timeoutMs: 10_000, maxOutputBytes: 1_048_576}}]);
  assert.equal(f.uploads.length, 1);
  assert.ok(f.uploads[0].peer instanceof Api.InputPeerSelf);
  assert.equal((f.uploads[0].peer as {className: string}).className, "InputPeerSelf");
  assert.equal(path.basename(String(f.uploads[0].options.file)), "mibot.log");
  assert.deepEqual(f.uploads[0].bytes, Buffer.from(EXPECTED));
  assert.equal(f.edits.at(-1), "✅ 日志已发送到收藏夹");
  assert.deepEqual(f.events, []);

  f.calls.length = 0;
  f.uploads.length = 0;
  await f.invoke(["250"]);
  assert.equal(f.calls[0].command, "/usr/bin/journalctl");
  assert.deepEqual(f.calls[0].args, ["-u", "mibot.service", "-n", "250", "--no-pager"]);
  assert.equal(f.edits.at(-1), "✅ 日志已发送到收藏夹");
});

test(".log enforces the 1-500 line range without spawning journalctl", async t => {
  const f = fixture(t);
  for (const args of [["0"], ["501"], ["-1"], ["1e2"], ["abc"], ["100", "extra"], ["0501"], ["+5"], ["5.0"]]) {
    f.calls.length = 0;
    f.uploads.length = 0;
    f.events.length = 0;
    await f.invoke(args);
    assert.equal(f.edits.at(-1), "❌ 行数需为 1–500 的整数", args.join(" "));
    assert.deepEqual(f.calls, [], args.join(" "));
    assert.deepEqual(f.uploads, [], args.join(" "));
    assert.deepEqual(f.events, [], args.join(" "));
  }
  for (const value of ["1", "500"]) {
    f.calls.length = 0;
    await f.invoke([value]);
    assert.deepEqual(f.calls[0].args, ["-u", "mibot.service", "-n", value, "--no-pager"]);
  }
});

test(".log keeps journalctl failures fixed and free of native details", async t => {
  const f = fixture(t, {run: async () => {throw new Error("journalctl stderr: /var/log/secret token-4ae7");}});
  await f.invoke([]);
  assert.equal(f.edits.at(-1), "❌ 读取日志失败，请稍后重试");
  assert.deepEqual(f.events, ["error:log.read_failed"]);
  assert.equal(f.uploads.length, 0);
  assert.ok(!JSON.stringify(f.edits).includes("secret"));
  assert.ok(!JSON.stringify(f.edits).includes("journalctl"));
});

test(".log reports an empty journal without uploading a file", async t => {
  const f = fixture(t, {stdout: Buffer.alloc(0)});
  await f.invoke([]);
  assert.equal(f.edits.at(-1), "📭 暂无可用日志");
  assert.deepEqual(f.events, ["info:log.empty"]);
  assert.equal(f.uploads.length, 0);
});

test(".log keeps send failures fixed and free of native details", async t => {
  const f = fixture(t, {sendError: new Error("upload failed for /tmp/secret mibot.log")});
  await f.invoke([]);
  assert.equal(f.edits.at(-1), "❌ 日志发送失败，请稍后重试");
  assert.deepEqual(f.events, ["error:log.send_failed"]);
  assert.ok(!JSON.stringify(f.edits).includes("secret"));
});

test(".log reports a real temp output write failure without uploading", async t => {
  const f = fixture(t, {beforeWrite: async temp => {await rm(temp, {recursive: true, force: true});}});
  await f.invoke([]);
  assert.equal(f.edits.at(-1), "❌ 日志准备失败，请稍后重试");
  assert.deepEqual(f.events, ["error:log.write_failed"]);
  assert.equal(f.uploads.length, 0);
});

test(".log denies non-owner commands before reading or sending", async t => {
  const f = fixture(t);
  await f.invoke([], {senderId: PEER, chatId: PEER});
  assert.equal(f.edits.at(-1), "没有查看日志的权限");
  assert.deepEqual(f.events, ["error:log.permission_denied"]);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.uploads, []);
});

test(".log cancellation keeps no late reply, upload or event", async t => {
  const f = fixture(t, {run: async () => {
    await new Promise((_resolve, reject) => setTimeout(() => reject(new Error("journal settled late")), 40));
    return {stdout: Buffer.from(EXPECTED), stderr: Buffer.alloc(0), exitCode: 0};
  }});
  const running = f.invoke([]);
  f.scope.abort(new Error("cancel"));
  await assert.rejects(running);
  assert.deepEqual(f.edits, []);
  assert.deepEqual(f.uploads, []);
  assert.deepEqual(f.events, []);
});

async function hostFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mibot-log-host-")));
  const sent: string[] = [];
  const events: string[] = [];
  const forbidden = async (): Promise<never> => assert.fail("this path must not invoke external work");
  const host = new PluginHost({storageRoot: root, tempRoot: path.join(root, "temp"), prefixes: ["."],
    logger: {info(event) {events.push(`info:${event}`);}, error(event) {events.push(`error:${event}`);}},
    telegram: {async edit(_message, text) {sent.push(text);}, async reply(_message, text) {sent.push(text);},
      invoke: forbidden, getReply: forbidden, withClient: forbidden}});
  t.after(async () => {await host.shutdown(2000); await rm(root, {recursive: true, force: true});});
  await host.load(createHelp(host, SELF));
  await host.load(createLogLevel(control() as unknown as Parameters<typeof createLogLevel>[0], SELF));
  const dispatch = (text: string, message: Partial<CommandInvocation["message"]> = {}) => host.dispatchPrimary(
    {id: 1, chatId: PEER, senderId: SELF, outgoing: true, text, ...message});
  return {host, sent, events, dispatch};
}

test(".log and .help log render the shared declaration without process or Telegram work", async t => {
  const f = await hostFixture(t);
  for (const text of [".log help", ".log h", ".help log"]) {
    f.sent.length = 0;
    assert.equal(await f.dispatch(text), true, text);
    assert.ok(f.sent.length, text);
    assert.match(f.sent.join("\n"), /journalctl/, text);
    assert.match(f.sent.join("\n"), /收藏夹/, text);
  }
  assert.deepEqual(f.events, []);
});

test(".log rejects bad line counts and non-owner identities through the Host", async t => {
  const f = await hostFixture(t);
  f.sent.length = 0;
  assert.equal(await f.dispatch(".log 0"), true);
  assert.equal(f.sent.at(-1), "❌ 行数需为 1–500 的整数");
  f.sent.length = 0;
  assert.equal(await f.dispatch(".log 3", {senderId: PEER, chatId: PEER}), true);
  assert.equal(f.sent.at(-1), "没有查看日志的权限");
  assert.deepEqual(f.events, ["error:log.permission_denied"]);
  f.sent.length = 0;
  assert.equal(await f.dispatch(".log 3", {outgoing: false}), false);
  assert.deepEqual(f.sent, []);
  // A non-forwarded saved envelope may be incoming; ignoreForwarded must not drop it.
  f.sent.length = 0;
  assert.equal(await f.dispatch(".log 0", {outgoing: false, saved: true, chatId: SELF, senderId: SELF}), true);
  assert.equal(f.sent.at(-1), "❌ 行数需为 1–500 的整数");
});

test(".log drops forwarded commands at admission, including owned outgoing private messages", async t => {
  const f = await hostFixture(t);
  // The identity fix resolves own private forwards to the owner, so admission must
  // reject them before any journalctl read or upload.
  assert.equal(await f.dispatch(".log 5", {forwarded: true}), false);
  assert.equal(await f.dispatch(".log 5", {forwarded: true, senderId: PEER, chatId: PEER}), false);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.events, []);
  assert.equal(f.host.snapshot().processes, undefined, "no helper process was started");
});

test("loglevel process limits stay within host caps and unload cleanly", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mibot-log-limits-")));
  const host = new PluginHost({storageRoot: root, tempRoot: path.join(root, "temp"), prefixes: ["."],
    logger: {info() {}, error() {}},
    processes: {concurrency: 2, queueCapacity: 16, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024},
    telegram: {async edit() {}, async reply() {}, async invoke() {}, async getReply() {return undefined;},
      async withClient() {assert.fail("no native work");}}});
  t.after(async () => {await host.shutdown(2000); await rm(root, {recursive: true, force: true});});
  await host.load(createLogLevel(control() as unknown as Parameters<typeof createLogLevel>[0], SELF));
  assert.equal(host.pluginState("loglevel"), "active");
  assert.equal((await host.unload("loglevel"))?.completed, true);
  assert.equal(host.pluginState("loglevel"), undefined);

  const tightRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mibot-log-limits-tight-")));
  const tight = new PluginHost({storageRoot: tightRoot, tempRoot: path.join(tightRoot, "temp"), prefixes: ["."],
    logger: {info() {}, error() {}}, processes: {maxOutputBytes: 1024},
    telegram: {async edit() {}, async reply() {}, async invoke() {}, async getReply() {return undefined;},
      async withClient() {assert.fail("no native work");}}});
  t.after(async () => {await tight.shutdown(2000); await rm(tightRoot, {recursive: true, force: true});});
  await assert.rejects(tight.load(createLogLevel(control() as unknown as Parameters<typeof createLogLevel>[0], SELF)),
    /exceeds host limit/);
  assert.equal(tight.pluginState("loglevel"), undefined);
});
