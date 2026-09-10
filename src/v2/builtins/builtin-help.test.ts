import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {HTMLParser} from "teleproto/extensions/html.js";
import {PluginHost} from "../host";
import {getIpPrivacy, setIpPrivacy} from "../ip-privacy";
import {createHelp} from "./help";
import createUpdate from "./update";
import createMemory from "./memory";
import createSudo from "./sudo";
import createExec from "./exec";
import createBf from "./bf";
import createAgent from "./agent";
import createEnv from "./env";
import createPrivacy from "./privacy";

const visible = (html: string) => HTMLParser.parse(html)[0].replace(/\s+/gu, " ").trim();

test("builtin help commands and catalog retain complete guides; query defaults remain usable", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-builtin-help-")));
  const prefix = "<&🙂";
  const sent: string[] = [];
  const errors: unknown[] = [];
  const privacy = getIpPrivacy();
  const forbidden = async (): Promise<never> => assert.fail("help must not invoke external work");
  const host = new PluginHost({storageRoot: root, prefixes: [prefix],
    logger: {info() {}, error: (...args) => {errors.push(args);}},
    telegram: {async edit(_message, value) {sent.push(value);}, async reply(_message, value) {sent.push(value);},
      invoke: forbidden, getReply: forbidden, withClient: forbidden},
  });
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, {recursive: true, force: true});
    setIpPrivacy(privacy);
  });
  const definitions = [createUpdate(root, "1"), createMemory(), createSudo(), createExec(),
    createBf(root), createAgent(), createEnv(), createPrivacy("1")];
  await host.load(createHelp(host, "1"));
  for (const definition of definitions) {
    await host.load(definition);
    assert.equal(typeof definition.renderHelp, "function");
    const expected = visible(definition.renderHelp!(prefix));
    const name = definition.id;
    const entries = [`${name} help`, `${name} h`, `${name} --help`, `help ${name}`,
      ...(["sudo", "exec", "agent"].includes(name) ? [name] : [])];
    for (const input of entries) {
      sent.length = 0;
      assert.equal(await host.dispatchPrimary({id: 1, chatId: "1", senderId: "1", outgoing: true, text: prefix + input}), true);
      assert.ok(sent.length, input);
      for (const page of sent) {
        const [, entities] = HTMLParser.parse(page);
        assert.ok(page.length <= 3500, `${input}: HTML budget`);
        assert.ok(entities.length <= 90, `${input}: entity budget`);
      }
      const output = visible(sent.join("\n"));
      assert.ok(output.includes(expected), `${input}: all authored content is delivered`);
      assert.ok(output.includes(`${prefix}${name}`), `${input}: active prefix is escaped and preserved`);
    }
  }
  for (const [command, expected] of [["memory", /内存状态/], ["env", /NODE_ENV=/], ["privacy", /IP显示：/]]) {
    sent.length = 0;
    await host.dispatchPrimary({id: 2, chatId: "1", senderId: "1", outgoing: true, text: prefix + command});
    assert.match(sent.join("\n"), expected as RegExp);
  }
  assert.deepEqual(errors, []);
});
