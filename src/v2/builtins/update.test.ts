import assert from "node:assert/strict";
import test from "node:test";
import {Api} from "teleproto";
import {returnBigInt} from "teleproto/Helpers";
import {messageEnvelope} from "../telegram";
import createUpdate, {selectChangelogReleases} from "./update";
import type {CommandInvocation, MessageEnvelope, PluginContext} from "../sdk";

type RunResult = {stdout?: string; stderr?: string; exitCode?: number; error?: unknown};

function channelMessage(options: Partial<ConstructorParameters<typeof Api.Message>[0]> = {}) {
  return messageEnvelope(new Api.Message({id: 1, date: 1,
    peerId: new Api.PeerChannel({channelId: returnBigInt(456)}),
    fromId: new Api.PeerChannel({channelId: returnBigInt(789)}),
    out: true, message: ".update check", ...options,
  }), {selfId: "123"});
}

function fixture(outputs: RunResult[] = [], options: {sender?: string} = {}) {
  const controller = new AbortController();
  const calls: string[][] = [];
  const edits: string[] = [];
  const stores = new Map<string, Record<string, unknown>>();
  let step = 0;
  const originalGetuid = process.getuid;
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");

  const ctx = {
    signal: controller.signal,
    tasks: {
      run: async () => Promise.resolve(),
    } as unknown as PluginContext["tasks"],
    storage: {json: <T extends Record<string, unknown>>(file: string, defaults: T) => ({
      read: async () => (stores.get(file) ?? structuredClone(defaults)) as T,
      update: async (fn: (value: T) => T | Promise<T>) => {
        const current = (stores.get(file) ?? structuredClone(defaults)) as T;
        const updated = await fn(current);
        stores.set(file, updated);
        return updated;
      },
    })},
    log: {error: () => {}, info: () => {}},
    processes: {
      async run(command: string, args?: readonly string[], _options?: {maxOutputBytes?: number; timeoutMs?: number}) {
        calls.push([command, ...(args ?? [])]);
        const current = outputs[step++];
        if (!current) return {stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0};
        if (current.error) throw current.error;
        return {stdout: Buffer.from(current.stdout ?? ""), stderr: Buffer.from(current.stderr ?? ""), exitCode: current.exitCode ?? 0};
      },
    },
    jobs: {register: () => Promise.resolve(async () => undefined)},
    services: {available: () => false, call: () => Promise.resolve(undefined)},
    http: {withResponse: async () => ({status: 200, headers: new Headers(), body: ""}),
      text: async () => "", json: async () => ({}),
    },
    files: {dataPath: "", dataDirectory: "", dataFile: () => "",
      withTemp: async (use: (directory: string, signal: AbortSignal) => Promise<unknown>) =>
        use("/tmp/update-auto-units", controller.signal)},
    telegram: {
      async edit(_message: MessageEnvelope, text: string) { edits.push(text); },
      async reply(_message: MessageEnvelope, text: string) { edits.push(text); },
      async invoke() { return undefined; },
      async getReply() { return undefined; },
      async withClient() { return undefined as never; },
    },
  } as unknown as PluginContext;

  const invocation: CommandInvocation = {
    command: "update",
    args: ["run"],
    prefix: ".",
    message: {id: 1, chatId: "123", senderId: options.sender ?? "123", outgoing: true, text: ".update"},
  };

  return {
    ctx,
    inv: invocation,
    calls,
    edits,
    restore: () => {
      if (originalDescriptor) {
        Object.defineProperty(process, "getuid", originalDescriptor);
      } else {
        Object.defineProperty(process, "getuid", {value: originalGetuid, configurable: true});
      }
    },
  };
}

test("非所有者无法发起更新", async (t) => {
  const f = fixture([], {sender: "999"});
  t.after(f.restore);
  await createUpdate(undefined, "123").commands.update.handle(f.inv, f.ctx);
  assert.match(f.edits[0], /只有账号所有者/);
  assert.equal(f.calls.length, 0);
});

