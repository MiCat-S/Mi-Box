import assert from "node:assert/strict";
import test from "node:test";
import {HTMLParser} from "teleproto/extensions/html.js";
import {getBotName, setBotName} from "../branding";
import type {PluginContext, CommandInvocation} from "../sdk";
import createStatus, {
  formatBytes, formatDuration, parseOsRelease, parseSwap, parseSystemMemory, renderStatus, waterline,
  type StatusSnapshot,
} from "./status";

const snapshot: StatusSnapshot = {
  applicationVersion: "0.7.3",
  revision: "abcdef1",
  teleprotoVersion: "1.229.0",
  nodeVersion: "v24.20.0",
  hostname: "edge-01<&>",
  operatingSystem: "Ubuntu 24.04.4 LTS",
  platform: "linux",
  arch: "arm64",
  kernel: "Linux 6.17.0",
  locale: "zh-TW",
  pid: 123,
  processUptime: 61,
  hostUptime: 28 * 86400 + 6 * 3600 + 52 * 60,
  processMemory: {rss: 128 * 1024 * 1024, heapUsed: 32 * 1024 * 1024, heapTotal: 64 * 1024 * 1024},
  systemMemory: {used: 7 * 1024 ** 3, total: 16 * 1024 ** 3},
  swap: {used: 384 * 1024 ** 2, total: 1024 * 1024 ** 2},
  disk: {used: 10 * 1024 ** 3, total: 20 * 1024 ** 3},
  cpu: {systemPercent: 1.58, processPercent: 0.35, logicalCores: 4},
  loadAverage: [0, 1.25, 2.5],
  networkInterfaces: ["eth0", "wg<&>", "en1", "en2", "en3"],
  scanDurationMs: 184,
};

function fixture() {
  const sent: string[] = [];
  const processCalls: string[][] = [];
  const context = {
    signal: new AbortController().signal,
    telegram: {edit: async (_message: unknown, value: string) => { sent.push(value); }},
    processes: {run: async (_command: string, args: string[]) => {
      processCalls.push(args);
      return {stdout: Buffer.from("abcdef1\n"), stderr: Buffer.alloc(0), exitCode: 0};
    }},
  } as unknown as PluginContext;
  const invocation = {args: [], prefix: ".", message: {senderId: "other"}} as unknown as CommandInvocation;
  return {sent, processCalls, context, invocation};
}

test("status renders a compact dashboard from a fixed snapshot", () => {
  const [visible] = HTMLParser.parse(renderStatus(snapshot));
  assert.match(visible, /📡 MiBot 运行面板/);
  assert.match(visible, /🟢 在线 · 本次采样 184ms/);
  for (const section of ["🧩 核心", "🖥 主机", "💓 资源水位", "⏱ 时间"]) assert.ok(visible.includes(section));
  assert.match(visible, /0\.7\.3 \(abcdef1\)/);
  assert.match(visible, /Node\.js v24\.20\.0 · Teleproto 1\.229\.0/);
  assert.match(visible, /系统 1\.6% · MiBot 0\.3% · 4 线程/);
  assert.match(visible, /▰▰▰▰▱▱▱▱ 50\.0% · 10\.00 GiB \/ 20\.00 GiB/);
  assert.match(visible, /28天 6小时 52分钟/);
  assert.match(visible, /0\.00 \/ 1\.25 \/ 2\.50/);
  assert.match(visible, /eth0 · wg<&> · en1 · en2 · 另 1 个/);
  assert.match(renderStatus(snapshot), /edge-01&lt;&amp;&gt;/);
  assert.match(renderStatus(snapshot), /wg&lt;&amp;&gt;/);
});

test("status command uses the deployment root and escapes the display name", async () => {
  const original = getBotName();
  setBotName("LUCY <Bot> & Co");
  try {
    const f = fixture();
    let receivedRoot = "";
    await createStatus("/srv/mibot", async (root, signal, revision) => {
      receivedRoot = root;
      assert.equal(signal, f.context.signal);
      assert.equal(await revision(signal), "abcdef1");
      return snapshot;
    }).commands.status.handle(f.invocation, f.context);
    assert.equal(receivedRoot, "/srv/mibot");
    assert.deepEqual(f.processCalls, [["-C", "/srv/mibot", "rev-parse", "--short=7", "HEAD"]]);
    const [visible] = HTMLParser.parse(f.sent[0]);
    assert.match(visible, /LUCY <Bot> & Co 运行面板/);
    assert.match(f.sent[0], /LUCY &lt;Bot&gt; &amp; Co 运行面板/);
  } finally {
    setBotName(original);
  }
});

test("status metadata parsers and formatters handle normal and unavailable values", () => {
  assert.equal(parseOsRelease('NAME=Ubuntu\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\n'), "Ubuntu 24.04.4 LTS");
  assert.equal(parseOsRelease("PRETTY_NAME='Alpine Linux'\n"), "Alpine Linux");
  assert.deepEqual(parseSwap("SwapTotal:       1048576 kB\nSwapFree:         655360 kB\n"),
    {used: 384 * 1024 ** 2, total: 1024 * 1024 ** 2});
  assert.deepEqual(parseSystemMemory("MemTotal:       16777216 kB\nMemFree:         1048576 kB\nMemAvailable:    9437184 kB\n"),
    {used: 7 * 1024 ** 3, total: 16 * 1024 ** 3});
  assert.equal(formatDuration(61), "1分钟 1秒");
  assert.equal(formatBytes(128 * 1024 * 1024), "128.00 MiB");
  assert.equal(formatBytes(2 * 1024 ** 3), "2.00 GiB");
  assert.equal(formatBytes(-1), "不可用");
  assert.equal(waterline(1, 2), "▰▰▰▰▱▱▱▱");
  assert.equal(waterline(1, 0), "────────");
});

test("status omits an unavailable revision and renders optional capacities safely", () => {
  const value: StatusSnapshot = {...snapshot, revision: undefined, swap: undefined, disk: undefined,
    cpu: {systemPercent: undefined, processPercent: undefined, logicalCores: 1}, networkInterfaces: [],
    hostUptime: undefined};
  const [visible] = HTMLParser.parse(renderStatus(value));
  assert.match(visible, /MiBot: 0\.7\.3/);
  assert.doesNotMatch(visible, /abcdef1/);
  assert.match(visible, /CPU: 系统 不可用 · MiBot 不可用 · 1 线程/);
  assert.match(visible, /Swap: 当前平台不可用/);
  assert.match(visible, /磁盘: 不可用/);
  assert.match(visible, /网络: 仅回环或不可用/);
  assert.match(visible, /主机在线: 不可用/);
});
