import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Api} from "teleproto";
import {returnBigInt} from "teleproto/Helpers";
import {PluginHost, type HostOptions} from "./host";
import {messageEnvelope} from "./telegram";
import {definePlugin, STRUCTURED_PLUGIN_API_VERSION, type CommandDispatchResult, type PluginContext} from "./sdk";

const SELF = "1";

/** A real outgoing Api.Message the authenticated account would get back from sendMessage. */
function sent(text: string, channel = 100): Api.Message {
  return new Api.Message({id: 7, out: true, message: text,
    peerId: new Api.PeerChannel({channelId: returnBigInt(channel)})});
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

interface FixtureOptions extends Partial<HostOptions> { blockEdit?: boolean }

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "telebox-v2-dispatch-")));
  const edits: string[] = [];
  const host = new PluginHost({
    storageRoot: root,
    logger: {info() {}, error() {}},
    selfId: SELF,
    envelope: message => {
      if (!(message instanceof Api.Message)) throw new TypeError("Command dispatch requires a Telegram message");
      return messageEnvelope(message, {selfId: SELF});
    },
    telegram: {
      async edit(_message, text, _options, signal) {
        if (options.blockEdit) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {once: true});
          });
          return;
        }
        signal.throwIfAborted();
        edits.push(text);
      },
      async reply() {},
      async invoke() {},
      async getReply() { return undefined; },
      async withClient<T>(): Promise<T> { throw new Error("unexpected client operation"); },
    },
    ...options,
  });
  t.after(async () => {
    const report = await host.shutdown(1000);
    assert.equal(report.completed, true, "dispatch fixture must shut down cleanly");
    await rm(root, {recursive: true, force: true});
  });
  return {host, edits};
}

const callerEnvelope = (text: string) => ({id: 1, chatId: "5", senderId: SELF, outgoing: true, text});

test("dispatch inside a command lane runs inline on the single executor without deadlock", async t => {
  const {host} = await fixture(t, {concurrency: 1});
  let targetRuns = 0;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {note: {description: "note", handle() { targetRuns += 1; }}}}));
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller",
    commands: {call: {description: "call", async handle(_invocation, context) { await context.commands.dispatch(sent(".note")); }}}}));
  assert.equal(await host.dispatchPrimary(callerEnvelope(".call")), true);
  assert.equal(targetRuns, 1);
});

test("dispatch from a scheduled job lane runs inline with a single executor slot", async t => {
  const {host} = await fixture(t, {concurrency: 1});
  let targetRuns = 0;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {note: {description: "note", handle() { targetRuns += 1; }}}}));
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller", commands: {},
    jobs: {tick: {cron: "* * * * * *", description: "tick",
      async handle(context) { await context.commands.dispatch(sent(".note")); }}}}));
  const deadline = Date.now() + 5000;
  while (targetRuns === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(targetRuns >= 1, "the scheduled job must dispatch without deadlocking");
});

test("dispatch uses the current prefix and alias routing", async t => {
  const {host} = await fixture(t, {prefixes: ["."], aliases: {n: "note"}});
  let targetRuns = 0;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {note: {description: "note", handle() { targetRuns += 1; }}}}));
  let context!: PluginContext;
  await host.load(definePlugin({apiVersion: 1, id: "probe", description: "probe", commands: {},
    setup(value) { context = value; }}));
  assert.deepEqual(await context.commands.dispatch(sent(".n")),
    {status: "dispatched", command: "note", pluginId: "target"});
  assert.equal(targetRuns, 1);
});

test("a real non-self inbound message is ignored and a forged object is rejected", async t => {
  const {host} = await fixture(t);
  let targetRuns = 0;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {note: {description: "note", handle() { targetRuns += 1; }}}}));
  let context!: PluginContext;
  await host.load(definePlugin({apiVersion: 1, id: "probe", description: "probe", commands: {},
    setup(value) { context = value; }}));
  const incoming = new Api.Message({id: 9, out: false, message: ".note",
    peerId: new Api.PeerChannel({channelId: returnBigInt(100)}),
    fromId: new Api.PeerUser({userId: returnBigInt(2)})});
  assert.deepEqual(await context.commands.dispatch(incoming), {status: "ignored", reason: "not-self"});
  await assert.rejects(context.commands.dispatch({outgoing: true, text: ".note"}),
    (error: unknown) => error instanceof TypeError);
  assert.equal(targetRuns, 0);
});

