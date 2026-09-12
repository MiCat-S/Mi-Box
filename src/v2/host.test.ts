import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, realpath, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {PluginHost, type HostOptions} from "./host";
import {definePlugin, type PluginDefinition, type MessageEnvelope, type CommandInvocation, type PluginContext} from "./sdk";
import {SelfDrainError} from "./lifecycle";
import {createHelp} from "./builtins/help";
import {HTMLParser} from "teleproto/extensions/html.js";
import {ProcessAbortedError} from "./processes";
import {SqliteStore} from "./sqlite";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

const envelope: MessageEnvelope = {id: 1, chatId: "9007199254740993", senderId: "123", outgoing: true, text: ".ping"};

async function fixture(t: TestContext, options: Partial<HostOptions> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "telebox-v2-host-")));
  const edits: {text: string; signal: AbortSignal}[] = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text, _options, signal) { edits.push({text, signal}); },
    async reply() { assert.fail("unexpected reply"); },
    async invoke() { assert.fail("unexpected RPC"); },
    async getReply() { assert.fail("unexpected read"); },
    async withClient() { assert.fail("unexpected client operation"); },
  }, ...options});
  t.after(async () => {
    const report = await host.shutdown(1000);
    assert.equal(report.completed, true, "fixture runtime must finish before directory removal");
    await rm(root, {recursive: true, force: true});
  });
  return {host, root, edits};
}

function plugin(handle: (input: CommandInvocation, context: PluginContext) => void | Promise<void>, rest: Partial<PluginDefinition> = {}) {
  return definePlugin({apiVersion: 1, id: "ping", description: "fixture", commands: {ping: {description: "fixture", handle}}, ...rest});
}

test("plugin context exposes current ready plugins as isolated snapshots", async t => {
  const {host} = await fixture(t);
  let context!: PluginContext;
  await host.load(plugin(() => {}, {setup(value) { context = value; }}));

  assert.deepEqual(context.plugins.list(), [{id: "ping", description: "fixture"}]);
  await host.load(definePlugin({apiVersion: 1, id: "other", description: "other fixture", commands: {}}));
  assert.deepEqual(context.plugins.list(), [
    {id: "ping", description: "fixture"},
    {id: "other", description: "other fixture"},
  ]);

  const snapshot = context.plugins.list() as {id: string; description: string}[];
  assert.throws(() => snapshot.push({id: "injected", description: "injected"}), TypeError);
  assert.throws(() => { snapshot[0].description = "changed"; }, TypeError);
  assert.deepEqual(host.listPlugins().map(({id, description}) => ({id, description})), [
    {id: "ping", description: "fixture"},
    {id: "other", description: "other fixture"},
  ]);

  await host.unload("other");
  assert.deepEqual(context.plugins.list(), [{id: "ping", description: "fixture"}]);
  await host.unload("ping");
  assert.throws(() => context.plugins.list(), {name: "AbortError"});
});

test("plugin context excludes plugins whose setup has not completed", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  let context!: PluginContext;
  const loading = host.load(definePlugin({
    apiVersion: 1,
    id: "pending",
    description: "pending fixture",
    commands: {},
    async setup(value) {
      context = value;
      started.resolve();
      await release.promise;
    },
  }));
  await started.promise;
  assert.deepEqual(context.plugins.list(), []);
  release.resolve();
  await loading;
  assert.deepEqual(context.plugins.list(), [{id: "pending", description: "pending fixture"}]);
});

test("host parses longest aliases without changing the original message", async t => {
  const {host, edits} = await fixture(t, {prefixes: ["!", "."], aliases: {go: "ping one", "go now": "ping two"}});
  let received: CommandInvocation | undefined;
  await host.load(plugin(async (input, context) => { received = input; await context.telegram.edit(input.message, input.args.join(" ")); }));
  const message = {...envelope, text: "!go now extra", topicId: 42};
  assert.equal(await host.dispatchPrimary(message), true);
  assert.equal(edits[0].text, "two extra");
  assert.equal(received!.message.text, "!ping two extra");
  assert.equal(received!.message.chatId, "9007199254740993");
  assert.equal(received!.message.topicId, 42);
  assert.equal(message.text, "!go now extra");
  assert.equal(await host.dispatchPrimary({...envelope, text: ".toString"}), false);
});

test("overlapping command prefixes dispatch using the longest match", async t => {
  const {host} = await fixture(t, {prefixes: [".", ".."]});
  const prefixes: string[] = [];
  await host.load(plugin(({prefix}) => { prefixes.push(prefix); }));
  assert.equal(await host.dispatchPrimary({...envelope, text: ".ping"}), true);
  assert.equal(await host.dispatchPrimary({...envelope, id: 2, text: "..ping"}), true);
  assert.deepEqual(prefixes, [".", ".."]);
  assert.deepEqual(host.configuration().prefixes, [".", ".."]);
});

test("plugin contexts expose current command routing without mutation access", async t => {
  const {host} = await fixture(t, {prefixes: ["!", "🙂"], aliases: {"go now": "ping two"}});
  let context!: PluginContext;
  await host.load(plugin((_input, current) => { context = current; }));
  await host.dispatchPrimary({...envelope, text: "!ping"});
  assert.deepEqual(context.commands.parse("🙂go now extra"), {
    prefix: "🙂", command: "ping", args: ["two", "extra"], text: "🙂ping two extra",
  });
  const route = context.commands.parse("!ping value")!;
  assert.throws(() => (route.args as string[]).push("mutate"));
  host.replacePrefixes(["$"]);
  host.replaceAliases({short: "ping current"});
  assert.equal(context.commands.parse("!ping"), undefined);
  assert.deepEqual(context.commands.parse("$short"), {
    prefix: "$", command: "ping", args: ["current"], text: "$ping current",
  });
});

