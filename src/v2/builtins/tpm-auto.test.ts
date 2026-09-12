import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {Api} from "teleproto";
import {ResourceScope} from "../lifecycle";
import {StorageRoot} from "../storage";
import createTpm from "./tpm";
import type {CommandInvocation, MessageEnvelope, PluginContext} from "../sdk";
import type {PluginHost} from "../host";
import type {PluginReleases} from "../releases";

const OLD = "a".repeat(64);
const SAME = "b".repeat(64);
const NEW = "c".repeat(64);
const FAILED = "d".repeat(64);

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) assert.fail("condition did not become true");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t: TestContext, options: {
  generations?: {id: string; revision: string; state: "active" | "failed"}[];
  repository?: (args: readonly string[]) => unknown | Promise<unknown>;
  activate?: (id: string, revision: string) => void | Promise<void>;
  send?: (text: string) => void | Promise<void>;
} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-tpm-auto-")));
  const scope = new ResourceScope();
  const storage = new StorageRoot(path.join(root, "assets"));
  const edits: string[] = [];
  const messages: {peer: unknown; text: string}[] = [];
  const calls: string[][] = [];
  const activations: string[] = [];
  const logs: string[] = [];
  const generations = options.generations ?? [];
  const host = {
    pluginState: (id: string) => generations.some(item => item.id === id && item.state === "active") ? "active" : undefined,
    listPlugins: () => generations.map(item => ({id: item.id})),
  } as unknown as PluginHost;
  const releases = {
    snapshot: () => ({generations}),
    async activate(id: string, revision: string) {
      activations.push(`${id}:${revision}`);
      await options.activate?.(id, revision);
      const item = generations.find(value => value.id === id);
      if (item) { item.revision = revision; item.state = "active"; }
    },
    async remove() {},
  } as unknown as PluginReleases;
  const ctx = {
    signal: scope.signal,
    tasks: scope,
    storage: {json: <T extends Record<string, unknown>>(file: string, defaults: T) =>
      storage.json<T>("tpm", file, defaults)},
    log: {info() {}, error(event: string) { logs.push(event); }},
    processes: {run: async (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      const value = await options.repository?.(args);
      return {stdout: Buffer.from(JSON.stringify(value ?? {ids: [], candidates: []})), stderr: Buffer.alloc(0), exitCode: 0};
    }},
    telegram: {
      async edit(_message: MessageEnvelope, text: string) { edits.push(text); },
      async reply(_message: MessageEnvelope, text: string) { edits.push(text); },
      async withClient<T>(operation: (client: {sendMessage(peer: unknown, payload: {message: string}): Promise<void>},
        signal: AbortSignal) => Promise<T>): Promise<T> {
        return operation({async sendMessage(peer, payload) {
          await options.send?.(payload.message);
          messages.push({peer, text: payload.message});
        }}, scope.signal);
      },
    },
  } as unknown as PluginContext;
  const plugin = createTpm(host, releases, root, "1");
  await plugin.setup?.(ctx);
  const state = storage.json<Record<string, unknown>>("tpm", "auto-update.json", {
    schemaVersion: 1, enabled: false, pending: [], processedTriggerIds: [], notifications: [],
  });
  const run = (args: string[], senderId = "1") => plugin.commands.tpm.handle({
    command: "tpm", prefix: ".", args,
    message: {id: 1, chatId: "1", senderId, outgoing: true, text: `.tpm ${args.join(" ")}`},
  } as CommandInvocation, ctx);
  t.after(async () => {
    const report = await scope.drain(2000);
    assert.equal(report.completed, true);
    await plugin.cleanup?.(ctx);
    await storage.close();
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, scope, storage, state, edits, messages, calls, activations, logs, generations, ctx, plugin, run};
}

test("TPM auto commands enforce ownership and persist status with the latest result", async t => {
  const f = await fixture(t);
  await f.run(["auto", "on"], "2");
  assert.match(f.edits.at(-1)!, /只有账号所有者/);
  assert.equal((await f.state.read()).enabled, false);

  await f.run(["auto", "on"]);
  assert.equal((await f.state.read()).enabled, true);
  assert.match(f.edits.at(-1)!, /插件跟随更新：开启/);
  await f.plugin.followSuccessfulUpdate({id: "manual:first", source: "manual"});
  await waitFor(async () => ((await f.state.read()).pending as unknown[]).length === 0);
  await f.run(["auto"]);
  assert.match(f.edits.at(-1)!, /最近运行：20/);
  assert.match(f.edits.at(-1)!, /已更新 0 · 保持最新 0 · 失败 0/);

  await f.run(["auto", "off"]);
  assert.equal((await f.state.read()).enabled, false);
  assert.match(f.edits.at(-1)!, /插件跟随更新：关闭/);
  assert.match(f.plugin.renderHelp!("."), /\.tpm auto \[on\|off\]/);
});

