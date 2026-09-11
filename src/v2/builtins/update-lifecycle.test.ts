import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {Api} from "teleproto";
import {ResourceScope} from "../lifecycle";
import {StorageRoot} from "../storage";
import createUpdate from "./update";
import type {CommandInvocation, MessageEnvelope, PluginContext} from "../sdk";

type Receipt = {ownerId: string; chatId: string; messageId: number; requestedAt: number; bootId: string;
  requestId?: string};
type State = {pending: Receipt | null};

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) assert.fail("condition did not become true");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t: TestContext, options: {
  activeState?: string;
  edit?: (message: MessageEnvelope, text: string) => void | Promise<void>;
  resultTimeoutMs?: number;
  gitVersions?: Readonly<Record<string, string>>;
} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-update-lifecycle-")));
  const scope = new ResourceScope();
  const storage = new StorageRoot(path.join(root, "assets"));
  const receipts = storage.json<State>("update", "update-receipt.json", {pending: null});
  const autoConfig = storage.json<{enabled: boolean; lastResultId?: string}>("update", "config.json", {enabled: false});
  const edits: {id: number; text: string}[] = [];
  const automaticMessages: {peer: unknown; text: string}[] = [];
  const logs: string[] = [];
  const calls: string[][] = [];
  let activeState = options.activeState ?? "inactive";
  const fields: Record<string, string> = {
    LoadState: "loaded", UnitFileState: "static", SubState: "dead", CanStart: "yes",
    FragmentPath: "/etc/systemd/system/mibot-update.service", Result: "success",
  };
  const ctx = {
    signal: scope.signal,
    tasks: scope,
    log: {info() {}, error(event: string) { logs.push(event); }},
    storage: {json: <T extends Record<string, unknown>>(file: string, defaults: T) => storage.json<T>("update", file, defaults)},
    processes: {run: async (command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "start") activeState = "active";
      if (command === "/usr/bin/git" && args[2] === "show") {
        const version = options.gitVersions?.[args[3]];
        return {stdout: Buffer.from(version ? JSON.stringify({version}) : ""), stderr: Buffer.alloc(0), exitCode: 0};
      }
      const property = args[args.indexOf("-p") + 1];
      const value = property === "ActiveState" ? activeState : fields[property] ?? "";
      return {stdout: Buffer.from(value), stderr: Buffer.alloc(0), exitCode: 0};
    }},
    telegram: {
      edit: async (message: MessageEnvelope, text: string) => {
        edits.push({id: message.id, text});
        await options.edit?.(message, text);
      },
      async withClient<T>(operation: (client: {sendMessage(peer: unknown, payload: {message: string}): Promise<void>},
        signal: AbortSignal) => Promise<T>): Promise<T> {
        return operation({async sendMessage(peer, payload) {
          automaticMessages.push({peer, text: payload.message});
        }}, scope.signal);
      },
    },
  } as unknown as PluginContext;
  const plugin = createUpdate(root, "1", {pollIntervalMs: 5,
    resultTimeoutMs: options.resultTimeoutMs ?? 50, startupGraceMs: 10});
  await plugin.setup?.(ctx);
  const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "getuid", {value: () => 0, configurable: true});
  t.after(async () => {
    const report = await scope.drain(1000);
    assert.equal(report.completed, true);
    assert.equal(report.pendingTasks, 0);
    assert.equal(report.pendingResources, 0);
    await plugin.cleanup?.(ctx);
    await storage.close();
    await fs.rm(root, {recursive: true, force: true});
    if (descriptor) Object.defineProperty(process, "getuid", descriptor);
  });
  const run = (id: number) => plugin.commands.update.subcommands!.run.handle({
    command: "update", args: [], prefix: ".",
    message: {id, chatId: String(id), senderId: "1", outgoing: true, text: ".update"},
  } as CommandInvocation, ctx);
  return {root, scope, receipts, autoConfig, edits, automaticMessages, logs, calls, ctx, plugin, run,
    setActiveState(value: string) { activeState = value; }};
}