test("primary admission and edited-message defaults preserve owner boundary", async t => {
  const {host} = await fixture(t);
  let calls = 0;
  await host.load(plugin(() => { calls++; }));
  assert.equal(await host.dispatchPrimary({...envelope, outgoing: false}), false);
  assert.equal(await host.dispatchPrimary({...envelope, edited: true}), false);
  assert.equal(await host.dispatchPrimary({...envelope, outgoing: false, saved: true}), true);
  assert.equal(calls, 1);
});

test("plugin help shares one renderer, paginates bodies, and performs no command work", async t => {
  const output: {kind: string; text: string}[] = [];
  const unavailable = async () => { assert.fail("help must not access Telegram data"); };
  const {host} = await fixture(t, {prefixes: ["<&"], telegram: {
    async edit(_message, text, options) { assert.equal(options.parseMode, "html"); output.push({kind: "edit", text}); },
    async reply(_message, text, options) { assert.equal(options.parseMode, "html"); output.push({kind: "reply", text}); },
    invoke: unavailable, getReply: unavailable, withClient: unavailable,
  }});
  let calls = 0;
  const sections = Array.from({length: 8}, (_, i) => `<b>分类 ${i}</b>\n<blockquote expandable>${`内容 ${i} `.repeat(80)}</blockquote>`);
  await host.load(definePlugin({apiVersion: 1, id: "guide", description: "完整指南",
    renderHelp: prefix => `<code>${prefix.replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"})[c]!)}guide</code>\n${sections.join("\n")}`,
    commands: {guide: {description: "显示指南", helpOnEmpty: true, helpArgs: ["help", "h"], handle() {calls++;}},
      action: {description: "执行操作", handle() {calls++;}}},
  }));
  for (const command of ["guide", "guide help", "guide h", "action --help"]) {
    output.length = 0;
    assert.equal(await host.dispatchPrimary({...envelope, text: `<&${command}`}), true);
    assert.ok(output.length > 1);
    assert.equal(output[0].kind, "edit");
    assert.ok(output.slice(1).every(page => page.kind === "reply"));
    assert.ok(output.every(page => page.text.length <= 3500));
    const all = output.map(page => page.text).join("\n");
    assert.ok(all.includes("&lt;&amp;guide"));
    for (const section of sections) assert.ok(all.includes(section), "every help section and body must survive pagination");
  }
  assert.equal(calls, 0);
  await host.dispatchPrimary({...envelope, text: "<&action"});
  await host.dispatchPrimary({...envelope, text: "<&action help with extra text"});
  await host.dispatchPrimary({...envelope, text: "<&action h"});
  await host.dispatchPrimary({...envelope, text: "<&action help"});
  assert.equal(calls, 4, "ordinary inputs retain command behavior");
});

test("listener subscription is independent of command owner admission", async t => {
  const {host} = await fixture(t);
  const received: MessageEnvelope[] = [];
  await host.load(plugin(() => {}, {listeners: [{handle(message) { received.push(message); }}]}));
  await host.dispatchListeners({...envelope, outgoing: false});
  await host.dispatchListeners({...envelope, outgoing: false, edited: true});
  assert.equal(received.length, 1);
  assert.equal(received[0].outgoing, false);
});

test("setup reserves commands and failure cleans the candidate", async t => {
  const {host} = await fixture(t);
  const setup = deferred();
  const started = deferred();
  const loading = host.load(plugin(() => {}, {setup: async () => { started.resolve(); await setup.promise; throw new Error("setup failed"); }}));
  const rejected = assert.rejects(loading, /setup failed/);
  await started.promise;
  assert.equal(await host.dispatchPrimary(envelope), false);
  await assert.rejects(host.load(plugin(() => {}, {id: "other"})), /Command conflict/);
  setup.resolve();
  await rejected;
  assert.equal(host.snapshot().plugins, 0);
  await host.load(plugin(() => {}));
  assert.equal(await host.dispatchPrimary(envelope), true);
});

test("host retains cancelled work and refuses new writes through its context", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  await host.load(plugin(async (_input, context) => {
    const store = context.storage.json("config.json", {count: 0});
    started.resolve();
    await release.promise;
    await assert.rejects(store.update(value => ({...value, count: value.count + 1})));
  }));
  const running = host.dispatchPrimary(envelope);
  await started.promise;
  try {
    const report = await host.shutdown(5);
    assert.equal(report.completed, false);
    assert.equal(host.snapshot().plugins, 1);
    await assert.rejects(host.load(plugin(() => {}, {id: "replacement"})));
  } finally { release.resolve(); }
  await running;
  const report = await host.shutdown(1000);
  assert.equal(report.completed, true);
  assert.equal(host.snapshot().plugins, 0);
});

test("unawaited storage operations keep the old generation reserved until settlement", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  let write!: Promise<unknown>;
  await host.load(plugin((_input, context) => {
    write = context.storage.json("config.json", {count: 0}).update(async current => {
      started.resolve();
      await release.promise;
      return {...current, count: 1};
    });
  }));
  await host.dispatchPrimary(envelope);
  await started.promise;
  const rejected = assert.rejects(write);
  try {
    const report = await host.unload("ping", 5);
    assert.equal(report?.completed, false);
    assert.equal(report?.pendingTasks, 1);
    await assert.rejects(host.load(plugin(() => {})), /already loaded/);
  } finally { release.resolve(); }
  await rejected;
  assert.equal((await host.unload("ping", 1000))?.completed, true);
  let count = -1;
  await host.load(plugin(async (_input, context) => { count = (await context.storage.json("config.json", {count: 0}).read()).count; }));
  await host.dispatchPrimary(envelope);
  assert.equal(count, 0);
});

