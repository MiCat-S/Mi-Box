import test from "node:test";
import assert from "node:assert/strict";
import {HTMLParser} from "teleproto/extensions/html.js";
import {Api} from "teleproto";
import {returnBigInt} from "teleproto/Helpers";
import {messageEnvelope} from "../telegram";
import createTpm from "./tpm";
import {PluginHost} from "../host";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {PluginReleases} from "../releases";
import type {MessageEnvelope, PluginContext} from "../sdk";

function fixture() {
  const edits: string[] = [];
  const operations: string[] = [];
  const failures: unknown[] = [];
  const generations: {id: string; state: string}[] = [];
  const host = {
    pluginState: (id: string) => ["ai", "gt"].includes(id) || generations.some(g => g.id === id) ? "active" : undefined,
    listPlugins: () => ["ai", "gt", ...generations.map(g => g.id)].map(id => ({id})),
  };
  const releases = {snapshot: () => ({generations}), async activate(id: string) {
    operations.push(`activate:${id}`); generations.push({id, state: "active"});
  }, async remove(id: string) {operations.push(`remove:${id}`); generations.splice(0);}};
  const ctx = {signal: new AbortController().signal, log: {error: (_event: string, fields: unknown) => failures.push(fields)},
    telegram: {async edit(_m: unknown, text: string) {edits.push(text);},
    async reply(_m: unknown, text: string) {edits.push(text);}},
    processes: {async run(_command: string, args: string[]) {
      operations.push(args[1]);
      return {stdout: Buffer.from(JSON.stringify(args[1] === "search" ? {ids: ["ai", "gt", "dig"]} :
        args[1] === "build-all" ? {ids: ["ai", "gt", "dig", "weather"], candidates:
          ["dig", "weather"].filter(id => !args.slice(2).includes(id)).map(id => ({id, revision: "a".repeat(64)}))} :
          {id: args[2], revision: "a".repeat(64)}))};
    }}};
  const plugin = createTpm(host as unknown as PluginHost, releases as unknown as PluginReleases, "/fixture", "1");
  const run = (args: string[], senderId = "1", message: Partial<MessageEnvelope> = {}) => plugin.commands.tpm.handle({
    command: "tpm", prefix: ".", args, message: {id: 1, chatId: "1", senderId, text: ".tpm", outgoing: true, ...message},
  }, ctx as unknown as PluginContext);
  return {run, edits, operations, generations, ctx, failures, releases};
}

function channelMessage(options: Partial<ConstructorParameters<typeof Api.Message>[0]> = {}) {
  return messageEnvelope(new Api.Message({id: 71, date: 1,
    peerId: new Api.PeerChannel({channelId: returnBigInt(456)}),
    fromId: new Api.PeerChannel({channelId: returnBigInt(789)}),
    out: true, message: ".tpm install dig", ...options,
  }), {selfId: "1"});
}

test("TPM accepts fresh group send-as installs and rejects other channel messages", async () => {
  const f = fixture();
  for (const message of [channelMessage({out: false}), channelMessage({post: true}),
    channelMessage({editDate: 2}), {...channelMessage(), forwarded: true}]) {
    await f.run(["install", "dig"], "1", message);
    assert.deepEqual(f.operations, []);
  }
  await f.run(["install", "dig"], "1", channelMessage());
  assert.deepEqual(f.operations, ["build", "activate:dig"]);
});

test("TPM install all builds once, installs remaining plugins and skips loaded modules", async () => {
  const f = fixture();
  f.generations.push({id: "dig", state: "active"});
  await f.run(["install", "all"], "1", channelMessage());
  assert.deepEqual(f.operations, ["build-all", "activate:weather"]);
  assert.match(HTMLParser.parse(f.edits.at(-1)!)[0], /成功 1 · 跳过 3 · 失败 0/);
  await f.run(["i", "all"]);
  assert.deepEqual(f.operations, ["build-all", "activate:weather", "build-all"]);
  assert.match(HTMLParser.parse(f.edits.at(-1)!)[0], /成功 0 · 跳过 4 · 失败 0/);
});