test("concurrent update commands atomically reserve one request and start once", async t => {
  const f = await fixture(t);
  await Promise.all([f.run(1), f.run(2)]);
  assert.equal(f.calls.filter(args => args[0] === "start").length, 1);
  assert.equal(f.edits.filter(({text}) => text.includes("正在更新主程序")).length, 1);
  assert.equal(f.edits.filter(({text}) => text.includes("已有更新任务")).length, 1);
  const pending = (await f.receipts.read()).pending!;
  assert.match(pending.requestId!, /^[0-9a-f-]{36}$/i);
  const request = JSON.parse(await fs.readFile(path.join(f.root, "temp/update-request.json"), "utf8"));
  assert.equal(request.requestId, pending.requestId);
});

test("a stale result cannot complete a new request and the matching id spans request to result", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "temp"), {recursive: true});
  await fs.writeFile(path.join(f.root, "temp/update-result.json"), JSON.stringify({status: "failed", reason: "old-attempt"}));
  await f.run(1);
  const pending = (await f.receipts.read()).pending!;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await f.receipts.read()).pending?.requestId, pending.requestId);
  assert.doesNotMatch(f.edits.map(({text}) => text).join("\n"), /old-attempt/);

  await fs.writeFile(path.join(f.root, "temp/update-result.json"),
    JSON.stringify({status: "failed", reason: "matching-attempt", requestId: pending.requestId}));
  await waitFor(async () => (await f.receipts.read()).pending === null);
  assert.match(f.edits.at(-1)!.text, /matching-attempt/);
});

test("notifyReady observes a missing result in the managed background until the active service ends", async t => {
  const f = await fixture(t, {activeState: "active", resultTimeoutMs: 20});
  await f.receipts.update(() => ({pending: {ownerId: "1", chatId: "1", messageId: 7,
    requestedAt: Date.now(), bootId: "previous", requestId: "12345678-1234-4234-8234-123456789abc"}}));
  const started = Date.now();
  await f.plugin.notifyReady();
  assert.ok(Date.now() - started < 100);
  await waitFor(() => f.scope.snapshot().pendingTasks > 0);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.ok((await f.receipts.read()).pending, "an active update remains owned after the observation deadline");
  f.setActiveState("inactive");
  await waitFor(async () => (await f.receipts.read()).pending === null);
  assert.match(f.edits.at(-1)!.text, /已结束但未返回对应结果/);
});

test("legacy id-less receipts recover the version range and release ownership even when notification fails", async t => {
  const f = await fixture(t, {activeState: "inactive", gitVersions: {"ORIG_HEAD:package.json": "0.7.5"},
    edit: async () => { throw new Error("telegram unavailable"); }});
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({version: "0.7.6"}));
  await fs.writeFile(path.join(f.root, "CHANGELOG.md"),
    "# Changelog\n\n## [0.7.6] - 2026-09-11\n\n- 新增 <摘要>。\n\n## [0.7.5]\n\n- 旧内容。\n");
  await f.receipts.update(() => ({pending: {ownerId: "1", chatId: "1", messageId: 8,
    requestedAt: Date.now(), bootId: "v071"}}));
  await fs.mkdir(path.join(f.root, "temp"), {recursive: true});
  await fs.writeFile(path.join(f.root, "temp/update-result.json"), JSON.stringify({status: "success", reason: ""}));
  await f.plugin.notifyReady();
  await waitFor(async () => (await f.receipts.read()).pending === null);
  assert.match(f.edits.at(-1)!.text, /更新成功/);
  assert.match(f.edits.at(-1)!.text, /0\.7\.5<\/code> → <code>0\.7\.6/);
  assert.match(f.edits.at(-1)!.text, /新增 &lt;摘要&gt;。/);
  assert.doesNotMatch(f.edits.at(-1)!.text, /旧内容/);
  assert.ok(f.logs.includes("update.receipt_notification_failed"));
});