test("cleanup waits for setup settlement during concurrent unload", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  let initialized = false;
  let cleanups = 0;
  const loading = host.load(plugin(() => {}, {
    async setup() { started.resolve(); await release.promise; initialized = true; },
    cleanup() { assert.equal(initialized, true); initialized = false; cleanups++; },
  }));
  const rejected = assert.rejects(loading);
  await started.promise;
  try {
    assert.equal((await host.unload("ping", 5))?.completed, false);
    assert.equal(cleanups, 0);
  } finally { release.resolve(); }
  await rejected;
  assert.equal(cleanups, 1);
  assert.equal(initialized, false);
  assert.equal(host.snapshot().plugins, 0);
});

test("self-unload and self-shutdown reject before disabling or aborting the host", async t => {
  const {host} = await fixture(t);
  let calls = 0;
  await host.load(plugin(async (_input, context) => {
    calls++;
    await assert.rejects(host.unload("ping"), SelfDrainError);
    await assert.rejects(host.shutdown(), SelfDrainError);
    assert.equal(context.signal.aborted, false);
  }));
  await Promise.all([host.dispatchPrimary(envelope), host.dispatchPrimary(envelope)]);
  assert.equal(calls, 2);
  assert.equal(host.listCommands().length, 1);
  assert.equal((await host.shutdown()).completed, true);
});

test("invalid shutdown and unload deadlines leave dispatch enabled", async t => {
  const {host} = await fixture(t);
  await host.load(plugin(() => {}));
  await assert.rejects(host.unload("ping", NaN), RangeError);
  await assert.rejects(host.shutdown(-1), RangeError);
  assert.equal(await host.dispatchPrimary(envelope), true);
});

test("unload and reload cycle keeps resource counts bounded", async t => {
  const {host} = await fixture(t);
  let cleanups = 0;
  for (let iteration = 0; iteration < 50; iteration++) {
    await host.load(plugin(() => {}, {setup(context) { context.tasks.add("fixture", () => { cleanups++; }); }}));
    assert.equal(await host.dispatchPrimary(envelope), true);
    assert.equal((await host.unload("ping"))?.completed, true);
    assert.equal(host.snapshot().plugins, 0);
    assert.equal(host.snapshot().commands, 0);
  }
  assert.equal(cleanups, 50);
});

test("plugin ABI and commands reject invalid exports", () => {
  assert.throws(() => definePlugin({apiVersion: 0} as unknown as PluginDefinition), /API version/);
  assert.throws(() => plugin(() => {}, {id: "../outside"}), /plugin id/);
});

test("plugin services track both owners and preserve cancellation across calls", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  let callSignal!: AbortSignal;
  let context!: PluginContext;
  await host.load(definePlugin({apiVersion: 1, id: "provider", description: "fixture", commands: {}, services: {
    translate: {description: "fixture", async handle(input, _context, signal) {
      callSignal = signal;
      started.resolve();
      await release.promise;
      return input;
    }},
  }}));
  await host.load(plugin(() => {}, {setup(value) { context = value; }}));
  assert.equal(context.services.available("provider", "translate"), true);
  assert.equal(context.services.available("provider", "toString"), false);
  const calling = context.services.call("provider", "translate", "text");
  await started.promise;
  try {
    const report = await host.unload("provider", 5);
    assert.equal(report?.completed, false);
    assert.equal(callSignal.aborted, true);
    assert.equal(context.services.available("provider", "translate"), false);
    await assert.rejects(context.services.call("provider", "translate", "not admitted"));
    assert.equal((await host.unload("ping", 5))?.completed, false);
  } finally { release.resolve(); }
  assert.equal(await calling, "text");
  assert.equal((await host.unload("provider"))?.completed, true);
  assert.equal((await host.unload("ping"))?.completed, true);
});

test("services reject pre-cancelled calls without entering the provider", async t => {
  const {host} = await fixture(t);
  let context!: PluginContext;
  await host.load(plugin(() => {}, {setup(value) { context = value; }, services: {
    test: {description: "fixture", handle() { assert.fail("pre-cancelled service admitted"); }},
  }}));
  await assert.rejects(context.services.call("ping", "test", null, AbortSignal.abort()));
});

test("plugin context runs untrusted regular expressions outside the event loop", async t => {
  const {host} = await fixture(t);
  let context!: PluginContext;
  await host.load(plugin(() => {}, {setup(value) { context = value; }}));
  assert.deepEqual(await context.regexp.test("^hello$", "HELLO", {flags: "i"}), {matched: true, timedOut: false});
  assert.deepEqual(await context.regexp.test("(a+)+$", `${"a".repeat(30)}!`), {matched: false, timedOut: true});
  await host.unload("ping");
  await assert.rejects(context.regexp.test("x", "x"), {name: "AbortError"});
});

test("plugin unload cancels queued regexp work and waits for started workers to terminate", async t => {
  const {host} = await fixture(t);
  let context!: PluginContext;
  await host.load(plugin(() => {}, {setup(value) { context = value; }}));
  const calls = Array.from({length: 8}, () => context.regexp.test("(a+)+$", `${"a".repeat(30)}!`));
  const report = await host.unload("ping", 2000);
  assert.equal(report?.completed, true);
  const results = await Promise.allSettled(calls);
  assert.equal(results.every(result => result.status === "rejected" && result.reason?.name === "AbortError"), true);
});

