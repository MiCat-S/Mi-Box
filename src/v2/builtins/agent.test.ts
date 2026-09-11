import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PluginHost} from "../host";
import {definePlugin} from "../sdk";
import createAgent from "./agent";

test("agent submits text to the AI chat service and displays its string answer", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-agent-chat-")));
  const output: string[] = [];
  const requests: unknown[] = [];
  let quote = false;
  let answer = "测试回答";
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text) {output.push(text);}, async reply() {}, async invoke() {assert.fail("unexpected RPC");},
    async getReply() {return quote ? {id: 2, chatId: "1", text: "引用内容", outgoing: false} : undefined;},
    async withClient() {assert.fail("unexpected client");},
  }});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(createAgent());
  const send = (text: string) => host.dispatchPrimary({id: 1, chatId: "1", senderId: "1", outgoing: true, text});
  await send(".agent 你好");
  assert.equal(output.at(-1), "AI 服务当前不可用，请先用 .tpm install ai 安装，再用 .help ai 配置");
  await host.load(definePlugin({apiVersion: 1, id: "ai", description: "AI 服务", commands: {}, services: {
    chat: {description: "AI 文字对话", async handle(input) {requests.push(input); return answer;}},
  }}));
  await send(".agent 你好");
  assert.deepEqual(requests.at(-1), {text: "你好"});
  assert.equal(output.at(-1), "测试回答");
  quote = true;
  await send(".agent 总结");
  assert.deepEqual(requests.at(-1), {text: "总结\n\n引用消息：\n引用内容"});
  assert.equal(output.at(-1), "测试回答");
  answer = " ";
  await send(".agent 继续");
  assert.equal(output.at(-1), "AI 未返回内容");
  const before = requests.length;
  await send(".agent help");
  assert.equal(requests.length, before, "help must not call AI");
});