test("a successful no-op update reports that no code changed", async t => {
  const f = await fixture(t, {activeState: "inactive"});
  const requestId = "12345678-1234-4234-8234-123456789abc";
  await f.receipts.update(() => ({pending: {ownerId: "1", chatId: "1", messageId: 14,
    requestedAt: Date.now(), bootId: "previous", requestId}}));
  await fs.mkdir(path.join(f.root, "temp"), {recursive: true});
  await fs.writeFile(path.join(f.root, "temp/update-result.json"), JSON.stringify({
    status: "success", reason: "", requestId, previousVersion: "0.7.6", currentVersion: "0.7.6",
    previousRevision: "a".repeat(40), currentRevision: "a".repeat(40),
  }));
  await f.plugin.notifyReady();
  await waitFor(async () => (await f.receipts.read()).pending === null);
  assert.match(f.edits.at(-1)!.text, /本次没有代码变更/);
  assert.match(f.edits.at(-1)!.text, /0\.7\.6/);
});

test("automatic update results are sent once to Saved Messages", async t => {
  const f = await fixture(t, {activeState: "inactive"});
  const automaticId = "c".repeat(64);
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({version: "0.7.7"}));
  await fs.writeFile(path.join(f.root, "CHANGELOG.md"),
    "# Changelog\n\n## [0.7.7] - 2026-09-11\n\n- 自动监测 GitHub 更新。\n\n## [0.7.6]\n\n- old\n");
  await fs.mkdir(path.join(f.root, "temp"), {recursive: true});
  await fs.writeFile(path.join(f.root, "temp/automatic-update-result.json"), JSON.stringify({
    status: "success", reason: "", trigger: "automatic", automaticId,
    previousVersion: "0.7.6", currentVersion: "0.7.7",
    previousRevision: "a".repeat(40), currentRevision: "b".repeat(40),
  }));
  await Promise.all([
    f.plugin.notifyReady(),
    f.plugin.jobs!.automaticResult.handle(f.ctx, f.scope.signal),
  ]);
  await waitFor(() => f.automaticMessages.length === 1);
  assert.ok(f.automaticMessages[0].peer instanceof Api.InputPeerSelf);
  assert.match(f.automaticMessages[0].text, /自动更新成功/);
  assert.match(f.automaticMessages[0].text, /自动监测 GitHub 更新/);
  assert.equal((await f.autoConfig.read()).lastResultId, automaticId);

  await f.plugin.jobs!.automaticResult.handle(f.ctx, f.scope.signal);
  assert.equal(f.automaticMessages.length, 1);
});

test("legacy receipts ignore an older id-less result but accept a fresh 0.7.1 result", async t => {
  const f = await fixture(t, {activeState: "active"});
  await fs.mkdir(path.join(f.root, "temp"), {recursive: true});
  const resultFile = path.join(f.root, "temp/update-result.json");
  await fs.writeFile(resultFile, JSON.stringify({status: "failed", reason: "stale-legacy"}));
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(resultFile, old, old);
  await f.receipts.update(() => ({pending: {ownerId: "1", chatId: "1", messageId: 10,
    requestedAt: Date.now(), bootId: "v071"}}));

  await f.plugin.notifyReady();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok((await f.receipts.read()).pending);
  assert.doesNotMatch(f.edits.map(({text}) => text).join("\n"), /stale-legacy/);

  await fs.writeFile(resultFile, JSON.stringify({status: "failed", reason: "fresh-legacy"}));
  await waitFor(async () => (await f.receipts.read()).pending === null);
  assert.match(f.edits.at(-1)!.text, /fresh-legacy/);
});

test("a completed same-boot request is reconciled before a later update starts", async t => {
  const f = await fixture(t);
  await f.run(1);
  const first = (await f.receipts.read()).pending!;
  await fs.writeFile(path.join(f.root, "temp/update-result.json"),
    JSON.stringify({status: "success", reason: "", requestId: first.requestId}));
  await waitFor(() => f.scope.snapshot().pendingTasks === 0);
  assert.equal((await f.receipts.read()).pending?.requestId, first.requestId);

  f.setActiveState("inactive");
  await f.run(2);
  assert.equal(f.calls.filter(args => args[0] === "start").length, 2);
  assert.equal((await f.receipts.read()).pending?.messageId, 2);
  assert.ok(f.edits.some(({id, text}) => id === 1 && text.includes("更新成功")));
});