test("dispatch honours command chat filters", async t => {
  const {host} = await fixture(t);
  let targetRuns = 0;
  await host.load(definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "target", description: "target",
    commands: {secret: {description: "secret", chats: ["private"], handle() { targetRuns += 1; }}}}));
  let context!: PluginContext;
  await host.load(definePlugin({apiVersion: 1, id: "probe", description: "probe", commands: {},
    setup(value) { context = value; }}));
  assert.deepEqual(await context.commands.dispatch(sent(".secret")), {status: "ignored", reason: "filtered"});
  assert.equal(targetRuns, 0);
});

test("dispatch honours command authorization", async t => {
  const {host} = await fixture(t);
  let targetRuns = 0;
  await host.load(definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "target", description: "target",
    commands: {secret: {description: "secret", authorize() { return false; }, handle() { targetRuns += 1; }}}}));
  let context!: PluginContext;
  await host.load(definePlugin({apiVersion: 1, id: "probe", description: "probe", commands: {},
    setup(value) { context = value; }}));
  assert.deepEqual(await context.commands.dispatch(sent(".secret")),
    {status: "dispatched", command: "secret", pluginId: "target"});
  assert.equal(targetRuns, 0, "authorize denial must stop the business handler");
});

test("target handler exceptions propagate to the dispatching caller", async t => {
  const {host} = await fixture(t);
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {boom: {description: "boom", handle() { throw new Error("boom"); }}}}));
  let caught: unknown;
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller",
    commands: {call: {description: "call", async handle(_invocation, context) {
      try { await context.commands.dispatch(sent(".boom")); } catch (error) { caught = error; }
    }}}}));
  await host.dispatchPrimary(callerEnvelope(".call"));
  assert.equal(caught instanceof Error ? caught.message : undefined, "boom");
});

test("a completed dispatch never touches the target plugin's long-lived jobs", async t => {
  const {host} = await fixture(t);
  let targetRuns = 0;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {note: {description: "note", handle() { targetRuns += 1; }}},
    jobs: {keep: {cron: "0 0 0 1 1 *", description: "keep", handle() {}}}}));
  let context!: PluginContext;
  await host.load(definePlugin({apiVersion: 1, id: "probe", description: "probe", commands: {},
    setup(value) { context = value; }}));
  assert.equal(host.snapshot().jobs.jobs, 1);
  assert.deepEqual(await context.commands.dispatch(sent(".note")),
    {status: "dispatched", command: "note", pluginId: "target"});
  assert.equal(host.snapshot().jobs.jobs, 1, "target jobs must survive a completed dispatch");
  assert.equal(host.pluginState("target"), "active");
  assert.equal(targetRuns, 1);
});

test("nested dispatch is bounded by the recursion limit", async t => {
  const {host} = await fixture(t);
  let runs = 0;
  let ignored: CommandDispatchResult | undefined;
  await host.load(definePlugin({apiVersion: 1, id: "looper", description: "looper",
    commands: {loop: {description: "loop", async handle(_invocation, context) {
      runs += 1;
      const result = await context.commands.dispatch(sent(".loop"));
      if (result.status === "ignored") ignored = result;
    }}}}));
  await host.dispatchPrimary(callerEnvelope(".loop"));
  assert.ok(runs >= 2 && runs <= 6, `bounded recursion, got ${runs}`);
  assert.deepEqual(ignored, {status: "ignored", reason: "recursion-limit"});
});

test("a queued dispatch that never started is cancelled with AbortError on caller unload", async t => {
  const {host} = await fixture(t, {concurrency: 1});
  let targetRuns = 0;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {note: {description: "note", handle() { targetRuns += 1; }}}}));
  const blocker = deferred();
  await host.load(definePlugin({apiVersion: 1, id: "blocker", description: "blocker",
    commands: {block: {description: "block", async handle() { await blocker.promise; }}}}));
  const blocking = host.dispatchPrimary(callerEnvelope(".block"));
  let queued!: Promise<CommandDispatchResult>;
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller", commands: {},
    setup(context) {
      queued = context.commands.dispatch(sent(".note"));
      void queued.catch(() => undefined);
    }}));
  const report = await host.unload("caller", 1000);
  assert.equal(report?.completed, true);
  await assert.rejects(queued, (error: unknown) => (error as {name?: string})?.name === "AbortError");
  assert.equal(targetRuns, 0);
  blocker.resolve();
  await blocking;
});