test("TPM batch continues after build and activation failures and reports safe results", async () => {
  const f = fixture();
  f.ctx.processes.run = async () => ({stdout: Buffer.from(JSON.stringify({ids: ["badbuild", "conflict", "dig"], candidates: [
    {id: "badbuild", error: "BUILD"}, {id: "conflict", revision: "a".repeat(64)}, {id: "dig", revision: "a".repeat(64)},
  ]}))});
  const activate = f.releases.activate;
  f.releases.activate = async id => {
    if (id === "conflict") throw Object.assign(new Error("private-conflict-path"), {code: "CONFLICT"});
    await activate(id);
  };
  await f.run(["install", "all"]);
  assert.deepEqual(f.operations, ["activate:dig"]);
  const visible = HTMLParser.parse(f.edits.at(-1)!)[0];
  assert.match(visible, /成功 1 · 跳过 0 · 失败 2/);
  assert.match(visible, /badbuild · BUILD/);
  assert.match(visible, /conflict · CONFLICT/);
  assert.doesNotMatch(JSON.stringify({edits: f.edits, failures: f.failures}), /private-conflict-path/);
});

test("TPM batch cancellation preserves completed installs and stops further activation", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.ctx.signal = controller.signal;
  const activate = f.releases.activate;
  f.releases.activate = async id => {await activate(id); controller.abort();};
  await f.run(["install", "all"]);
  assert.deepEqual(f.operations, ["build-all", "activate:dig"]);
  assert.doesNotMatch(f.edits.join(""), /批量安装完成/);
});

test("TPM batch retains the busy guard and denies non-owner requests before repository work", async () => {
  const f = fixture();
  await f.run(["install", "all"], "2");
  assert.deepEqual(f.operations, []);
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => {started = resolve;});
  f.ctx.processes.run = async () => {started(); await new Promise<void>(resolve => {finish = resolve;});
    return {stdout: Buffer.from(JSON.stringify({ids: [], candidates: []}))};};
  const pending = f.run(["install", "all"]);
  await ready;
  await f.run(["install", "dig"]);
  assert.match(f.edits.at(-1)!, /正在执行/);
  finish();
  await pending;
});
test("TPM preserves all renderer pages and numbers final messages for long searches", async () => {
  const f = fixture();
  const query = "&".repeat(700);
  await f.run(["search", query]);
  const pages = f.edits.slice(1);
  assert.ok(pages.length > 1);
  const visible = pages.map((page, index) => {
    const [value, entities] = HTMLParser.parse(page);
    assert.ok(value.length <= 4096);
    assert.ok(entities.length <= 100);
    assert.ok(value.endsWith(`${index + 1}/${pages.length} 页`));
    return value;
  }).join("\n");
  assert.equal([...visible].filter(character => character === "&").join(""), query);
  assert.match(visible, /没有匹配结果/);
  assert.match(visible, /tpm install 插件名/);
});

test("TPM stops sending additional pages after cancellation", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.ctx.signal = controller.signal;
  const original = f.ctx.telegram.edit;
  f.ctx.telegram.edit = async (message, text) => {
    await original(message, text);
    if (f.edits.length === 2) controller.abort();
  };
  await f.run(["search", "&".repeat(700)]);
  assert.equal(f.edits.length, 2);
});
test("TPM installs and removes an extension, and lists actual loaded selections", async () => {
  const f = fixture();
  await f.run(["install", "dig"]);
  await f.run(["list"]);
  assert.match(f.edits.at(-1)!, /dig/);
  await f.run(["remove", "dig"]);
  assert.deepEqual(f.operations, ["build", "activate:dig", "remove:dig"]);
});
test("TPM protects defaults and rejects unprivileged or invalid install requests", async () => {
  const f = fixture();
  await f.run(["install", "dig"], "2");
  await f.run(["install", "../dig"]);
  await f.run(["remove", "ai"]);
  assert.deepEqual(f.operations, []);
});
test("TPM searches V2 entries in the plugin repository and excludes defaults", async () => {
  const f = fixture();
  await f.run(["search"]);
  assert.match(f.edits.at(-1)!, /dig/);
  assert.doesNotMatch(f.edits.at(-1)!, /ai|gt/);
});
test("TPM reports failure stage and known code without exposing private process errors", async () => {
  const f = fixture();
  f.ctx.processes.run = async () => {throw Object.assign(new Error("secret-token"), {code: "TIMED_OUT"});};
  await f.run(["install", "dig"]);
  assert.match(f.edits.at(-1)!, /repository \/ TIMED_OUT/);
  assert.doesNotMatch(f.edits.join(""), /secret-token/);
  assert.deepEqual(f.failures, [{stage: "repository", code: "TIMED_OUT"}]);
});

