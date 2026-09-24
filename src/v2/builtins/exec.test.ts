import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PluginHost} from "../host";
import createExec from "./exec";

// The interpreter under test is the one running the suite. A hardcoded path
// ties these cases to one machine's Node installation, and they fail with a
// spawn error the moment that directory goes away.
const NODE = process.execPath;
assert.doesNotMatch(NODE, /\s/, "exec builds command lines by splitting on whitespace; a spaced interpreter path needs quoting");

async function fixture(t: test.TestContext, options: {prefixes?: string[]; aliases?: Record<string, string>} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mibot-exec-"));
  const edits: {id: number; text: string; parseMode?: string}[] = [];
  const logs: {event: string; fields?: Readonly<Record<string, string | number | boolean>>}[] = [];
  let edit = async (message: {id: number}, body: string, editOptions?: {parseMode?: string}) => {
    edits.push({id: message.id, text: body, parseMode: editOptions?.parseMode});
  };
  let reply = async (message: {id: number}, body: string, replyOptions?: {parseMode?: string}) => {
    edits.push({id: message.id, text: body, parseMode: replyOptions?.parseMode});
  };
  const host = new PluginHost({
    storageRoot: path.join(root, "assets"),
    tempRoot: path.join(root, "temp"),
    prefixes: options.prefixes ?? ["."],
    aliases: options.aliases,
    logger: {info() {}, error(event, fields) { logs.push({event, fields}); }},
    telegram: {
      async edit(message, text, editOptions) { await edit(message, text, editOptions); },
      async reply(message, text, replyOptions) { await reply(message, text, replyOptions); },
      async invoke() {}, async getReply() { return undefined; },
      async withClient(operation, signal) { return operation({} as never, signal); },
    },
    processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 20_000, maxOutputBytes: 16_000},
  });
  await host.load(createExec("1"));
  t.after(async () => {
    await host.shutdown(2_000);
    await fs.rm(root, {recursive: true, force: true});
  });
  const send = (id: number, senderId: string, message: string) => host.dispatchPrimary({
    id, chatId: "1", senderId, outgoing: true, text: message, raw: {peerId: "1", message},
  });
  return {host, root, edits, logs, send,
    replaceEdit(next: typeof edit) { edit = next; }, replaceReply(next: typeof reply) { reply = next; }};
}

test("exec preserves legacy quoted arguments and reports progress, stdout and stderr", async t => {
  const f = await fixture(t);
  await f.send(1, "1", `.exec ${NODE} -e "process.stdout.write('hello world'); process.stderr.write('notice')"`);
  const messages = f.edits.filter(({id}) => id === 1);
  assert.match(messages[0].text, /已开始执行命令/);
  assert.match(messages[0].text, /状态：运行中 0s/);
  assert.match(messages.at(-1)!.text, /执行完成/);
  assert.match(messages.at(-1)!.text, /hello world/);
  assert.match(messages.at(-1)!.text, /错误：[\s\S]*notice/);
  assert.equal(messages.at(-1)!.parseMode, "html");
});

test("exec preserves non-default prefixes, multiword aliases, injected arguments and quoted spacing", async t => {
  const f = await fixture(t, {prefixes: ["!!"], aliases: {
    "run node": `exec ${NODE} -e`,
  }});
  await f.send(7, "1", `!!run node "process.stdout.write(process.argv[1])" "two  spaces"`);
  const messages = f.edits.filter(({id}) => id === 7);
  assert.match(messages[0].text, /two  spaces/);
  assert.match(messages.at(-1)!.text, /two  spaces/);
  assert.match(messages.at(-1)!.text, /执行完成/);
});

test("exec reports bounded process failures with captured output and keeps authorization closed", async t => {
  const f = await fixture(t);
  await f.send(2, "1", `.exec ${NODE} -e "process.stderr.write('bad input'); process.exit(7)"`);
  const failure = f.edits.filter(({id}) => id === 2).at(-1)!.text;
  assert.match(failure, /执行失败/);
  assert.match(failure, /bad input/);
  assert.match(failure, /退出码：7/);

  const deniedFile = path.join(f.root, "never-created");
  await f.send(3, "2", `.exec /usr/bin/touch ${deniedFile}`);
  assert.equal(await fs.stat(deniedFile).then(() => true, () => false), false);
  assert.match(f.edits.filter(({id}) => id === 3).at(-1)!.text, /没有执行系统命令的权限/);
});

