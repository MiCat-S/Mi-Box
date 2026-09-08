import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import createVersion from "./version";
import createUpdate from "./update";
import type {CommandInvocation, PluginContext} from "../sdk";

test("version commands read the application version for every invocation", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "mibot-version-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const edits: string[] = [];
  const context = {telegram: {async edit(_message: unknown, text: string) {edits.push(text);}}} as unknown as PluginContext;
  const version = createVersion(root), update = createUpdate(root, "123");
  const invocation: CommandInvocation = {command: "version", prefix: ".", args: [],
    message: {id: 1, chatId: "123", senderId: "123", text: ".version", outgoing: true}};
  for (const value of ["9.8.7", "9.8.8"]) {
    await writeFile(path.join(root, "package.json"), JSON.stringify({version: value}));
    for (const name of ["version", "ver"] as const) {
      await version.commands[name].handle({...invocation, command: name}, context);
      assert.ok(edits.at(-1)!.includes(`<code>${value}</code>`));
    }
    await update.commands.update.handle({...invocation, command: "update", args: ["ver"]}, context);
    assert.ok(edits.at(-1)!.includes(`<code>${value}</code>`));
    assert.doesNotMatch(edits.at(-1)!, /更新操作暂未开放/);
  }
});