test("TPM auto builds only installed extensions, switches changed revisions, and reports partial failures", async t => {
  const generations = [
    {id: "dig", revision: OLD, state: "active" as const},
    {id: "same", revision: SAME, state: "active" as const},
    {id: "bad", revision: OLD, state: "active" as const},
    {id: "missing", revision: OLD, state: "active" as const},
    {id: "inactive", revision: OLD, state: "failed" as const},
  ];
  const f = await fixture(t, {
    generations,
    repository(args) {
      assert.deepEqual(args.slice(1), ["build-selected", "bad", "dig", "missing", "same"]);
      return {ids: ["bad", "dig", "missing", "same"], candidates: [
        {id: "bad", revision: FAILED}, {id: "dig", revision: NEW},
        {id: "missing", error: "NOT_AVAILABLE"}, {id: "same", revision: SAME},
      ]};
    },
    activate(id) {
      if (id === "bad") throw Object.assign(new Error("private artifact path"), {code: "ACTIVATE"});
    },
  });
  await f.run(["auto", "on"]);
  await f.plugin.followSuccessfulUpdate({id: "automatic:one", source: "automatic"});
  await waitFor(() => f.messages.length === 1);

  assert.deepEqual(f.activations, [`bad:${FAILED}`, `dig:${NEW}`]);
  assert.equal(generations.find(item => item.id === "bad")!.revision, OLD);
  assert.equal(generations.find(item => item.id === "dig")!.revision, NEW);
  assert.equal(f.messages.length, 1);
  assert.ok(f.messages[0].peer instanceof Api.InputPeerSelf);
  assert.match(f.messages[0].text, /已更新 · 1[\s\S]*<code>dig<\/code>/);
  assert.match(f.messages[0].text, /bad<\/code> · ACTIVATE/);
  assert.match(f.messages[0].text, /missing<\/code> · NOT_AVAILABLE/);
  assert.doesNotMatch(JSON.stringify({messages: f.messages, logs: f.logs}), /private artifact path/);
  const result = (await f.state.read()).lastResult as {updated: string[]; unchanged: string[]; failed: unknown[]};
  assert.deepEqual(result.updated, ["dig"]);
  assert.deepEqual(result.unchanged, ["same"]);
  assert.equal(result.failed.length, 2);

  await f.plugin.followSuccessfulUpdate({id: "automatic:one", source: "automatic"});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.filter(args => args[1] === "build-selected").length, 1);
  assert.equal(f.messages.length, 1);
});

test("TPM auto stays silent when every revision is current and reports repository failure", async t => {
  let fail = false;
  const f = await fixture(t, {
    generations: [{id: "dig", revision: SAME, state: "active"}],
    repository() {
      if (fail) throw Object.assign(new Error("network secret"), {code: "TIMED_OUT"});
      return {ids: ["dig"], candidates: [{id: "dig", revision: SAME}]};
    },
  });
  await f.run(["auto", "on"]);
  await f.plugin.followSuccessfulUpdate({id: "manual:same", source: "manual"});
  await waitFor(async () => ((await f.state.read()).pending as unknown[]).length === 0);
  assert.equal(f.messages.length, 0);
  assert.deepEqual(f.activations, []);

  fail = true;
  await f.plugin.followSuccessfulUpdate({id: "manual:failed", source: "manual"});
  await waitFor(() => f.messages.length === 1);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /仓库构建 · TIMED_OUT/);
  assert.doesNotMatch(JSON.stringify({messages: f.messages, logs: f.logs}), /network secret/);
});

test("TPM auto waits for manual work, rejects new management commands, and finishes after being disabled", async t => {
  let releaseSearch!: () => void;
  let releaseBuild!: () => void;
  const searchWaiting = new Promise<void>(resolve => { releaseSearch = resolve; });
  const buildWaiting = new Promise<void>(resolve => { releaseBuild = resolve; });
  let searchStarted!: () => void;
  let buildStarted!: () => void;
  const sawSearch = new Promise<void>(resolve => { searchStarted = resolve; });
  const sawBuild = new Promise<void>(resolve => { buildStarted = resolve; });
  const f = await fixture(t, {
    generations: [{id: "dig", revision: OLD, state: "active"}],
    async repository(args) {
      if (args[1] === "search") {
        searchStarted();
        await searchWaiting;
        return {ids: []};
      }
      buildStarted();
      await buildWaiting;
      return {ids: ["dig"], candidates: [{id: "dig", revision: NEW}]};
    },
  });
  await f.run(["auto", "on"]);
  const manual = f.run(["search"]);
  await sawSearch;
  await f.plugin.followSuccessfulUpdate({id: "manual:wait", source: "manual"});
  assert.equal(f.calls.some(args => args[1] === "build-selected"), false);
  releaseSearch();
  await manual;
  await sawBuild;
  await f.run(["install", "other"]);
  assert.match(f.edits.at(-1)!, /任务正在执行/);
  await f.run(["auto", "off"]);
  assert.equal((await f.state.read()).enabled, false);
  releaseBuild();
  await waitFor(async () => ((await f.state.read()).pending as unknown[]).length === 0);
  assert.deepEqual(f.activations, [`dig:${NEW}`]);
});

test("TPM notifyReady recovers in-flight activation and retries a pending Saved Messages notification", async t => {
  let sendingFails = true;
  const f = await fixture(t, {
    generations: [{id: "dig", revision: NEW, state: "active"}],
    repository: () => ({ids: ["dig"], candidates: [{id: "dig", revision: NEW}]}),
    send() { if (sendingFails) throw new Error("offline"); },
  });
  await f.state.update(() => ({
    schemaVersion: 1,
    enabled: false,
    pending: [{trigger: {id: "automatic:recover", source: "automatic"}, createdAt: Date.now() - 100,
      startedAt: Date.now() - 50, targets: ["dig"], updated: [], unchanged: [], failed: [],
      inFlight: {id: "dig", revision: NEW}}],
    processedTriggerIds: [],
    notifications: [],
  }));
  await f.plugin.notifyReady();
  await waitFor(async () => ((await f.state.read()).pending as unknown[]).length === 0);
  assert.deepEqual(f.activations, []);
  assert.equal(((await f.state.read()).notifications as unknown[]).length, 1);
  assert.ok(f.logs.includes("tpm.auto_notification_failed"));

  sendingFails = false;
  await f.plugin.jobs!.autoNotification.handle(f.ctx, f.scope.signal);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /已更新 · 1[\s\S]*<code>dig<\/code>/);
  assert.equal(((await f.state.read()).notifications as unknown[]).length, 0);
});
