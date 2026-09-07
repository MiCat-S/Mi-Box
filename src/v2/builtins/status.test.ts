import assert from "node:assert/strict";
import test from "node:test";
import {HTMLParser} from "teleproto/extensions/html.js";
import {getBotName, setBotName} from "../branding";
import type {PluginContext, CommandInvocation} from "../sdk";
import createStatus, {formatBytes, formatDuration, renderStatus, type StatusSnapshot} from "./status";

function fixture() {
  const sent: string[] = [];
  const context = {
    telegram: {edit: async (_message: unknown, text: string) => {sent.push(text);}},
  } as unknown as PluginContext;
  const invocation = {args: [], prefix: ".", message: {senderId: "other"}} as unknown as CommandInvocation;
  return {sent, context, invocation};
}

test("status formats fixed snapshots without sampling extra resources", () => {
  const snapshot: StatusSnapshot = {
    uptime: 5,
    nodeVersion: "v24.20.0",
    platform: "linux",
    arch: "arm64",
    pid: 123,
    processMemory: {rss: 8 * 1024 * 1024, heapUsed: 2 * 1024 * 1024, heapTotal: 4 * 1024 * 1024, external: 1024 * 1024},
    systemMemory: {total: 16 * 1024 * 1024, free: 6 * 1024 * 1024},
    loadAverage: [0, 1.25, 2.5],
  };
  const [visible] = HTMLParser.parse(renderStatus(snapshot));
  assert.match(visible, /MiBot 状态/);
  assert.match(visible, /运行环境/);
  assert.match(visible, /进程内存/);
  assert.match(visible, /系统资源/);
  assert.match(visible, /5秒/);
  assert.match(visible, /8\.00 MiB/);
  assert.match(visible, /10\.00 MiB \/ 16\.00 MiB（剩余 6\.00 MiB）/);
  assert.match(visible, /0\.00 \/ 1\.25 \/ 2\.50/);
});

test("status uses escaped display name and consistent resource units", async () => {
  const original = getBotName();
  setBotName("LUCY <Bot> & Co");
  try {
    const f = fixture();
    await createStatus().commands.status.handle(f.invocation, f.context);
    const [text] = HTMLParser.parse(f.sent[0]);
    assert.match(text, /LUCY <Bot> & Co 状态/);
    assert.match(f.sent[0], /LUCY &lt;Bot&gt; &amp; Co 状态/);
    for (const section of ["运行环境", "进程内存", "系统资源"]) assert.ok(text.includes(section));
    assert.match(text, /MiB/);
    assert.match(text, /1 \/ 5 \/ 15 分钟/);
    assert.ok(!text.includes("线程: Node"));
  } finally {
    setBotName(original);
  }
});

test("status duration and byte helpers keep sub-minute values precise", () => {
  assert.equal(formatDuration(0), "0秒");
  assert.equal(formatDuration(59.9), "59秒");
  assert.equal(formatDuration(61), "1分钟 1秒");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.00 MiB");
  assert.equal(formatBytes(-1), "不可用");
});
