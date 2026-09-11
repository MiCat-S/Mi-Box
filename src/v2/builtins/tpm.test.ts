import {ArtifactError} from "../artifacts";
import test from "node:test";
import assert from "node:assert/strict";
import {HTMLParser} from "teleproto/extensions/html.js";
import {Api} from "teleproto";
import {returnBigInt} from "teleproto/Helpers";
import {messageEnvelope} from "../telegram";
import createTpm from "./tpm";
import {createHelp} from "./help";
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
    operations.push(`activate:${id}`); const existing = generations.find(g => g.id === id);
    if (existing) existing.state = "active"; else generations.push({id, state: "active"});
  }, async remove(id: string) {operations.push(`remove:${id}`); const index = generations.findIndex(g => g.id === id); if (index >= 0) generations.splice(index, 1);}};
  const ctx = {signal: new AbortController().signal, log: {error: (_event: string, fields: unknown) => failures.push(fields)},
    telegram: {async edit(_m: unknown, text: string) {edits.push(text);},
    async reply(_m: unknown, text: string) {edits.push(text);}},
    processes: {async run(_command: string, args: string[]) {
      operations.push(args[1]);
      return {stdout: Buffer.from(JSON.stringify(args[1] === "search" ? {ids: ["ai", "gt", "dig"]} :
        args[1] === "build-selected" ? {ids: ["ai", "gt", "dig", "weather"], candidates:
          args.slice(2).map(id => ({id, revision: "a".repeat(64)}))} :
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

test("TPM help entries share detailed bounded guidance without running plugin operations", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-tpm-help-")));
  const prefix = "<&";
  const sent: string[] = [];
  const errors: unknown[] = [];
  let snapshots = 0;
  const host = new PluginHost({storageRoot: root, prefixes: [prefix],
    logger: {info() {}, error: (...args) => {errors.push(args);}},
    telegram: {
      async edit(_message, value) {sent.push(value);}, async reply(_message, value) {sent.push(value);},
      async invoke() {assert.fail("help must not invoke Telegram RPC");}, async getReply() {return undefined;},
      async withClient() {assert.fail("help must not access the Telegram client");},
    },
  });
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  const releases = {
    snapshot: () => {snapshots++; return {generations: [{id: "nezha", state: "active"}]};},
    async activate() {assert.fail("help must not install plugins");},
    async remove() {assert.fail("help must not remove plugins");},
  } as unknown as PluginReleases;
  await host.load(createTpm(host, releases, root, "1"));
  await host.load(createHelp(host, "1"));
  for (const input of ["tpm", "tpm help", "tpm h", "tpm --help", "help tpm"]) {
    sent.length = 0;
    assert.equal(await host.dispatchPrimary({id: 1, chatId: "1", senderId: "1", outgoing: true, text: prefix + input}), true);
    const output = sent.map(page => {
      const [value, entities] = HTMLParser.parse(page);
      assert.ok(page.length <= 3500, `oversized help page for ${input}`);
      assert.ok(entities.length <= 90, `too many entities for ${input}`);
      return value;
    }).join("\n");
    for (const heading of ["查看插件与帮助", "安装插件", "更新插件", "卸载插件", "参数与操作说明", "常见提示"]) {
      assert.ok(output.includes(heading), `${input} must include ${heading}`);
    }
    for (const args of ["search [关键词]", "list", "install 插件名", "install all", "update 插件名", "update all", "remove 插件名", "remove all", "i nezha", "rm nezha", "help"]) {
      assert.ok(output.includes(`${prefix}tpm ${args}`), `${input} must retain ${args} and the active prefix`);
    }
    // Every all-variant keeps its own accurate semantics instead of reusing the single-target text.
    assert.ok(output.includes("安装仓库中全部可用扩展，跳过已加载插件和默认模块。"), `${input}: install all semantics`);
    assert.ok(output.includes("更新全部已安装扩展；需要补装仓库中的其他插件时，使用 install all。"), `${input}: update all semantics`);
    assert.ok(output.includes("卸载全部已安装扩展，保留各插件配置数据；默认模块继续由程序管理。"), `${input}: remove all semantics`);
    assert.match(output, /查看完整帮助；直接发送 tpm，或使用 h、--help 也可查看。/);
    assert.ok(output.includes(`${prefix}tpm i nezha`), `${input}: alias example stays a valid root command`);
    assert.equal(output.includes(`${prefix}tpm install i nezha`), false, `${input}: focus must not double-prepend the subcommand`);
    assert.match(output, /保留插件配置数据/);
    assert.match(output, /Mi-Box-Plugins/);
    assert.equal(snapshots, 0, "help must not read or alter installed state");
  }
  assert.deepEqual(errors, []);
  sent.length = 0;
  await host.dispatchPrimary({id: 2, chatId: "1", senderId: "1", outgoing: true, text: prefix + "tpm list"});
  assert.equal(snapshots, 1);
  assert.match(sent.join("\n"), /nezha/);
  assert.doesNotMatch(sent.join("\n"), /参数与操作说明/);
  // Declared subcommand help is served by both entries without touching state.
  for (const input of ["tpm install --help", "help tpm install"]) {
    sent.length = 0;
    assert.equal(await host.dispatchPrimary({id: 3, chatId: "1", senderId: "1", outgoing: true, text: prefix + input}), true);
    const output = sent.map(page => HTMLParser.parse(page)[0]).join("\n");
    assert.ok(output.includes(`${prefix}tpm install 插件名`), input);
    assert.ok(output.includes("安装仓库中全部可用扩展，跳过已加载插件和默认模块。"), input);
    assert.ok(output.includes(`${prefix}tpm i nezha`), input);
    assert.equal(output.includes(`${prefix}tpm install i nezha`), false, input);
    assert.doesNotMatch(output, /参数与操作说明/, input);
  }
  assert.equal(snapshots, 1, "subcommand help must not read installed state");
});

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

test("TPM installed list sorts and deduplicates into a compact expandable three-column message", async () => {
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
  assert.equal(sent.length, 1);
  sent.forEach((html, index) => {
    assert.ok(html.length < 3500);
    const [visible] = HTMLParser.parse(html);
    assert.match(html, /<blockquote expandable/);
    assert.ok(!visible.includes("1/1 页"));
    assert.ok(visible.includes("<tpm search"));
  });
  const lines = sent.flatMap(html => [...html.matchAll(/<code>(plugin_[^<]+)<\/code>/g)]
    .flatMap(match => match[1].trim().split(/\s+/)));
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

test("TPM preserves artifact activation diagnostics without exposing internal paths", async () => {
  for (const code of ["FORMAT", "BOUNDARY", "LIMIT", "INTEGRITY", "IO", "BUSY", "LOAD", "FACTORY", "IDENTITY", "RELEASED"] as const) {
    const f = fixture();
    f.releases.activate = async () => {throw new ArtifactError(code);};
    await f.run(["update", "dig"]);
    assert.match(f.edits.at(-1)!, new RegExp(`activate / ${code}`));
    assert.deepEqual(f.failures, [{stage: "activate", code}]);
  }
});

test("TPM update all selects only installed extensions in one build and preserves defaults", async () => {
  const f = fixture();
  f.generations.push({id: "dig", state: "active"}, {id: "weather", state: "active"});
  const run = f.ctx.processes.run;
  f.ctx.processes.run = async (command, args) => {
    assert.deepEqual(args.slice(1), ["build-selected", "dig", "weather"]);
    return run(command, args);
  };
  await f.run(["update", "all"], "1", channelMessage());
  assert.deepEqual(f.operations, ["build-selected", "activate:dig", "activate:weather"]);
  assert.equal(f.generations.length, 2);
  assert.match(HTMLParser.parse(f.edits.at(-1)!)[0], /批量更新完成[\s\S]*成功 2 · 跳过 0 · 失败 0/);
});

test("TPM update all continues missing, build and activation failures without removing installed entries", async () => {
  const f = fixture();
  for (const id of ["absent", "bad", "conflict", "dig"]) f.generations.push({id, state: "active"});
  f.ctx.processes.run = async () => ({stdout: Buffer.from(JSON.stringify({ids: ["bad", "conflict", "dig"], candidates: [
    {id: "absent", error: "NOT_AVAILABLE"}, {id: "bad", error: "BUILD"},
    {id: "conflict", revision: "a".repeat(64)}, {id: "dig", revision: "a".repeat(64)},
  ]}))});
  const activate = f.releases.activate;
  f.releases.activate = async id => {
    if (id === "conflict") throw Object.assign(new Error("private-activation-path"), {code: "ACTIVATE"});
    await activate(id);
  };
  await f.run(["update", "all"]);
  assert.deepEqual(f.operations, ["activate:dig"]);
  assert.equal(f.generations.length, 4);
  const visible = HTMLParser.parse(f.edits.at(-1)!)[0];
  assert.match(visible, /成功 1 · 跳过 0 · 失败 3/);
  assert.match(visible, /absent · NOT_AVAILABLE/);
  assert.match(visible, /bad · BUILD/);
  assert.match(visible, /conflict · ACTIVATE/);
  assert.doesNotMatch(JSON.stringify({edits: f.edits, failures: f.failures}), /private-activation-path/);
});

test("TPM remove all snapshots installed entries, continues failures and needs no repository", async () => {
  const f = fixture();
  for (const id of ["bad", "dig", "weather"]) f.generations.push({id, state: "active"});
  const remove = f.releases.remove;
  f.releases.remove = async id => {
    if (id === "bad") throw Object.assign(new Error("private-cleanup-path"), {code: "STOP"});
    await remove(id);
  };
  await f.run(["rm", "all"], "1", channelMessage());
  assert.deepEqual(f.operations, ["remove:dig", "remove:weather"]);
  assert.deepEqual(f.generations, [{id: "bad", state: "active"}]);
  const visible = HTMLParser.parse(f.edits.at(-1)!)[0];
  assert.match(visible, /批量卸载完成[\s\S]*成功 2 · 跳过 0 · 失败 1/);
  assert.match(visible, /bad · STOP/);
  assert.match(visible, /配置数据已保留/);
  assert.doesNotMatch(JSON.stringify({edits: f.edits, failures: f.failures}), /private-cleanup-path/);
});

test("TPM bulk update and remove reject unprivileged requests and skip empty selections", async () => {
  for (const action of ["update", "remove", "rm"]) {
    const f = fixture();
    await f.run([action, "all"], "2");
    assert.match(f.edits.at(-1)!, /只有账号所有者/);
    await f.run([action, "all"]);
    assert.match(f.edits.at(-1)!, /没有已安装/);
    assert.deepEqual(f.operations, []);
  }
});

test("TPM bulk update and remove stop on cancellation and retain the busy guard", async () => {
  for (const action of ["update", "remove"]) {
    const f = fixture();
    const controller = new AbortController(); f.ctx.signal = controller.signal;
    f.generations.push({id: "dig", state: "active"}, {id: "weather", state: "active"});
    const method = action === "update" ? "activate" : "remove";
    const operation = f.releases[method];
    f.releases[method] = async id => {
      await f.run(["remove", "all"]);
      assert.match(f.edits.at(-1)!, /正在执行/);
      await operation(id); controller.abort();
    };
    await f.run([action, "all"]);
    assert.deepEqual(f.operations, action === "update" ? ["build-selected", "activate:dig"] : ["remove:dig"]);
    assert.doesNotMatch(f.edits.join(""), /批量(?:更新|卸载)完成/);
  }
});

test("TPM update all rejects extra or missing candidates before changing plugins", async () => {
  for (const ids of [["dig", "newplugin"], [], ["newplugin"]]) {
    const f = fixture(); f.generations.push({id: "dig", state: "active"});
    f.ctx.processes.run = async () => ({stdout: Buffer.from(JSON.stringify({ids, candidates: ids.map(id => ({id, revision: "a".repeat(64)}))}))});
    await f.run(["update", "all"]);
    assert.deepEqual(f.operations, []);
    assert.match(f.edits.at(-1)!, /插件操作失败/);
  }
});

test("TPM batch results show failures before expandable success details", async () => {
  const f = fixture();
  for (let index = 0; index < 115; index++) f.generations.push({id: `plugin_${String(index).padStart(3, "0")}`, state: "active"});
  const activate = f.releases.activate;
  f.releases.activate = async id => {
    if (id === "plugin_114") throw Object.assign(new Error("failed"), {code: "LOAD"});
    await activate(id);
  };
  await f.run(["update", "all"]);
  const result = f.edits.at(-1)!;
  const visible = HTMLParser.parse(result)[0];
  assert.match(visible, /成功 114 · 跳过 0 · 失败 1/);
  assert.ok(result.indexOf("plugin_114") < result.indexOf("<blockquote"));
  assert.ok(result.length <= 3500);
  assert.ok(HTMLParser.parse(result)[1].length <= 90);
  for (const {id} of f.generations) assert.ok(visible.includes(id));
  assert.equal(f.edits.filter(message => message.includes("批量更新完成")).length, 1);
});

test("TPM compact lists retain long names across bounded expandable pages", async () => {
  const f = fixture();
  const ids = Array.from({length: 220}, (_, index) => `plugin_${String(index).padStart(3, "0")}_${"x".repeat(50)}`);
  ids.forEach(id => f.generations.push({id, state: "active"}));
  await f.run(["list"]);
  assert.ok(f.edits.length > 1);
  const visible = f.edits.map((html, index) => {
    const [body, entities] = HTMLParser.parse(html);
    assert.ok(html.length <= 3500);
    assert.ok(entities.length <= 90);
    assert.ok(body.endsWith(`${index + 1}/${f.edits.length} 页`));
    assert.doesNotMatch(body, /超出单条消息|不支持的格式/);
    return body;
  }).join("\n");
  for (const id of ids) assert.equal(visible.split(id).length - 1, 1);
});

test("TPM matches Chinese descriptions and case-insensitive names and descriptions", async () => {
  const f = fixture();
  f.ctx.processes.run = async () => ({stdout: Buffer.from(JSON.stringify({
    ids: ["weather", "git_PR", "dig", "constructor", "ai", "gt"],
    descriptions: {dig: "DNS 记录查询", git_PR: "GitHub 拉取请求", weather: "天气", ai: "DNS 默认模块"},
    descriptionsAvailable: true,
  }))});
  for (const [query, expected] of [["记录", "dig — DNS 记录查询"], ["dns", "dig — DNS 记录查询"], ["GIT_pr", "git_PR — GitHub 拉取请求"]]) {
    f.edits.length = 0;
    await f.run(["search", query]);
    const output = f.edits.slice(1).map(page => HTMLParser.parse(page)[0]).join("\n");
    assert.ok(output.includes(expected));
    assert.doesNotMatch(output, /默认模块|weather —/);
  }
  f.edits.length = 0;
  await f.run(["search"]);
  const output = f.edits.slice(1).map(page => HTMLParser.parse(page)[0]).join("\n");
  assert.match(output, /constructor — 暂无描述/);
  assert.ok(output.indexOf("constructor —") < output.indexOf("dig —"));
  assert.ok(output.indexOf("dig —") < output.indexOf("git_PR —"));
  assert.ok(output.indexOf("git_PR —") < output.indexOf("weather —"));
});

test("TPM retains name matches and conflict warnings when descriptions are unavailable", async () => {
  const f = fixture();
  f.ctx.processes.run = async () => ({stdout: Buffer.from(JSON.stringify({
    ids: ["GIT_pr", "git_PR", "dig"], descriptions: {}, descriptionsAvailable: false,
    collisions: [["GIT_pr", "git_PR"]],
  }))});
  await f.run(["search", "git"]);
  const output = f.edits.slice(1).map(page => HTMLParser.parse(page)[0]).join("\n");
  assert.match(output, /GIT_pr — 暂无描述/);
  assert.match(output, /git_PR — 暂无描述/);
  assert.match(output, /描述索引不可用，当前仅按名称搜索/);
  assert.match(output, /仓库存在大小写冲突组/);
  assert.doesNotMatch(output, /dig —/);
});

test("TPM renders every description in bounded escaped pages", async () => {
  const f = fixture();
  const ids = Array.from({length: 160}, (_, i) => `plugin_${String(i).padStart(3, "0")}`);
  const descriptions = Object.fromEntries(ids.map(id => [id, `<b>${id}</b> & ${"描述".repeat(60)}`]));
  f.ctx.processes.run = async () => ({stdout: Buffer.from(JSON.stringify({ids: [...ids].reverse(), descriptions, descriptionsAvailable: true}))});
  await f.run(["search"]);
  const pages = f.edits.slice(1);
  assert.ok(pages.length > 1);
  const output = pages.map((page, i) => {
    const [plain, entities] = HTMLParser.parse(page);
    assert.ok(plain.length <= 4096);
    assert.ok(entities.length <= 100);
    assert.ok(plain.endsWith(`${i + 1}/${pages.length} 页`));
    return plain;
  }).join("\n");
  for (const id of ids) assert.ok(output.includes(`${id} — ${descriptions[id]}`), id);
});

test("TPM installs a selected list once and preserves installed-target update semantics", async () => {
  const f = fixture();
  const ids = 'aban acron aff autochangename bgp bulk_delete checkapi clean_member dc dig dme duckduckgo encode exec ids ip keyword portball rate re'.split(' ');
  f.generations.push({id: 'dig', state: 'active'});
  f.ctx.processes.run = async (_exe, args) => {
    f.operations.push(args[1]);
    assert.deepEqual(args.slice(2), ids);
    return {stdout: Buffer.from(JSON.stringify({ids, candidates: ids.map(id => ({id, revision: 'a'.repeat(64)}))}))};
  };
  await f.run(['i', ...ids, 'aban']);
  assert.deepEqual(f.operations, ['build-selected', ...ids.map(id => `activate:${id}`)]);
  assert.match(HTMLParser.parse(f.edits.at(-1)!)[0], /成功 20 · 跳过 0 · 失败 0/);
});

test("TPM selected batches report partial failures and skip default modules", async () => {
  const f = fixture();
  f.ctx.processes.run = async (_exe, args) => {
    assert.deepEqual(args.slice(1), ['build-selected', 'dig', 'missing', 'weather']);
    return {stdout: Buffer.from(JSON.stringify({ids: ['dig', 'weather'], candidates: [
      {id: 'dig', revision: 'a'.repeat(64)}, {id: 'weather', error: 'BUILD'}, {id: 'missing', error: 'NOT_FOUND'},
    ]}))};
  };
  await f.run(['install', 'AI', 'dig', 'missing', 'weather']);
  assert.deepEqual(f.operations, ['activate:dig']);
  const visible = HTMLParser.parse(f.edits.at(-1)!)[0];
  assert.match(visible, /成功 1 · 跳过 1 · 失败 2/);
  assert.match(visible, /weather · BUILD/);
  assert.match(visible, /missing · NOT_AVAILABLE/);
});

test("TPM updates and removes selected plugins, deduplicating canonical names", async () => {
  const f = fixture();
  await f.run(['update', 'dig', 'weather']);
  assert.deepEqual(f.operations, ['build-selected', 'activate:dig', 'activate:weather']);
  f.operations.length = 0;
  await f.run(['remove', 'dig', 'DIG', 'weather', 'missing', 'ai']);
  assert.deepEqual(f.operations, ['remove:dig', 'remove:weather']);
  assert.match(HTMLParser.parse(f.edits.at(-1)!)[0], /成功 2 · 跳过 1 · 失败 1/);
});

test("TPM rejects mixed all and invalid names before any operation", async () => {
  const f = fixture();
  for (const names of [[], ['all', 'dig'], ['dig', '../other'], ['dig', 'a,b']]) {
    await f.run(['install', ...names]);
    assert.match(f.edits.at(-1)!, /有效的插件名/);
  }
  assert.deepEqual(f.operations, []);
});

test("TPM selected batches reject unrequested repository candidates", async () => {
  const f = fixture();
  f.ctx.processes.run = async () => ({stdout: Buffer.from(JSON.stringify({ids: ['dig', 'weather', 'unexpected'], candidates: [
    {id: 'dig', revision: 'a'.repeat(64)}, {id: 'unexpected', revision: 'a'.repeat(64)},
  ]}))});
  await f.run(['install', 'dig', 'weather']);
  assert.deepEqual(f.operations, []);
  assert.match(f.edits.at(-1)!, /插件操作失败/);
});

test("TPM selected batch cancellation stops further activation", async () => {
  const f = fixture(), controller = new AbortController();
  f.ctx.signal = controller.signal;
  const activate = f.releases.activate;
  f.releases.activate = async id => {await activate(id); controller.abort();};
  await f.run(['install', 'dig', 'weather']);
  assert.deepEqual(f.operations, ['build-selected', 'activate:dig']);
  assert.doesNotMatch(f.edits.join(''), /批量安装完成/);
});