test("legacy SQLite access is exact, declared and scoped to the account storage root", async t => {
  const {host, root} = await fixture(t);
  const seed = new SqliteStore(path.join(root, "legacy-config.db"));
  await seed.transaction(db => {
    db.exec("CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO config(key, value) VALUES (?, ?)").run("secret", "fixture");
  });
  await seed.close();
  let context!: PluginContext;
  await host.load(plugin(() => {}, {
    legacyStorage: {sqlite: ["legacy-config.db", "missing.db"]},
    setup(value) { context = value; },
  }));
  assert.throws(() => context.storage.legacySqlite("other.db"), /not declared/);
  const legacy = context.storage.legacySqlite("legacy-config.db");
  assert.equal(await legacy.read(db => db.prepare("SELECT value FROM config WHERE key = ?").pluck().get("secret")), "fixture");
  await legacy.transaction(db => { db.prepare("UPDATE config SET value = '' WHERE key = ?").run("secret"); });
  assert.equal(await legacy.read(db => db.prepare("SELECT value FROM config WHERE key = ?").pluck().get("secret")), "");
  await assert.rejects(context.storage.legacySqlite("missing.db").transaction(() => undefined), {code: "ENOENT"});
  await assert.rejects(stat(path.join(root, "missing.db")), {code: "ENOENT"});
  await host.unload("ping");
  await assert.rejects(legacy.read(() => undefined));
});

test("declarative jobs belong to their plugin generation", async t => {
  const {host} = await fixture(t);
  for (let index = 0; index < 50; index++) {
    await host.load(plugin(() => {}, {jobs: {daily: {
      cron: "0 0 1 1 *", timeZone: "UTC", description: "fixture", handle() {},
    }}}));
    assert.equal(host.snapshot().jobs.jobs, 1);
    assert.equal((await host.unload("ping"))?.completed, true);
    assert.deepEqual(host.snapshot().jobs, {jobs: 0, running: 0});
  }
});

test("reload closes old store capabilities and uses the new generation defaults", async t => {
  const {host} = await fixture(t);
  let store!: ReturnType<PluginContext["storage"]["json"]>;
  await host.load(plugin(() => {}, {setup(context) { store = context.storage.json("not-created.json", {version: 1}); }}));
  assert.deepEqual(await store.read(), {version: 1});
  await host.unload("ping");
  await assert.rejects(store.read());
  await host.load(plugin(() => {}, {setup(context) { store = context.storage.json("not-created.json", {version: 2}); }}));
  assert.deepEqual(await store.read(), {version: 2});
});

test("SQLite capabilities preserve IDs and close with their plugin generation", async t => {
  const {host} = await fixture(t);
  let context!: PluginContext;
  await host.load(plugin(() => {}, {setup(value) { context = value; }}));
  const store = context.storage.sqlite("state.db");
  await store.transaction(db => {
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)");
    db.prepare("INSERT INTO users VALUES (?, ?)").run(9007199254740993n, "fixture");
  });
  assert.equal(await store.read(db => db.prepare("SELECT id FROM users").pluck().get()), 9007199254740993n);
  assert.throws(() => context.storage.sqlite("state.db", {readonly: true}), /options conflict/);
  assert.throws(() => context.storage.sqlite("../outside.db"), /filename/);
  assert.equal((await host.unload("ping"))?.completed, true);
  await assert.rejects(store.read(() => assert.fail("closed SQLite callback ran")));
  await host.load(plugin(() => {}, {setup(value) { context = value; }}));
  assert.equal(await context.storage.sqlite("state.db", {readonly: true}).read(db =>
    db.prepare("SELECT id FROM users").pluck().get()), 9007199254740993n);
});

test("alias snapshots update atomically and never shadow a real command", async t => {
  const {host} = await fixture(t, {aliases: {ping: 'missing', 'ping now': 'ping expanded'}});
  const received: string[][] = [];
  await host.load(plugin(({args}) => { received.push([...args]); }));
  assert.equal(await host.dispatchPrimary(envelope), true);
  assert.deepEqual(received[0], []);
  await host.dispatchPrimary({...envelope, text: '.ping now'});
  assert.deepEqual(received[1], ['expanded']);
  host.replaceAliases({go: 'ping one'});
  const snapshot = host.configuration();
  snapshot.aliases.go = 'missing';
  await host.dispatchPrimary({...envelope, text: '.go'});
  assert.deepEqual(received[2], ['one']);
  assert.throws(() => host.replaceAliases({go: ''}));
  assert.equal(host.configuration().aliases.go, 'ping one');
});

test("replacePrefixes publishes a detached snapshot while retaining plugin generations", async t => {
  const {host} = await fixture(t, {aliases: {go: "ping"}});
  let context!: PluginContext;
  let calls = 0;
  let cleanups = 0;
  await host.load(plugin(() => { calls++; }, {setup(value) { context = value; }, cleanup() { cleanups++; }}));
  const prefixes = ["!", "🙂", "!"];
  host.replacePrefixes(prefixes);
  prefixes[0] = "mutated";
  host.configuration().prefixes.push("snapshot");
  assert.deepEqual(host.configuration(), {prefixes: ["!", "🙂"], aliases: {go: "ping"}});
  assert.equal(await host.dispatchPrimary(envelope), false);
  assert.equal(await host.dispatchPrimary({...envelope, text: "🙂go"}), true);
  assert.equal(context.signal.aborted, false);
  assert.equal(cleanups, 0);
  assert.equal(calls, 1);
});