test("自动更新开关安装并启用 GitHub 监测 timer", async t => {
  const f = fixture([
    {}, {}, {}, {}, {}, {},
    {stdout: "loaded"}, {stdout: "active"}, {stdout: "enabled"},
    {stdout: "2026-09-12 04:00:00 CST"},
  ]);
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 0, configurable: true});
  await createUpdate("/fixture", "123").commands.update.handle({...f.inv, args: ["auto", "on"]}, f.ctx);
  assert.deepEqual(f.calls.slice(0, 6), [
    [process.execPath, "/fixture/scripts/render-service.cjs", "/tmp/update-auto-units", "--root", "/fixture"],
    ["/usr/bin/systemd-analyze", "verify", "/tmp/update-auto-units/mibot-update-monitor.service",
      "/tmp/update-auto-units/mibot-update.timer"],
    ["/usr/bin/install", "-m", "0644", "/tmp/update-auto-units/mibot-update-monitor.service",
      "/etc/systemd/system/mibot-update-monitor.service"],
    ["/usr/bin/install", "-m", "0644", "/tmp/update-auto-units/mibot-update.timer",
      "/etc/systemd/system/mibot-update.timer"],
    ["/usr/bin/systemctl", "daemon-reload"],
    ["/usr/bin/systemctl", "enable", "--now", "mibot-update.timer"],
  ]);
  assert.match(f.edits.at(-1)!, /自动更新：<b>开启/);
  assert.match(f.edits.at(-1)!, /约 10 分钟/);
  assert.match(f.edits.at(-1)!, /2026-09-12 04:00:00 CST/);
});

test("自动更新关闭命令停用 systemd timer", async t => {
  const f = fixture([
    {stdout: "loaded"}, {},
    {stdout: "loaded"}, {stdout: "inactive"}, {stdout: "disabled"}, {stdout: ""},
  ]);
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 0, configurable: true});
  await createUpdate("/fixture", "123").commands.update.handle({...f.inv, args: ["auto", "off"]}, f.ctx);
  assert.deepEqual(f.calls.slice(0, 2), [
    ["/usr/bin/systemctl", "show", "--value", "-p", "LoadState", "mibot-update.timer"],
    ["/usr/bin/systemctl", "disable", "--now", "mibot-update.timer"],
  ]);
  assert.match(f.edits.at(-1)!, /自动更新：<b>关闭/);
});

test("非所有者不能启停自动更新", async t => {
  const f = fixture([], {sender: "999"});
  t.after(f.restore);
  await createUpdate("/fixture", "123").commands.update.handle({...f.inv, args: ["auto", "on"]}, f.ctx);
  assert.match(f.edits.at(-1)!, /只有账号所有者/);
  assert.equal(f.calls.length, 0);
});

test("本账号以频道皮套发送的更新命令通过身份检查", async t => {
  const f = fixture([
    {},
    {stdout: "0 2"},
    {stdout: '{"version":"0.7.6"}'},
    {stdout: "# Changelog\n\n## [0.7.6] - 2026-09-11\n\n- 展示更新内容。\n"},
  ]);
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 0, configurable: true});
  const envelope = channelMessage();
  assert.equal(envelope.senderId, "-100789");
  await createUpdate("/fixture", "123").commands.update.handle({...f.inv, args: ["check"], message: envelope}, f.ctx);
  assert.deepEqual(f.calls, [
    ["/usr/bin/git", "-C", "/fixture", "fetch", "origin", "main"],
    ["/usr/bin/git", "-C", "/fixture", "rev-list", "--left-right", "--count", "HEAD...refs/remotes/origin/main"],
    ["/usr/bin/git", "-C", "/fixture", "show", "refs/remotes/origin/main:package.json"],
    ["/usr/bin/git", "-C", "/fixture", "show", "refs/remotes/origin/main:CHANGELOG.md"],
  ]);
  assert.match(f.edits.at(-1)!, /发现主程序更新/);
  assert.match(f.edits.at(-1)!, /展示更新内容/);
});