test("an old observer stops without clearing a replacement receipt", async t => {
  const f = await fixture(t, {activeState: "active"});
  const old: Receipt = {ownerId: "1", chatId: "1", messageId: 11, requestedAt: Date.now(),
    bootId: "previous", requestId: "12345678-1234-4234-8234-123456789abc"};
  const replacement: Receipt = {ownerId: "1", chatId: "2", messageId: 12, requestedAt: Date.now(),
    bootId: "replacement", requestId: "87654321-4321-4321-8321-cba987654321"};
  await f.receipts.update(() => ({pending: old}));
  await f.plugin.notifyReady();
  await waitFor(() => f.scope.snapshot().pendingTasks > 0);
  await f.receipts.update(() => ({pending: replacement}));
  f.setActiveState("inactive");
  await waitFor(() => f.scope.snapshot().pendingTasks === 0);
  assert.deepEqual((await f.receipts.read()).pending, replacement);
});

test("unload drains recovery observation and a new generation resolves its preserved receipt", async t => {
  const f = await fixture(t, {activeState: "active"});
  await f.receipts.update(() => ({pending: {ownerId: "1", chatId: "1", messageId: 13,
    requestedAt: Date.now(), bootId: "previous", requestId: "12345678-1234-4234-8234-123456789abc"}}));
  await f.plugin.notifyReady();
  await waitFor(() => f.scope.snapshot().pendingTasks > 0);
  const unloaded = await f.scope.drain(1000);
  assert.equal(unloaded.completed, true);
  assert.ok((await f.receipts.read()).pending);
  await f.plugin.cleanup?.(f.ctx);

  f.setActiveState("inactive");
  const nextScope = new ResourceScope();
  const nextContext = {...f.ctx, signal: nextScope.signal, tasks: nextScope} as PluginContext;
  const next = createUpdate(f.root, "1", {pollIntervalMs: 5, resultTimeoutMs: 50, startupGraceMs: 10});
  await next.setup?.(nextContext);
  await next.notifyReady();
  await waitFor(async () => (await f.receipts.read()).pending === null);
  assert.match(f.edits.at(-1)!.text, /已结束但未返回对应结果/);
  assert.equal((await nextScope.drain(1000)).completed, true);
  await next.cleanup?.(nextContext);
});

test("an already active update service cannot adopt a stale result or create a new receipt", async t => {
  const f = await fixture(t, {activeState: "active"});
  await fs.mkdir(path.join(f.root, "temp"), {recursive: true});
  await fs.writeFile(path.join(f.root, "temp/update-result.json"), JSON.stringify({status: "success", reason: "old"}));
  await f.run(1);
  assert.equal((await f.receipts.read()).pending, null);
  assert.equal(f.calls.filter(args => args[0] === "start").length, 0);
  assert.match(f.edits.at(-1)!.text, /已有更新任务/);
  assert.equal(await fs.stat(path.join(f.root, "temp/update-request.json")).then(() => true, () => false), false);
});

test("an unknown service state releases an expired old receipt without claiming the task ended", async t => {
  const f = await fixture(t, {activeState: "unavailable", resultTimeoutMs: 10});
  await f.receipts.update(() => ({pending: {ownerId: "1", chatId: "1", messageId: 9,
    requestedAt: Date.now() - 20, bootId: "previous", requestId: "87654321-4321-4321-8321-cba987654321"}}));
  await f.plugin.notifyReady();
  await waitFor(async () => (await f.receipts.read()).pending === null);
  assert.match(f.edits.at(-1)!.text, /无法确认更新服务状态/);
  assert.doesNotMatch(f.edits.at(-1)!.text, /任务已结束/);
});