test("replacePrefixes validates atomically and refuses updates after shutdown", async t => {
  const {host} = await fixture(t);
  for (const value of [[], [""], ["a b"], ["\n"], ["\0"], [42], Array(1), null]) {
    assert.throws(() => host.replacePrefixes(value as string[]));
    assert.deepEqual(host.configuration().prefixes, ["."]);
  }
  await host.shutdown();
  assert.throws(() => host.replacePrefixes(["!"]));
  assert.deepEqual(host.configuration().prefixes, ["."]);
});

test("constructor and replacePrefixes share default, validation and deduplication semantics", async t => {
  const {host, root} = await fixture(t);
  const options: HostOptions = {storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() { return undefined; },
    async withClient() { throw new Error("unused"); },
  }};
  assert.deepEqual(host.configuration().prefixes, ["."]);
  for (const prefixes of [[], [""], ["a b"], ["\n"], ["\0"], [42], Array(1), null]) {
    assert.throws(() => new PluginHost({...options, prefixes: prefixes as string[]}));
    assert.throws(() => host.replacePrefixes(prefixes as string[]));
  }
  const initial = ["🙂", "!", "🙂"];
  const other = new PluginHost({...options, prefixes: initial});
  try {
    host.replacePrefixes(initial);
    initial.push("mutated");
    assert.deepEqual(other.configuration().prefixes, ["🙂", "!"]);
    assert.deepEqual(host.configuration().prefixes, other.configuration().prefixes);
  } finally { assert.equal((await other.shutdown()).completed, true); }
});

test("a running command can replace prefixes without aborting itself or admitted commands", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  let calls = 0;
  await host.load(plugin(async (_input, context) => {
    calls++;
    if (calls === 1) { started.resolve(); await release.promise; host.replacePrefixes(["!"]); }
    assert.equal(context.signal.aborted, false);
  }));
  const first = host.dispatchPrimary(envelope);
  await started.promise;
  const admitted = host.dispatchPrimary(envelope);
  release.resolve();
  assert.deepEqual(await Promise.all([first, admitted]), [true, true]);
  assert.equal(await host.dispatchPrimary({...envelope, text: "!ping"}), true);
  assert.equal(calls, 3);
});

test("settings bindings stop at unload and secret updates preserve untouched fields", async t => {
  const {host} = await fixture(t);
  const secret = 'fixture-secret';
  await host.load(plugin(() => {}, {settings(context) {
    const store = context.storage.json('config.json', {token: secret, enabled: true, privateField: 'preserved'});
    return {
      title: 'fixture',
      getSchema() { return [{key: 'token', label: 'token', type: 'password'}, {key: 'enabled', label: 'enabled', type: 'boolean'}]; },
      getValues: () => store.read(),
      setValues: async patch => { await store.update(current => ({...current, ...patch})); },
    };
  }}));
  const before = await host.readSettings('ping');
  assert.doesNotMatch(JSON.stringify(before), new RegExp(secret));
  await host.patchSettings('ping', {enabled: false});
  assert.equal((await host.readSettings('ping')).values.enabled, false);
  assert.equal((await host.readSettings('ping')).secretSet.token, true);
  await assert.rejects(host.patchSettings('ping', {privateField: 'replace'}));
  await host.unload('ping');
  assert.deepEqual(await host.listSettings(), []);
  await assert.rejects(host.readSettings('ping'));
});

test("helper execution is a shared account budget, lazily allocated across plugins", async t => {
  const {host} = await fixture(t, {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 3000}});
  let first!: PluginContext;
  let second!: PluginContext;
  await host.load(plugin(() => {}, {setup(context) { first = context; }}));
  await host.load(definePlugin({apiVersion: 1, id: 'second', description: 'fixture', commands: {}, setup(context) { second = context; }}));
  assert.equal(host.snapshot().processes, undefined);
  const one = first.processes.run(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("one"), 50)']);
  const two = second.processes.run(process.execPath, ['-e', 'process.stdout.write("two")']);
  await assert.rejects(second.processes.run(process.execPath, ['-e', 'process.exit(1)']), /queue is full/);
  assert.equal(host.snapshot().processes?.active, 1);
  assert.equal(host.snapshot().processes?.queued, 1);
  const results = await Promise.all([one, two]);
  assert.deepEqual(results.map(value => value.stdout.toString()), ['one', 'two']);
  assert.equal(host.snapshot().processes?.active, 0);
});

test("plugin helper declarations are bounded by host limits and enforce local queues", async t => {
  const {host} = await fixture(t, {processes: {
    concurrency: 2, queueCapacity: 4, timeoutMs: 200, maxOutputBytes: 2048,
  }});
  let context!: PluginContext;
  const declared = plugin(() => {}, {
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 150, maxOutputBytes: 1024}},
    setup(value) { context = value; },
  });
  host.preflight(declared);
  await host.load(declared);
  const one = context.processes.run(process.execPath, ["-e", "setTimeout(() => {}, 50)"]);
  const two = context.processes.run(process.execPath, ["-e", "process.stdout.write('two')"]);
  await assert.rejects(context.processes.run(process.execPath, ["-e", "process.exit(1)"]), /queue is full/);
  assert.throws(() => context.processes.run(process.execPath, ["-e", ""], {timeoutMs: 151}), /declared limit/);
  assert.throws(() => context.processes.run(process.execPath, ["-e", ""], {maxOutputBytes: 1025}), /declared limit/);
  await Promise.all([one, two]);
});