test("unloading the caller aborts the dispatched managed operation but not the target plugin", async t => {
  const {host} = await fixture(t, {blockEdit: true});
  let caught: unknown;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {wait: {description: "wait", async handle(invocation, context) {
      await context.telegram.edit(invocation.message, "waiting");
    }}}}));
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller",
    commands: {call: {description: "call", async handle(_invocation, context) {
      try { await context.commands.dispatch(sent(".wait")); } catch (error) { caught = error; }
    }}}}));
  const running = host.dispatchPrimary(callerEnvelope(".call"));
  await new Promise(resolve => setTimeout(resolve, 20));
  const report = await host.unload("caller", 1000);
  assert.equal(report?.completed, true);
  assert.equal((caught as {name?: string})?.name, "AbortError");
  assert.equal(host.pluginState("target"), "active", "the target plugin must survive caller cancellation");
  await running;
});

test("unloading the target aborts the dispatched handler", async t => {
  const {host} = await fixture(t, {blockEdit: true});
  let caught: unknown;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {wait: {description: "wait", async handle(invocation, context) {
      await context.telegram.edit(invocation.message, "waiting");
    }}}}));
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller",
    commands: {call: {description: "call", async handle(_invocation, context) {
      try { await context.commands.dispatch(sent(".wait")); } catch (error) { caught = error; }
    }}}}));
  const running = host.dispatchPrimary(callerEnvelope(".call"));
  await new Promise(resolve => setTimeout(resolve, 20));
  const report = await host.unload("target", 1000);
  assert.equal(report?.completed, true);
  assert.equal((caught as {name?: string})?.name, "AbortError");
  assert.equal(host.pluginState("caller"), "active");
  await running;
});

test("a registered job leaves the dispatch context and keeps working after the caller unloads", async t => {
  const {host} = await fixture(t);
  const observations: boolean[] = [];
  let storageReads = 0;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {arm: {description: "arm", async handle(_invocation, context) {
      await context.jobs.register("later", {cron: "* * * * * *", description: "later"}, async () => {
        observations.push(context.signal.aborted);
        await context.storage.json("probe.json", {n: 0}).read();
        storageReads += 1;
      });
    }}}}));
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller",
    commands: {call: {description: "call", async handle(_invocation, context) {
      await context.commands.dispatch(sent(".arm"));
    }}}}));
  assert.equal(await host.dispatchPrimary(callerEnvelope(".call")), true);
  assert.equal((await host.unload("caller", 1000))?.completed, true);
  const deadline = Date.now() + 4000;
  while (storageReads === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(storageReads >= 1, "the target job must still run managed operations");
  assert.ok(observations.length > 0 && observations.every(value => value === false),
    `job context must not inherit the caller signal: ${observations.join(",")}`);
  assert.equal(host.pluginState("target"), "active");
});

test("a registered job starts dispatches at depth zero", async t => {
  const {host} = await fixture(t);
  let loopRuns = 0;
  let resolveJob!: () => void;
  const jobDone = new Promise<void>(resolve => { resolveJob = resolve; });
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {
      arm: {description: "arm", async handle(_invocation, context) {
        const dispose = await context.jobs.register("later", {cron: "* * * * * *", description: "later"}, async () => {
          await dispose();
          await context.commands.dispatch(sent(".loop"));
          resolveJob();
        });
      }},
      loop: {description: "loop", async handle(_invocation, context) {
        loopRuns += 1;
        await context.commands.dispatch(sent(".loop"));
      }},
    }}));
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller",
    commands: {call: {description: "call", async handle(_invocation, context) {
      await context.commands.dispatch(sent(".arm"));
    }}}}));
  await host.dispatchPrimary(callerEnvelope(".call"));
  await Promise.race([jobDone, new Promise(resolve => setTimeout(resolve, 4000))]);
  assert.equal(loopRuns, 4, `job dispatch must start at depth zero, got ${loopRuns}`);
});