test("exec cancellation reclaims the managed process without publishing a stale result", async t => {
  const f = await fixture(t);
  const running = f.send(4, "1", `.exec ${NODE} -e "setInterval(() => {}, 1000)"`);
  while (!f.edits.some(({id, text}) => id === 4 && /运行中 0s/.test(text))) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const report = await f.host.unload("exec", 2_000);
  assert.equal(report?.completed, true);
  await running;
  assert.equal(f.edits.filter(({id}) => id === 4).length, 1);
  assert.equal(f.host.snapshot().processes?.active, 0);
});

test("exec enforces its deadline and output bound while retaining safe partial output", async t => {
  const f = await fixture(t);
  await f.send(5, "1", `.exec ${NODE} -e "process.stdout.write('before timeout'); setInterval(() => {}, 1000)"`);
  const timeout = f.edits.filter(({id}) => id === 5).at(-1)!.text;
  assert.ok(f.edits.some(({id, text}) => id === 5 && /状态：运行中 (?:[2-9]|1[0-4])s/.test(text)));
  assert.match(timeout, /执行超时/);
  assert.match(timeout, /before timeout/);
  assert.equal(f.host.snapshot().processes?.active, 0);

  await f.send(6, "1", `.exec ${NODE} -e "process.stdout.write('x'.repeat(13000))"`);
  const limitedPages = f.edits.filter(({id}) => id === 6).slice(1);
  const limited = limitedPages.map(({text: page}) => page).join("");
  assert.match(limited, /输出超过限制/);
  assert.ok(limitedPages.every(({text: page}) => page.length <= 3_500));
  assert.equal(f.host.snapshot().processes?.active, 0);
});

test("exec paginates escaped and astral output without dropping captured content", async t => {
  const f = await fixture(t);
  await f.send(8, "1", `.exec ${NODE} -e "process.stdout.write((String.fromCharCode(38)+String.fromCodePoint(0x1f642)).repeat(1000))"`);
  const pages = f.edits.filter(({id}) => id === 8).slice(1);
  assert.ok(pages.length > 1);
  assert.ok(pages.every(({text: page}) => page.length <= 3_500));
  assert.equal((pages.map(({text: page}) => page).join("").match(/&amp;/g) ?? []).length, 1_000);
  assert.equal((pages.map(({text: page}) => page).join("").match(/🙂/g) ?? []).length, 1_000);
});

test("exec propagates a first-page transport failure without reporting process failure", async t => {
  const f = await fixture(t);
  let calls = 0;
  f.replaceEdit(async (message, body, editOptions) => {
    calls += 1;
    if (calls > 1) throw new Error("transport failed");
    f.edits.push({id: message.id, text: body, parseMode: editOptions?.parseMode});
  });
  await assert.rejects(f.send(9, "1", `.exec ${NODE} -e "process.stdout.write('completed')"`), /transport failed/);
  assert.equal(calls, 2);
  assert.equal(f.edits.filter(({id}) => id === 9).length, 1);
  assert.deepEqual(f.logs.at(-1), {event: "exec.result_delivery_interrupted",
    fields: {published: 0, total: 1, kind: "Error"}});
});

test("exec records partial pagination failure and best-effort sends an interruption notice", async t => {
  const f = await fixture(t);
  let replies = 0;
  f.replaceReply(async (message, body, options) => {
    replies += 1;
    if (replies === 1) throw Object.assign(new Error("page failed"), {code: "NETWORK_FAILED"});
    f.edits.push({id: message.id, text: body, parseMode: options?.parseMode});
  });
  await f.send(10, "1", `.exec ${NODE} -e "process.stdout.write('x'.repeat(5000))"`);
  assert.deepEqual(f.logs.at(-1), {event: "exec.result_delivery_interrupted",
    fields: {published: 1, total: 3, kind: "NETWORK_FAILED"}});
  assert.match(f.edits.filter(({id}) => id === 10).at(-1)!.text, /已发送 1\/3 页.*发送中断/);
});