test("plugin helper declarations run independent processes up to their declared concurrency", async t => {
  const {host, root} = await fixture(t, {processes: {
    concurrency: 2, queueCapacity: 4, timeoutMs: 2000, maxOutputBytes: 2048,
  }});
  let context!: PluginContext;
  await host.load(plugin(() => {}, {
    resources: {processes: {concurrency: 2, queueCapacity: 2, timeoutMs: 1000, maxOutputBytes: 1024}},
    setup(value) { context = value; },
  }));
  const script = "const fs=require('node:fs');const [root,id,other]=process.argv.slice(1);" +
    "fs.writeFileSync(root+'/'+id,'ready');let n=0;const timer=setInterval(()=>{" +
    "if(fs.existsSync(root+'/'+other)){clearInterval(timer);process.exit(0)}" +
    "if(++n===50){clearInterval(timer);process.exit(42)}},10)";
  const [one, two] = await Promise.all([
    context.processes.run(process.execPath, ["-e", script, root, "one", "two"]),
    context.processes.run(process.execPath, ["-e", script, root, "two", "one"]),
  ]);
  assert.deepEqual([one.exitCode, two.exitCode], [0, 0]);
});

test("plugin process queues cancel callers promptly and unload waits for active process reclamation", async t => {
  const {host, root} = await fixture(t, {processes: {
    concurrency: 1, queueCapacity: 3, timeoutMs: 3000, maxOutputBytes: 2048, killGraceMs: 100,
  }});
  let context!: PluginContext;
  await host.load(plugin(() => {}, {
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 2000, maxOutputBytes: 1024}},
    setup(value) { context = value; },
  }));
  const ready = path.join(root, "active-ready");
  const active = context.processes.run(process.execPath, ["-e",
    "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],'ready');setTimeout(()=>{},2000)", ready]);
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (await stat(ready).then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(await stat(ready).then(() => true, () => false), true);
  const caller = new AbortController();
  const queued = context.processes.run(process.execPath, ["-e", "process.exit(99)"], {signal: caller.signal});
  const rejected = assert.rejects(queued, error => error instanceof ProcessAbortedError);
  caller.abort(new Error("private cancellation reason"));
  assert.equal(await Promise.race([rejected.then(() => "cancelled"),
    new Promise(resolve => setTimeout(() => resolve("waiting"), 50))]), "cancelled");

  const activeRejected = assert.rejects(active, /cancel|closed/i);
  const first = await host.unload("ping", 5);
  assert.equal(first?.completed, false);
  assert.ok((first?.pendingTasks ?? 0) > 0 || (first?.pendingResources ?? 0) > 0);
  await activeRejected;
  assert.equal((await host.unload("ping", 1000))?.completed, true);
});

test("plugin helper declarations exceeding host limits fail before setup", async t => {
  const {host} = await fixture(t, {processes: {timeoutMs: 100, maxOutputBytes: 1024}});
  let setup = false;
  const definition = plugin(() => {}, {
    resources: {processes: {timeoutMs: 101}},
    setup() { setup = true; },
  });
  assert.throws(() => host.preflight(definition), /exceeds host limit/);
  await assert.rejects(host.load(definition), /exceeds host limit/);
  assert.equal(setup, false);
  assert.equal(host.pluginState("ping"), undefined);
});

test("new command messages in one chat run independently while edits of one message stay ordered", async t => {
  const {host} = await fixture(t, {concurrency: 2});
  const started = deferred(), release = deferred();
  const events: string[] = [];
  await host.load(definePlugin({apiVersion: 1, id: "work", description: "work", commands: {
    work: {description: "long work", ignoreEdited: false, async handle({message}) {
      if (message.edited) {events.push("edited"); return;}
      events.push("started"); started.resolve(); await release.promise; events.push("finished");
    }},
    stop: {description: "control", handle() {events.push("stop");}},
  }}));
  const running = host.dispatchPrimary({...envelope, text: ".work"});
  await started.promise;
  const edited = host.dispatchPrimary({...envelope, text: ".work", edited: true});
  const next = host.dispatchPrimary({...envelope, id: 2, text: ".stop"});
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["started", "stop"]);
    assert.equal(host.snapshot().queue.queued, 1);
  } finally {release.resolve(); await Promise.all([running, edited, next]);}
  assert.deepEqual(events, ["started", "stop", "finished", "edited"]);
});

test("independent command messages retain the configured concurrency bound", async t => {
  const {host} = await fixture(t, {concurrency: 2});
  const gates = [deferred(), deferred(), deferred()];
  const entered: number[] = [];
  await host.load(plugin(async ({message}) => {entered.push(message.id); await gates[message.id - 1].promise;}));
  const work = [1, 2, 3].map(id => host.dispatchPrimary({...envelope, id}));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(entered, [1, 2]);
    assert.deepEqual(host.snapshot().queue, {active: 2, queued: 1, closed: false});
    gates[0].resolve(); await work[0];
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(entered, [1, 2, 3]);
    assert.equal(host.snapshot().queue.active, 2);
  } finally {gates.forEach(gate => gate.resolve()); await Promise.all(work);}
});

