import assert from "node:assert/strict";
import test from "node:test";
import createUpdate from "./update";
import type {PluginContext} from "../sdk";

for (const initial of ["inactive", "failed"] as const) {
  test(`update starts from ${initial} and resets only an actual failure`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
    Object.defineProperty(process, "getuid", {value: () => 0, configurable: true});
    t.after(() => Object.defineProperty(process, "getuid", descriptor));
    const calls: string[] = [];
    let started = false;
    const fields: Record<string, string> = {LoadState: "loaded", ActiveState: initial,
      UnitFileState: "static", SubState: "dead", CanStart: "yes",
      FragmentPath: "/etc/systemd/system/mibot-update.service", Result: "success"};
    const ctx = {
      signal: new AbortController().signal,
      tasks: {run: async () => {}},
      storage: {json: () => ({read: async () => ({pending: null}), update: async (fn: Function) => fn({pending: null})})},
      telegram: {edit: async () => {}}, log: {error() {}},
      processes: {run: async (_command: string, args: string[]) => {
        calls.push(args[0]);
        if (args[0] === "reset-failed" && initial === "inactive") throw new Error("Unit mibot-update.service not loaded");
        if (args[0] === "start") started = true;
        const property = args[args.indexOf("-p") + 1];
        const stdout = args[0] === "show" ? (property === "ActiveState" && started ? "active" : fields[property ?? ""] ?? "") : "";
        return {stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode: 0};
      }},
    } as unknown as PluginContext;
    await createUpdate(undefined, "123").commands.update.handle({command: "update", args: ["run"], prefix: ".",
      message: {id: 1, chatId: "123", senderId: "123", outgoing: true, text: ".update run"}}, ctx);
    assert.equal(started, true);
    assert.equal(calls.includes("reset-failed"), initial === "failed");
    assert.ok(calls.indexOf("daemon-reload") < calls.indexOf("start"));
  });
}