test("a cancelled managed run never starts and the dispatch rejects", async t => {
  const {host} = await fixture(t);
  const ready = deferred(), gate = deferred();
  let counter = 0;
  let outcome: unknown, caught: unknown;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {wait: {description: "wait", async handle(_invocation, context) {
      ready.resolve();
      await gate.promise;
      counter += await context.tasks.run("late", () => 1);
    }}}}));
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller",
    commands: {call: {description: "call", async handle(_invocation, context) {
      try { outcome = await context.commands.dispatch(sent(".wait")); } catch (error) { caught = error; }
    }}}}));
  const running = host.dispatchPrimary(callerEnvelope(".call"));
  await ready.promise;
  const unload = host.unload("caller", 1000);
  await new Promise(resolve => setTimeout(resolve, 10));
  gate.resolve();
  assert.equal((await unload)?.completed, true);
  await running;
  assert.equal(counter, 0, "the cancelled managed run must not start");
  assert.equal((caught as {name?: string})?.name, "AbortError");
  assert.equal(outcome, undefined);
});

test("a handler that resolves after cancellation still rejects the dispatch", async t => {
  const {host} = await fixture(t);
  const ready = deferred(), gate = deferred();
  let outcome: unknown, caught: unknown;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {wait: {description: "wait", async handle() {
      ready.resolve();
      await gate.promise;
    }}}}));
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller",
    commands: {call: {description: "call", async handle(_invocation, context) {
      try { outcome = await context.commands.dispatch(sent(".wait")); } catch (error) { caught = error; }
    }}}}));
  const running = host.dispatchPrimary(callerEnvelope(".call"));
  await ready.promise;
  const unload = host.unload("caller", 1000);
  await new Promise(resolve => setTimeout(resolve, 10));
  gate.resolve();
  assert.equal((await unload)?.completed, true);
  await running;
  assert.equal((caught as {name?: string})?.name, "AbortError");
  assert.equal(outcome, undefined);
});

test("synchronous signal reads see the combined dispatch cancellation", async t => {
  const {host} = await fixture(t);
  const ready = deferred(), gate = deferred();
  let error: unknown;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {wait: {description: "wait", async handle(_invocation, context) {
      ready.resolve();
      await gate.promise;
      try { context.files.dataPath("probe.txt"); } catch (caught) { error = caught; }
    }}}}));
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller",
    commands: {call: {description: "call", async handle(_invocation, context) {
      await context.commands.dispatch(sent(".wait")).catch(() => undefined);
    }}}}));
  const running = host.dispatchPrimary(callerEnvelope(".call"));
  await ready.promise;
  const unload = host.unload("caller", 1000);
  await new Promise(resolve => setTimeout(resolve, 10));
  gate.resolve();
  await unload;
  await running;
  assert.equal((error as {name?: string})?.name, "AbortError");
});

test("a cancelled dispatch cannot register a new long-lived job", async t => {
  const {host} = await fixture(t);
  const ready = deferred(), gate = deferred();
  let registerError: unknown, outcome: unknown, caught: unknown;
  await host.load(definePlugin({apiVersion: 1, id: "target", description: "target",
    commands: {go: {description: "go", async handle(_invocation, context) {
      ready.resolve();
      await gate.promise;
      try {
        await context.jobs.register("late", {cron: "0 0 0 1 1 *", description: "late"}, () => undefined);
      } catch (error) { registerError = error; }
    }}}}));
  await host.load(definePlugin({apiVersion: 1, id: "caller", description: "caller",
    commands: {call: {description: "call", async handle(_invocation, context) {
      try { outcome = await context.commands.dispatch(sent(".go")); } catch (error) { caught = error; }
    }}}}));
  const running = host.dispatchPrimary(callerEnvelope(".call"));
  await ready.promise;
  const unload = host.unload("caller", 1000);
  await new Promise(resolve => setTimeout(resolve, 10));
  gate.resolve();
  assert.equal((await unload)?.completed, true);
  await running;
  assert.equal((registerError as {name?: string})?.name, "AbortError");
  assert.equal((caught as {name?: string})?.name, "AbortError");
  assert.equal(outcome, undefined);
  assert.equal(host.snapshot().jobs.jobs, 0, "a cancelled dispatch must not create new jobs");
});