test("host admits commands and listeners only after direction, chat and forward filters pass", async t => {
  const {host} = await fixture(t);
  const calls: string[] = [];
  await host.load(definePlugin({
    apiVersion: 2, id: "classified", description: "classified",
    commands: {
      scoped: {description: "scoped", chats: ["supergroup"], handle() {calls.push("scoped");}},
      strict: {description: "strict", ignoreForwarded: true, handle() {calls.push("strict");}},
    },
    listeners: [
      {direction: "incoming", handle() {calls.push("incoming");}},
      {direction: "outgoing", chats: ["supergroup"], handle() {calls.push("outgoing-supergroup");}},
      {ignoreForwarded: true, handle() {calls.push("no-forward");}},
      {direction: "outgoing", includeSaved: true, handle() {calls.push("outgoing-or-saved");}},
    ],
  }));
  const base: MessageEnvelope = {id: 5, chatId: "1", senderId: "1", text: "hello", outgoing: false};
  await host.dispatchListeners({...base, chatType: "broadcast"});
  assert.deepEqual(calls, ["incoming", "no-forward"]);
  calls.length = 0;
  await host.dispatchListeners({...base, outgoing: true, chatType: "supergroup"});
  assert.deepEqual(calls, ["outgoing-supergroup", "no-forward", "outgoing-or-saved"]);
  calls.length = 0;
  await host.dispatchListeners({...base, forwarded: true});
  assert.deepEqual(calls, ["incoming"]);
  calls.length = 0;
  await host.dispatchListeners({...base, outgoing: true, chatType: "unknown"});
  assert.deepEqual(calls, ["no-forward", "outgoing-or-saved"], "unknown never matches a restricted chat list");
  calls.length = 0;
  await host.dispatchListeners({...base, saved: true, outgoing: false});
  assert.deepEqual(calls, ["incoming", "no-forward", "outgoing-or-saved"]);
  calls.length = 0;
  await host.dispatchListeners({...base, saved: false, outgoing: false});
  assert.deepEqual(calls, ["incoming", "no-forward"]);
  calls.length = 0;
  assert.equal(await host.dispatchPrimary({...envelope, text: ".scoped", chatType: "broadcast"}), false);
  assert.equal(await host.dispatchPrimary({...envelope, text: ".scoped", chatType: "supergroup"}), true);
  assert.equal(await host.dispatchPrimary({...envelope, text: ".strict", forwarded: true}), false);
  assert.equal(await host.dispatchPrimary({...envelope, text: ".strict"}), true);
  assert.deepEqual(calls, ["scoped", "strict"]);
});

test("listPlugins exposes frozen structured command metadata without handlers", async t => {
  const {host} = await fixture(t);
  const definition = definePlugin({apiVersion: 2, id: "catalog", description: "catalog", commands: {
    catalog: {
      description: "catalog command", args: "[x]",
      subcommands: {go: {description: "go", aliases: ["g"], args: "target", group: "Group", handle() {}}},
      handle() {},
    },
  }});
  await host.load(definition);
  const [plugin] = host.listPlugins();
  const [command] = plugin.commands;
  assert.equal(command.args, "[x]");
  const go = command.subcommands?.go;
  assert.equal(go?.description, "go");
  assert.deepEqual(go?.aliases, ["g"]);
  assert.equal(go?.group, "Group");
  assert.equal(Object.hasOwn(go ?? {}, "handle"), false);
  assert.equal(Object.hasOwn(go ?? {}, "authorize"), false);
  assert.equal(Object.isFrozen(command), true);
  assert.equal(Object.isFrozen(command.subcommands), true);
  assert.equal(Object.isFrozen(go), true);
  assert.equal(Object.isFrozen(go?.aliases), true);
  assert.equal(Object.isFrozen(definition.commands.catalog), true);
  assert.equal(Object.isFrozen(definition.commands.catalog.subcommands?.go), true);
});

test("host.load keeps one authorization and one business execution across normalization", async t => {
  const {host} = await fixture(t);
  let checks = 0;
  let business = 0;
  const definition = definePlugin({apiVersion: 2, id: "auth", description: "auth", commands: {
    auth: {
      description: "auth", defaultSubcommand: "go",
      subcommands: {go: {description: "go", handle() {business += 1;}}},
      authorize() {checks += 1;},
      handle() {business += 10;},
    },
  }});
  await host.load(definition);
  assert.equal(await host.dispatchPrimary({...envelope, text: ".auth go"}), true);
  assert.equal(await host.dispatchPrimary({...envelope, id: 2, text: ".auth"}), true);
  assert.equal(await host.dispatchPrimary({...envelope, id: 3, text: ".auth nope"}), true);
  assert.equal(checks, 3);
  assert.equal(business, 12);

  let deniedChecks = 0;
  let deniedBusiness = 0;
  await host.load(definePlugin({apiVersion: 2, id: "denied", description: "denied", commands: {
    denied: {description: "denied", authorize() {deniedChecks += 1; return false;}, handle() {deniedBusiness += 1;}},
  }}));
  assert.equal(await host.dispatchPrimary({...envelope, text: ".denied"}), true);
  assert.equal(deniedChecks, 1);
  assert.equal(deniedBusiness, 0);
});

