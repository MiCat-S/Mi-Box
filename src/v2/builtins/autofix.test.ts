import assert from "node:assert/strict";
import test from "node:test";
import createAutofix from "./autofix";
import {ProcessExitError, ProcessTimeoutError} from "../processes";
import type {PluginContext} from "../sdk";

function fixture(serviceError?: Error) {
  const calls: string[][] = [];
  const edits: string[] = [];
  const ctx = {
    signal: new AbortController().signal,
    processes: {run: async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "is-active" && serviceError) throw serviceError;
      if (args[0] === "is-active") return {stdout: Buffer.from("active\n"), stderr: Buffer.alloc(0), exitCode: 0};
      return {stdout: Buffer.from("## branch<&>\n"), stderr: Buffer.alloc(0), exitCode: 0};
    }},
    telegram: {edit: async (_message: unknown, text: string) => { edits.push(text); }},
  } as unknown as PluginContext;
  return {calls, edits, ctx};
}

const invocation = {command: "autofix", args: [], prefix: ".",
  message: {id: 1, chatId: "1", senderId: "1", outgoing: true, text: ".autofix"}} as const;

test("autofix diagnoses the deployed mibot service and escapes diagnostic output", async () => {
  const f = fixture();
  await createAutofix("/fixture").commands.autofix.handle(invocation, f.ctx);
  assert.deepEqual(f.calls.find(args => args[0] === "is-active"), ["is-active", "mibot.service"]);
  assert.match(f.edits.at(-1)!, /服务：<code>active<\/code>/);
  assert.match(f.edits.at(-1)!, /branch&lt;&amp;&gt;/);
});

test("autofix reports a normal inactive state but keeps process failures distinct", async () => {
  const inactive = fixture(new ProcessExitError({stdout: Buffer.from("inactive\n"), stderr: Buffer.alloc(0), exitCode: 3, signal: null}));
  await createAutofix("/fixture").commands.autofix.handle(invocation, inactive.ctx);
  assert.match(inactive.edits.at(-1)!, /服务：<code>inactive<\/code>/);
  assert.doesNotMatch(inactive.edits.at(-1)!, /诊断失败/);

  const timeout = fixture(new ProcessTimeoutError({stdout: Buffer.from("inactive\n"), stderr: Buffer.alloc(0), exitCode: null, signal: null}));
  await createAutofix("/fixture").commands.autofix.handle(invocation, timeout.ctx);
  assert.match(timeout.edits.at(-1)!, /诊断失败/);
});
