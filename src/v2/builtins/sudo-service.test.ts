import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PluginHost} from "../host";
import {definePlugin} from "../sdk";
import createSudo from "./sudo";

test("sudo is_authorized exposes only exact read-only membership", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-sudo-service-")));
  const results: unknown[] = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() {return undefined;}, async withClient<T>(): Promise<T> {throw new Error("unexpected client");},
  }});
  await host.load(createSudo("1"));
  await host.load(definePlugin({apiVersion: 1, id: "consumer", description: "test", commands: {check: {description: "test", async handle({message}, ctx) {
    results.push(await ctx.services.call("sudo", "is_authorized", {senderId: message.senderId}, ctx.signal));
  }}}}));
  t.after(async () => {assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  const send = (text: string, senderId = "1") => host.dispatchPrimary({id: 1, chatId: "1", senderId, outgoing: true, text});
  await send(".check", "42");
  await send(".sudo add 42");
  await send(".check", "42");
  await send(".check", "042");
  assert.deepEqual(results, [false, true, false]);
  const service = createSudo("1").services!.is_authorized;
  const signal = AbortSignal.abort();
  await assert.rejects(async () => service.handle({senderId: "42"}, {signal} as never, signal), {name: "AbortError"});
});