test("TPM repository search runs through the real host process limits", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-tpm-")));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(path.join(root, "scripts/plugin-repository.cjs"),
    'console.log(JSON.stringify({ids:["dig","subinfo"], ...(process.argv[2] === "build-all" ? {candidates:["dig","subinfo"].map(id=>({id,revision:"a".repeat(64)}))} : {})}));\n');
  const edits: string[] = [];
  const host = new PluginHost({storageRoot: path.join(root, "assets"), processes: {timeoutMs: 180000},
    logger: {info() {}, error() {}},
    telegram: {async edit(_message, text) {edits.push(text);}, async reply() {},
      async invoke() {throw new Error("unexpected");}, async getReply() {return undefined;},
      async withClient() {throw new Error("unexpected");}}});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  const activated: string[] = [];
  const releases = {snapshot: () => ({generations: []}), async activate(id: string) {activated.push(id);}} as unknown as PluginReleases;
  await host.load(createTpm(host, releases, root, "1"));
  await host.dispatchPrimary({id: 1, chatId: "1", senderId: "1", outgoing: true, text: ".tpm search"});
  assert.match(edits.at(-1)!, /dig/);
  assert.match(edits.at(-1)!, /subinfo/);
  assert.doesNotMatch(edits.at(-1)!, /失败/);
  await host.dispatchPrimary({...channelMessage(), text: ".tpm install all"});
  assert.deepEqual(activated, ["dig", "subinfo"]);
  assert.match(HTMLParser.parse(edits.at(-1)!)[0], /成功 2 · 跳过 0 · 失败 0/);
});

test("TPM installed list sorts, deduplicates, escapes and paginates at 24 entries", async () => {
  const sent: string[] = [];
  const context = {
    signal: new AbortController().signal,
    telegram: {
      edit: async (_message: unknown, text: string) => {sent.push(text);},
      reply: async (_message: unknown, text: string) => {sent.push(text);},
    },
  } as unknown as PluginContext;
  const ids = Array.from({length: 50}, (_, index) => `plugin_${String(index).padStart(2, "0")}`);
  const releases = {snapshot: () => ({generations: [...ids, ids[0]].reverse().map(id => ({id, state: "active"}))})};
  const plugin = createTpm({} as Parameters<typeof createTpm>[0], releases as unknown as PluginReleases, "/unused", "123");
  await plugin.commands.tpm.handle({args: [], prefix: "<", command: "tpm", message: {senderId: "other"}} as never, context);
  assert.equal(sent.length, 3);
  sent.forEach((html, index) => {
    assert.ok(html.length < 3500);
    const [visible] = HTMLParser.parse(html);
    assert.ok(visible.includes(`${index + 1}/3 页`));
    assert.ok(visible.includes("<tpm search"));
  });
  const lines = sent.flatMap(html => HTMLParser.parse(html)[0].split("\n")
    .filter(line => line.startsWith("• ")).map(line => line.slice(2)));
  assert.deepEqual(lines, ids);
});

test("TPM failure feedback exposes only the stage code and safe next step", async () => {
  const sent: string[] = [];
  const context = {
    signal: new AbortController().signal,
    telegram: {edit: async (_message: unknown, text: string) => {sent.push(text);}},
    processes: {run: async () => {throw Object.assign(new Error("private internal payload"), {code: "EXIT_FAILED"});}},
    log: {error: () => {}},
  } as unknown as PluginContext;
  const plugin = createTpm({} as Parameters<typeof createTpm>[0], {} as PluginReleases, "/unused", "123");
  await plugin.commands.tpm.handle({args: ["search"], prefix: ".", command: "tpm",
    message: {senderId: "123", outgoing: true}} as never, context);
  const [visible] = HTMLParser.parse(sent.at(-1)!);
  assert.match(visible, /阶段：仓库访问/);
  assert.match(visible, /repository \/ EXIT_FAILED/);
  assert.match(visible, /node scripts\/plugin-repository.cjs search/);
  assert.ok(!visible.includes("private internal payload"));
});