test("declared subcommand help is served through the host and the help center without business", async t => {
  const {host, edits} = await fixture(t, {prefixes: ["."]});
  const calls: string[] = [];
  await host.load(createHelp(host));
  await host.load(definePlugin({apiVersion: 2, id: "demo", description: "demo module", commands: {
    demo: {
      description: "demo command", args: "<target>",
      subcommands: {go: {
        description: "go", args: "target", group: "Doing",
        examples: [{args: "go x"}],
        help: [{heading: "Need", body: "NEEDED_CONFIG"}], arguments: [{name: "target", description: "where"}],
        handle() {calls.push("go");},
      }},
      help: [{heading: "Root", body: "ROOTDOC"}],
      handle() {calls.push("fallback");},
    },
  }}));
  const visible = () => edits.map(({text}) => HTMLParser.parse(text)[0]).join("\n");
  edits.length = 0;
  assert.equal(await host.dispatchPrimary({...envelope, text: ".demo go --help"}), true);
  const hostHelp = visible();
  assert.match(hostHelp, /NEEDED_CONFIG/);
  assert.match(hostHelp, /\.demo go target/);
  assert.match(hostHelp, /\.demo go x/);
  assert.doesNotMatch(hostHelp, /\.demo go go x/);
  assert.doesNotMatch(hostHelp, /ROOTDOC/);
  edits.length = 0;
  assert.equal(await host.dispatchPrimary({...envelope, text: ".demo --help"}), true);
  assert.match(visible(), /ROOTDOC/);
  assert.match(visible(), /\.demo <target>/);
  edits.length = 0;
  assert.equal(await host.dispatchPrimary({...envelope, text: ".help demo go"}), true);
  const centerHelp = visible();
  assert.match(centerHelp, /NEEDED_CONFIG/);
  assert.match(centerHelp, /\.demo go target/);
  assert.match(centerHelp, /\.demo go x/);
  assert.doesNotMatch(centerHelp, /\.demo go go x/);
  assert.deepEqual(calls, [], "no help entry may run business");
  edits.length = 0;
  assert.equal(await host.dispatchPrimary({...envelope, text: ".demo go z"}), true);
  assert.deepEqual(calls, ["go"]);
});

test("metadata-only plugins render complete help through the help center without renderHelp", async t => {
  const {host, edits} = await fixture(t, {prefixes: ["."]});
  await host.load(createHelp(host));
  await host.load(definePlugin({apiVersion: 2, id: "metaonly", description: "meta only module", commands: {
    meta: {
      description: "meta command", args: "[x]",
      subcommands: {sub: {description: "sub", args: "y", help: [{heading: "Cfg", body: "CFG_NEEDED"}], handle() {}}},
      help: [{heading: "Limits", body: "META_LIMITS"}],
      handle() {},
    },
  }}));
  edits.length = 0;
  assert.equal(await host.dispatchPrimary({...envelope, text: ".help meta"}), true);
  const output = edits.map(({text}) => HTMLParser.parse(text)[0]).join("\n");
  assert.match(output, /\.meta \[x\]/);
  assert.match(output, /\.meta sub y/);
  assert.match(output, /CFG_NEEDED/);
  assert.match(output, /META_LIMITS/);
});

test("legacy apiVersion 1 plugins keep their historical help interception and business fallback", async t => {
  const {host, edits} = await fixture(t, {prefixes: ["."]});
  const calls: string[] = [];
  await host.load(definePlugin({apiVersion: 1, id: "legacy", description: "legacy", commands: {
    legacy: {description: "legacy", handle() {calls.push("business");}},
  }}));
  // No renderHelp: --help keeps going to the business handler, exactly as before.
  assert.equal(await host.dispatchPrimary({...envelope, text: ".legacy --help"}), true);
  assert.deepEqual(calls, ["business"]);
  assert.equal(await host.dispatchPrimary({...envelope, text: ".legacy plain"}), true);
  assert.deepEqual(calls, ["business", "business"]);

  const withHelp = definePlugin({apiVersion: 1, id: "withhelp", description: "withhelp",
    renderHelp: prefix => `<b>${prefix}withhelp GUIDE</b>`,
    commands: {withhelp: {description: "withhelp", helpArgs: ["help"], helpOnEmpty: true, handle() {calls.push("withhelp-business");}}}});
  await host.load(withHelp);
  for (const text of [".withhelp --help", ".withhelp help", ".withhelp"]) {
    edits.length = 0;
    assert.equal(await host.dispatchPrimary({...envelope, text}), true);
    assert.match(edits.map(({text: page}) => HTMLParser.parse(page)[0]).join("\n"), /withhelp GUIDE/, text);
  }
  assert.deepEqual(calls, ["business", "business"], "v1 renderHelp entries never run business");

  // A v2 metadata-only declaration still serves root and declared-path help with no business.
  const {host: metaHost, edits: metaEdits} = await fixture(t, {prefixes: ["."]});
  await metaHost.load(definePlugin({apiVersion: 2, id: "metaonly", description: "meta", commands: {
    meta: {description: "meta", args: "[x]", help: [{heading: "Docs", body: "META_ROOT"}],
      subcommands: {sub: {description: "sub", args: "y", help: [{heading: "Docs", body: "META_SUB"}], handle() {assert.fail("help must not run business");}}},
      handle() {assert.fail("help must not run business");}},
  }}));
  for (const text of [".meta --help", ".meta sub --help"]) {
    metaEdits.length = 0;
    assert.equal(await metaHost.dispatchPrimary({...envelope, text}), true);
    const output = metaEdits.map(({text: page}) => HTMLParser.parse(page)[0]).join("\n");
    assert.match(output, text.includes("sub") ? /META_SUB/ : /META_ROOT/, text);
  }
});

test("listPlugins exposes per-node case policy in the frozen metadata tree", async t => {
  const {host} = await fixture(t);
  await host.load(definePlugin({apiVersion: 2, id: "mixed", description: "mixed", commands: {
    mixed: {description: "mixed", subcommands: {
      sensitive: {description: "sensitive", caseSensitive: true, handle() {}},
      plain: {description: "plain", handle() {}},
    }, handle() {}},
  }}));
  const [plugin] = host.listPlugins();
  const subcommands = plugin.commands[0].subcommands;
  assert.equal(subcommands?.sensitive.caseSensitive, true);
  assert.equal(Object.hasOwn(subcommands?.plain ?? {}, "caseSensitive"), false);
  assert.equal(Object.isFrozen(subcommands?.sensitive), true);
});
