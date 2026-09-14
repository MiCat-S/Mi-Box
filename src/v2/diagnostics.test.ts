import assert from "node:assert/strict";
import test from "node:test";
import {debugDiagnostic} from "./diagnostics";
import {redactMessage} from "./ip-privacy";
import createUpdate from "./builtins/update";
import type {CommandInvocation, PluginContext} from "./sdk";

test("fallback diagnostics are opt-in and contain only fixed events, never malformed private input", async t => {
  const previous = process.env.DEBUG;
  t.after(() => {if (previous === undefined) delete process.env.DEBUG; else process.env.DEBUG = previous;});
  const records: string[] = [];
  t.mock.method(console, "warn", (value: string) => records.push(value));
  for (const value of [undefined, "", "0", "false"]) {
    if (value === undefined) delete process.env.DEBUG; else process.env.DEBUG = value;
    debugDiagnostic("update.version_read_failed");
  }
  assert.deepEqual(records, []);
  process.env.DEBUG = "1";
  const source = {message: "link", entities: [{offset: 0, length: 4, url: "https://secret.example/sk-live-private%ZZ"}]};
  const result = redactMessage(source);
  assert.equal(result.message, source.message);
  assert.deepEqual(records.map(value => JSON.parse(value)), [{level: "debug", event: "privacy.uri_decode_failed"}]);
  const edits: string[] = [];
  await createUpdate("/missing-private-path/sk-live", "1").commands.update.handle({
    command: "update", args: ["ver"], prefix: ".", message: {id: 1, chatId: "1", senderId: "1", text: ".update ver", outgoing: true},
  } as CommandInvocation, {telegram: {edit: async (_message: unknown, text: string) => {edits.push(text);}}} as PluginContext);
  assert.match(edits[0], /未知/);
  assert.equal(JSON.parse(records.at(-1)!).event, "update.version_read_failed");
  assert.doesNotMatch(records.join("\n"), /secret\.example|sk-live|missing-private-path|%ZZ|Error/);
});
