import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PluginHost} from "../host";
import {HTMLParser} from "teleproto/extensions/html.js";
import createMemory from "./memory";
import createSudo from "./sudo";
import createVersion from "./version";
import createPing from "./ping";
import createPrivacy from "./privacy";
import {createHelp} from "./help";
import {renderCommandHelp} from "../commands";
import {createPrefix} from "./prefix";
import {getIpPrivacy, setIpPrivacy} from "../ip-privacy";

async function fixture(t: TestContext, telegram: Partial<ConstructorParameters<typeof PluginHost>[0]["telegram"]> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-b2-")));
  const edits: string[] = [];
  const host = new PluginHost({storageRoot: root, prefixes: ["."], logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply(_message, text) {edits.push(text);},
    async invoke() {throw new Error("unexpected RPC");}, async getReply() {return undefined;},
    async withClient() {throw new Error("unexpected client");}, ...telegram,
  }});
  await host.load(createHelp(host, "1"));
  t.after(async () => {
    assert.equal((await host.shutdown(2000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  const visible = () => edits.map(page => HTMLParser.parse(page)[0]).join("\n");
  const send = (text: string, extra: Record<string, unknown> = {}) =>
    host.dispatchPrimary({id: 1, chatId: "1", senderId: "1", outgoing: true, text, ...extra});
  return {host, root, edits, visible, send};
}

test("memory subcommands keep default view, toggles, threshold validation and help isolation", async t => {
  const f = await fixture(t);
  await f.host.load(createMemory());
  await f.send(".memory");
  assert.match(f.visible(), /内存状态/);
  await f.send(".memory on");
  assert.match(f.edits.at(-1)!, /自动内存保护已开启/);
  await f.send(".memory set rss 768");
  assert.match(f.edits.at(-1)!, /已设置 rss 上限为 768 MB/);
  const stored = JSON.parse(await fs.readFile(path.join(f.root, "memory", "config.json"), "utf8"));
  assert.equal(stored.enabled, true);
  assert.equal(stored.rss, 768);
  for (const input of [".memory set rss abc", ".memory set nope 1", ".memory bogus"]) {
    await f.send(input);
    assert.match(f.edits.at(-1)!, /用法/, input);
  }
  f.edits.length = 0;
  await f.send(".memory help");
  assert.match(f.visible(), /内存状态与阈值监测/);
  await f.send(".memory --help");
  assert.match(f.visible(), /监测设置/);
});

test("sudo standard subcommands preserve owner boundary and listing", async t => {
  const original = process.env.TB_OWNER_ID;
  process.env.TB_OWNER_ID = "1";
  t.after(() => {if (original === undefined) delete process.env.TB_OWNER_ID; else process.env.TB_OWNER_ID = original;});
  const f = await fixture(t);
  await f.host.load(createSudo());
  await f.send(".sudo add 123456789");
  assert.match(f.edits.at(-1)!, /sudo 用户已添加.*123456789/);
  await f.send(".sudo add 123456789");
  await f.send(".sudo ls");
  assert.match(f.edits.at(-1)!, /sudo 用户[\s\S]*123456789/);
  await f.send(".sudo del 123456789");
  assert.match(f.edits.at(-1)!, /sudo 用户已删除/);
  await f.send(".sudo list");
  assert.match(f.edits.at(-1)!, /暂无授权用户/);
  await f.send(".sudo add abc");
  assert.match(f.edits.at(-1)!, /用户 ID/);
  f.edits.length = 0;
  await f.send(".sudo add 42", {senderId: "2"});
  assert.match(f.edits.at(-1)!, /只有 owner 可以管理 sudo 白名单/);
  f.edits.length = 0;
  await f.send(".sudo help");
  assert.match(f.visible(), /高级命令用户白名单/);
});

test("version keeps its PID detail while ver omits it and both share generated help", async t => {
  const f = await fixture(t);
  await f.host.load(createVersion(f.root));
  await f.send(".version");
  assert.match(f.edits.at(-1)!, /PID:/);
  assert.doesNotMatch(f.edits.at(-1)!, /不显示 PID/);
  await f.send(".ver");
  assert.doesNotMatch(f.edits.at(-1)!, /PID:/);
  f.edits.length = 0;
  await f.send(".help version");
  assert.match(f.visible(), /不显示 PID/);
});

test("ping help never reaches Telegram or the network", async t => {
  const f = await fixture(t);
  await f.host.load(createPing());
  f.edits.length = 0;
  assert.equal(await f.send(".ping help"), true);
  assert.match(f.visible(), /域名/);
  assert.equal(await f.send(".ping --help"), true);
  assert.match(f.visible(), /Telegram API/);
});

test("privacy keeps case-sensitive syntax and rejects malformed hide/mask without writing", async t => {
  const original = getIpPrivacy();
  t.after(() => setIpPrivacy(original));
  const f = await fixture(t);
  await f.host.load(createPrivacy("1"));
  const stored = () => fs.readFile(path.join(f.root, "privacy", "ip.json"), "utf8").then(JSON.parse);
  const before = JSON.stringify(getIpPrivacy());
  for (const input of [".privacy ip hide extra", ".privacy IP hide", ".privacy ip HIDE", ".privacy ip MASK 2"]) {
    await f.send(input);
    assert.match(f.edits.at(-1)!, /用法/, input);
    assert.equal(JSON.stringify(getIpPrivacy()), before, `${input} must not change state`);
  }
  await f.send(".privacy ip mask 2 4");
  assert.match(f.edits.at(-1)!, /IPv4末尾2段、IPv6末尾4段打码/);
  assert.equal((await stored()).ipv4Segments, 2);
  const afterMask = JSON.stringify(getIpPrivacy());
  for (const input of [".privacy ip mask 0", ".privacy ip mask 5", ".privacy ip mask 2 9", ".privacy ip mask 2 4 5", ".privacy ip hide extra"]) {
    await f.send(input);
    assert.match(f.edits.at(-1)!, /用法/, input);
    assert.equal(JSON.stringify(getIpPrivacy()), afterMask, `${input} must not change state`);
  }
  await f.send(".privacy ip mask 1");
  assert.match(f.edits.at(-1)!, /IPv4末尾1段/);
  await f.send(".privacy");
  assert.match(f.edits.at(-1)!, /IP显示：/);
  const owned = JSON.stringify(getIpPrivacy());
  await f.send(".privacy ip hide", {senderId: "2"});
  assert.match(f.edits.at(-1)!, /只有账号本人可以修改IP显示设置/);
  await f.send(".privacy ip hide", {forwarded: true});
  assert.match(f.edits.at(-1)!, /只有账号本人可以修改IP显示设置/);
  assert.equal(JSON.stringify(getIpPrivacy()), owned, "denied owners/forwards must not change state");
});

test("privacy examples expand relative to the parent path and stay executable", async t => {
  const original = getIpPrivacy();
  t.after(() => setIpPrivacy(original));
  const privacy = createPrivacy("1").commands.privacy;
  const root = renderCommandHelp("privacy", privacy, {prefix: "."});
  assert.match(root, /\.privacy ip mask 2 4/);
  assert.doesNotMatch(root, /\.privacy ip ip/);
  const focused = renderCommandHelp("privacy", privacy, {prefix: ".", path: ["ip", "mask"]});
  assert.match(focused, /\.privacy ip mask 2 4/);
  assert.doesNotMatch(focused, /\.privacy ip ip/);
  const f = await fixture(t);
  await f.host.load(createPrivacy("1"));
  await f.send(".privacy ip mask 2 4");
  assert.match(f.edits.at(-1)!, /IPv4末尾2段、IPv6末尾4段打码/);
});

test("help name help entries are read-only while name set/reset keep their boundary", async t => {
  const f = await fixture(t);
  const branding = path.join(f.root, "help", "branding.json");
  for (const input of [".help name --help", ".help help name", ".help name"]) {
    f.edits.length = 0;
    await f.send(input);
    assert.match(f.visible(), /显示名|名称/, input);
  }
  await assert.rejects(fs.readFile(branding, "utf8"), "help entries must not write the display name");
  f.edits.length = 0;
  await f.send(".help name Cat <Bot> & Co");
  assert.match(f.visible(), /显示名已设为/);
  assert.match(await fs.readFile(branding, "utf8"), /Cat <Bot> & Co/);
  f.edits.length = 0;
  await f.send(".help NAME x");
  assert.match(f.visible(), /未找到/);
  await f.send(".help name reset");
  assert.match(f.visible(), /显示名已设为/);
});

test("prefix help comes from the shared declaration for both entries without mutating prefixes", async t => {
  const f = await fixture(t);
  let persists = 0;
  await f.host.load(createPrefix(f.host, {async persist() {persists += 1;}}));
  const before = [...f.host.configuration().prefixes];
  f.edits.length = 0;
  await f.send(".prefix help");
  const direct = f.visible();
  assert.match(direct, /前缀管理/);
  assert.match(direct, /prefix set \[前缀...\]/);
  f.edits.length = 0;
  await f.send(".help prefix");
  const center = f.visible();
  assert.match(center, /前缀管理|查看、设置、追加或删除命令前缀/);
  assert.match(center, /prefix set \[前缀...\]/);
  assert.deepEqual(f.host.configuration().prefixes, before);
  assert.equal(persists, 0, "help must not persist");
});
