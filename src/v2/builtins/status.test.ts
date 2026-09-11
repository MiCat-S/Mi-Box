import assert from "node:assert/strict";
import test from "node:test";
import {HTMLParser} from "teleproto/extensions/html.js";
import {getBotName, setBotName} from "../branding";
import type {PluginContext, CommandInvocation} from "../sdk";
import createStatus, {
  formatBytes, formatDuration, parseOsRelease, parseSwap, parseSystemMemory, renderStatus,
  type StatusSnapshot,
} from "./status";
import {renderStatusCard, STATUS_CARD_HEIGHT, STATUS_CARD_WIDTH} from "./status-card";

const snapshot: StatusSnapshot = {
  applicationVersion: "0.7.4",
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
  const edits: string[] = [];
  const uploads: Array<{peer: unknown; options: Record<string, any>}> = [];
  const errors: string[] = [];
  const deletions: Array<{revoke?: boolean} | undefined> = [];
  const processCalls: string[][] = [];
  const context = {
    signal: new AbortController().signal,
    log: {error: (event: string) => { errors.push(event); }},
    telegram: {
      edit: async (_message: unknown, value: string) => { edits.push(value); },
      withClient: async (operation: (client: unknown, signal: AbortSignal) => Promise<unknown>) => operation({
        sendFile: async (peer: unknown, options: Record<string, any>) => { uploads.push({peer, options}); },
      }, context.signal),
    },
    processes: {run: async (_command: string, args: string[]) => {
      processCalls.push(args);
      return {stdout: Buffer.from("abcdef1\n"), stderr: Buffer.alloc(0), exitCode: 0};
    }},
  } as unknown as PluginContext;
  const invocation = {args: [], prefix: ".", message: {id: 1, chatId: "1", senderId: "other", text: ".status",
    outgoing: true, topicId: 77, raw: {peerId: "peer", inputChat: "input-peer", async delete(options?: {revoke?: boolean}) {deletions.push(options);}}}} as unknown as CommandInvocation;
  return {edits, uploads, errors, deletions, processCalls, context, invocation};
}

test("status renders a concise caption and a wide PNG dashboard from a fixed snapshot", () => {
  const [visible] = HTMLParser.parse(renderStatus(snapshot));
  for (const section of ["🖥 主机", "🧠 进程", "⏱ 运行详情"]) assert.ok(visible.includes(section));
  assert.match(visible, /edge-01<&> · linux\/arm64/);
  assert.match(visible, /MiBot CPU: 0\.3%/);
  assert.match(visible, /MiBot RSS: 128\.00 MiB · 0\.8%/);
  assert.match(visible, /28天 6小时 52分钟/);
  assert.match(visible, /0\.00 \/ 1\.25 \/ 2\.50/);
  assert.match(visible, /状态采样: 184ms/);
  assert.match(visible, /eth0 · wg<&> · en1 · en2 · 另 1 个/);
  assert.match(renderStatus(snapshot), /edge-01&lt;&amp;&gt;/);
  assert.match(renderStatus(snapshot), /wg&lt;&amp;&gt;/);
  assert.ok(renderStatus(snapshot).length < 1024);

  const image = renderStatusCard(snapshot, "MiBot");
  assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(image.readUInt32BE(16), STATUS_CARD_WIDTH);
  assert.equal(image.readUInt32BE(20), STATUS_CARD_HEIGHT);
  assert.ok(STATUS_CARD_WIDTH > STATUS_CARD_HEIGHT);
});

test("status command sends one image with its caption, deletes the command and uses the deployment root", async () => {
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
    assert.deepEqual(f.edits, []);
    assert.equal(f.uploads.length, 1);
    assert.equal(f.uploads[0].peer, "input-peer");
    assert.equal(f.uploads[0].options.parseMode, "html");
    assert.equal(f.uploads[0].options.forceDocument, false);
    assert.equal(f.uploads[0].options.topMsgId, 77);
    const file = f.uploads[0].options.file;
    assert.equal(file.name, "mibot-status.png");
    assert.equal(file.size, file.buffer.length);
    assert.equal(file.buffer.readUInt32BE(16), STATUS_CARD_WIDTH);
    const [visible] = HTMLParser.parse(f.uploads[0].options.caption);
    assert.match(visible, /LUCY <Bot> & Co CPU/);
    assert.match(f.uploads[0].options.caption, /LUCY &lt;Bot&gt; &amp; Co CPU/);
    assert.deepEqual(f.deletions, [{revoke: true}]);
    assert.deepEqual(f.errors, []);
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
});

test("status card and caption render unavailable optional values safely", () => {
  const value: StatusSnapshot = {...snapshot, revision: undefined, swap: undefined, disk: undefined,
    cpu: {systemPercent: undefined, processPercent: undefined, logicalCores: 1}, networkInterfaces: [],
    hostUptime: undefined};
  const [visible] = HTMLParser.parse(renderStatus(value));
  assert.match(visible, /MiBot CPU: 不可用/);
  assert.match(visible, /网络: 仅回环或不可用/);
  assert.match(visible, /主机在线: 不可用/);
  const image = renderStatusCard(value, "MiBot");
  assert.equal(image.readUInt32BE(16), STATUS_CARD_WIDTH);
  assert.equal(image.readUInt32BE(20), STATUS_CARD_HEIGHT);
});
