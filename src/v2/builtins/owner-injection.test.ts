import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PluginHost} from "../host";
import createExec from "./exec";
import createBf from "./bf";
import createSudo from "./sudo";

test("exec, bf and sudo use only the authenticated owner supplied by runtime", async t => {
  const original = process.env.TB_OWNER_ID;
  process.env.TB_OWNER_ID = "2";
  t.after(() => { if (original === undefined) delete process.env.TB_OWNER_ID; else process.env.TB_OWNER_ID = original; });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-owner-injection-")));
  await fs.writeFile(path.join(root, "package.json"), "{}");
  const edits: {id: number; text: string}[] = [];
  let filesSent = 0;
  const host = new PluginHost({storageRoot: path.join(root, "assets"), tempRoot: path.join(root, "temp"),
    prefixes: ["."], logger: {info() {}, error() {}}, telegram: {
      async edit(message, text) { edits.push({id: message.id, text}); },
      async reply() {}, async invoke() {}, async getReply() { return undefined; },
      async withClient(operation, signal) {
        return operation({sendFile: async () => { filesSent += 1; }} as never, signal);
      },
    }});
  t.after(async () => {
    assert.equal((await host.shutdown(2000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  await host.load(createExec("1"));
  await host.load(createBf(root, "1"));
  await host.load(createSudo("1"));
  const send = (id: number, senderId: string, text: string) => host.dispatchPrimary({
    id, chatId: "1", senderId, outgoing: true, text, raw: {peerId: "1"},
  });

  await send(1, "1", ".exec /usr/bin/true");
  await send(2, "1", ".bf");
  await send(3, "1", ".sudo add 3");
  assert.equal(filesSent, 1);
  assert.doesNotMatch(edits.filter(({id}) => id <= 3).map(({text}) => text).join("\n"), /没有.*权限|只有 owner/);

  const deniedFile = path.join(root, "denied-side-effect");
  await send(4, "2", `.exec /usr/bin/touch ${deniedFile}`);
  await send(5, "2", ".bf");
  await send(6, "2", ".sudo add 4");
  assert.equal(await fs.stat(deniedFile).then(() => true, () => false), false);
  assert.equal(filesSent, 1);
  const sudo = JSON.parse(await fs.readFile(path.join(root, "assets/sudo/config.json"), "utf8"));
  assert.deepEqual(sudo.users, ["3"]);
  const denied = edits.filter(({id}) => id >= 4).map(({text}) => text).join("\n");
  assert.match(denied, /没有执行系统命令的权限/);
  assert.match(denied, /没有创建备份的权限/);
  assert.match(denied, /只有 owner 可以管理 sudo 白名单/);
});
