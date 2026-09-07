import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PluginHost} from "../host";
import createPrivacy from "./privacy";
import {getIpPrivacy, maskIpText, setIpPrivacy} from "../ip-privacy";

test("owner can configure masking in groups, nonowner cannot; persisted policy reloads", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-ip-privacy-")));
  const output: string[] = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text) {output.push(text);}, async reply() {}, async invoke() {},
    async getReply() {return undefined;}, async withClient() {throw new Error("unexpected client");},
  }});
  t.after(async () => {await host.shutdown(2000); await fs.rm(root, {recursive: true, force: true}); setIpPrivacy({mode: "mask", ipv4Segments: 2, ipv6Segments: 4});});
  await host.load(createPrivacy("123"));
  const send = (text: string) => host.dispatchPrimary({id: 1, chatId: "-100111", senderId: "123", outgoing: true, text});
  await send(".privacy ip mask 3 6");
  assert.equal(maskIpText("38.59.246.201"), "38.*.*.*");
  await send(".privacy ip hide");
  await host.unload("privacy", 2000);
  setIpPrivacy({mode: "mask", ipv4Segments: 2, ipv6Segments: 4});
  await host.load(createPrivacy("123"));
  assert.equal(getIpPrivacy().mode, "hide");
  await send(".privacy ip mask 0");
  assert.equal(getIpPrivacy().mode, "hide");
  const before = output.length;
  await host.dispatchPrimary({id: 2, chatId: "-100111", senderId: "456", outgoing: true, text: ".privacy ip mask 1"});
  assert.equal(getIpPrivacy().mode, "hide");
  assert.ok(output.length >= before);
  assert.match(output.at(-1)!, /账号本人|用法/);
});