test("更新说明按目标版本到原版本之间的发布顺序选择", () => {
  const markdown = [
    "# Changelog", "", "## [0.7.7] - 2026-09-12", "", "- newer", "",
    "## [0.7.6] - 2026-09-11", "", "- first", "- second", "",
    "## [0.7.5] - 2026-09-10", "", "- old",
  ].join("\n");
  assert.deepEqual(selectChangelogReleases(markdown, "0.7.5", "0.7.7"), [
    {version: "0.7.7", entries: ["newer"]},
    {version: "0.7.6", entries: ["first", "second"]},
  ]);
  assert.deepEqual(selectChangelogReleases(markdown, "0.7.7", "0.7.7"), []);
  assert.deepEqual(selectChangelogReleases(markdown, "missing", "0.7.6"), [
    {version: "0.7.6", entries: ["first", "second"]},
  ]);
});

test("皮套身份支持默认更新与 now 命令", async t => {
  const f = fixture();
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 1000, configurable: true});
  for (const args of [[], ["run"], ["now"]]) {
    await createUpdate(undefined, "123").commands.update.handle({...f.inv, args,
      message: channelMessage()}, f.ctx);
    assert.match(f.edits.at(-1)!, /当前进程 UID=1000/);
  }
});

test("他人频道消息、转发与缺失所有者配置不能通过皮套更新授权", async t => {
  const f = fixture();
  t.after(f.restore);
  const channel = channelMessage();
  for (const [message, owner] of [
    [{...channel, outgoing: false}, "123"],
    [{...channel, forwarded: true}, "123"],
    [channelMessage({editDate: 2}), "123"],
    [channelMessage({post: true}), "123"],
    [{...channel, raw: undefined}, "123"],
    [channel, ""],
    [{...channel, senderId: undefined}, "123"],
  ] as const) {
    await createUpdate(undefined, owner).commands.update.handle({...f.inv, message}, f.ctx);
    assert.match(f.edits.at(-1)!, /只有账号所有者/);
  }
  assert.equal(f.calls.length, 0);
});

test("账号本人转发的私聊消息不能触发更新", async t => {
  const f = fixture();
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 0, configurable: true});
  await createUpdate("/fixture", "123").commands.update.handle({
    ...f.inv, message: {...f.inv.message, forwarded: true},
  }, f.ctx);
  assert.match(f.edits.at(-1)!, /只有账号所有者/);
  assert.equal(f.calls.length, 0);
});

test("非 root 环境会给出明确的权限提示", async (t) => {
  const f = fixture([]);
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 1000, configurable: true});
  await createUpdate(undefined, "123").commands.update.handle(f.inv, f.ctx);
  assert.match(f.edits.at(-1)!, /当前进程 UID=1000/);
  assert.match(f.edits.at(-1)!, /无法直接发起 systemd 服务更新/);
  assert.equal(f.calls.length, 0);
});

test("更新服务未正确加载会直接提示修复", async (t) => {
  const f = fixture([
    // 默认加载状态检查：LoadState 等 7 个字段
    {stdout: "error"}, {stdout: "inactive"}, {stdout: "not-found"}, {stdout: "dead"}, {stdout: "no"},
    {stdout: "unknown"}, {stdout: "unavailable"},
  ]);
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 0, configurable: true});
  await createUpdate(undefined, "123").commands.update.handle(f.inv, f.ctx);
  assert.match(f.edits.at(-1)!, /MiBot 更新失败/);
});

test("启动服务后若立即失败，立即返回失败并给出日志定位建议", async (t) => {
  const f = fixture([
    {stdout: "loaded"}, {stdout: "inactive"}, {stdout: "enabled"}, {stdout: "dead"}, {stdout: "yes"},
    {stdout: "/etc/systemd/system/mibot-update.service"}, {stdout: "success"},
    {stdout: "failed"},
    {stdout: "active"},
    {stdout: "loaded"},
    {stdout: "inactive"},
    {stdout: "failed"},
    {stdout: "dead"},
    {stdout: "/etc/systemd/system/mibot-update.service"},
  ]);
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 0, configurable: true});
  await createUpdate(undefined, "123").commands.update.handle(f.inv, f.ctx);
  assert.match(f.edits.at(-1)!, /MiBot 更新失败|启动后立即退出/);
  assert.match(f.edits.at(-1)!, /journalctl -u mibot-update.service/);
});
