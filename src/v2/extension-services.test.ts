import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, realpath, rm, symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {TelegramClient} from "teleproto";
import {PluginHost} from "./host";
import type {MessageEnvelope, TelegramPort} from "./sdk";
import {PluginReleases, type ReleaseState} from "./releases";
import {StorageRoot} from "./storage";
import createTpm from "./builtins/tpm";
import {existsSync} from "node:fs";

test("AI extensions install through TPM, handle offline media and restore from saved selections", async () => {
  const root = await realpath(path.resolve(__dirname, "../.."));
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "telebox-v2-extensions-")));
  // Dynamic package imports resolve from the deployment root, as in production.
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  const preferred = path.resolve(root, '../mibot-plugins');
  const sources = existsSync(preferred) ? preferred : path.resolve(root, '../TeleBox-Plugins');
  const {buildPlugin} = require(path.join(root, 'scripts/build-v2-plugin.cjs'));
  const output: string[] = [];
  const deleted: number[][] = [];
  const files: string[] = [];
  let historyReads = 0;
  const reply: MessageEnvelope = {id: 88, chatId: "-100123", senderId: "1", text: "quoted text", outgoing: false,
    raw: {className: "Message", id: 88, peerId: "-100123", senderId: 1n, message: "quoted text", out: false,
      sender: {className: "User", id: 1n, firstName: "Alice"}, entities: []}};
  const native = {
    setLogLevel() {},
    async getEntity() {return {className: "Channel", id: 123n, title: "Fixture Group", username: "fixture_group", broadcast: false};},
    async getMe() {return {className: "User", id: 123n, self: true};},
    async getInputEntity(value: unknown) {return value;},
    async deleteMessages(_peer: unknown, ids: number[]) {deleted.push([...ids]); return [];},
    async sendMessage() {return {id: 700};},
    async editMessage() {return {};},
    async sendFile(_peer: unknown, options: {file?: {name?: string}}) {files.push(options.file?.name ?? ""); return {};},
    async invoke(request: {className?: string}) {
      if (request.className === "channels.GetParticipant") return {participant: {className: "ChannelParticipantAdmin"}};
      if (request.className === "messages.GetHistory") {
        historyReads++;
        return {messages: historyReads === 1 ? [
          {className: "Message", id: 4, message: "mine 4", senderId: 123n, out: true},
          {className: "Message", id: 3, message: "mine 3", senderId: 123n, out: true},
        ] : []};
      }
      return {};
    },
    async *iterMessages() {
      for (let id = 20; id >= 1; id--) yield {className: "Message", id, message: `fixture message ${id}`,
        senderId: BigInt(id % 2 + 1), sender: {firstName: id % 2 ? "Alice" : "Bob"}, entities: []};
    },
  } as unknown as TelegramClient;
  const telegram: TelegramPort = {
    async edit(_message, text) {output.push(text);},
    async reply(_message, text) {output.push(text);},
    async invoke() {throw new Error("network unavailable");},
    async getReply() {return reply;},
    async withClient(operation, signal) {return operation(native, signal);},
  };
  const logger = {info() {}, error() {}};
  const hostOptions = {storageRoot: path.join(directory, "assets"), tempRoot: path.join(directory, "temp"), telegram, logger,
    http: {fetch: async (input, init) => {
      const url = String(input);
      if (url.includes("quote-api-enhanced")) return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), {headers: {"content-type": "image/png"}});
      if (url.includes("fixture.invalid/media.mp4")) return new Response(Buffer.from("fixture-video"), {headers: {"content-type": "video/mp4"}});
      if (url.includes("/images/")) return new Response(JSON.stringify({data: [{b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}]}));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const content = body.model === "fixture-video" ? "https://fixture.invalid/media.mp4" : "<b>fixture answer</b>";
      return new Response(JSON.stringify({choices: [{message: {content}}]}));
    }}} satisfies ConstructorParameters<typeof PluginHost>[0];
  let host = new PluginHost(hostOptions);
  const storage = new StorageRoot(path.join(directory, 'assets'));
  const selection = storage.json<ReleaseState>('tpm', 'releases.json', {schemaVersion: 1, plugins: {}});
  let releases = new PluginReleases(host, {artifactRoot: path.join(directory, 'dist/v2-plugins'), store: selection});
  let stopped = false;
  try {
    const tpm = createTpm(host, releases, root, '123');
    const install = {id: 1, chatId: '123', senderId: '123', text: '.tpm install ai gt', outgoing: true, saved: true};
    // Compile actual extension sources locally; repository transport is outside this offline test.
    await tpm.commands.tpm.handle({command: 'tpm', prefix: '.', args: ['install', 'ai', 'gt'], message: install}, {
      signal: new AbortController().signal, telegram, log: logger,
      processes: {async run(_exe: string, args: string[]) {
        assert.equal(args[1], 'build-selected');
        return {stdout: Buffer.from(JSON.stringify({ids: ['ai', 'gt'], candidates: args.slice(2).map(id => {
          const {manifest} = buildPlugin({id, packageRoot: path.join(sources, id), entry: 'v2.ts', rootDir: directory});
          return {id, revision: manifest.revision};
        })}))};
      }},
    } as unknown as import('./sdk').PluginContext);
    assert.deepEqual(host.listPlugins().map(plugin => plugin.id).sort(), ['ai', 'gt']);
    assert.deepEqual(Object.keys((await selection.read()).plugins).sort(), ['ai', 'gt']);
    output.length = 0;
    const message = (text: string, chatId = "-100123"): MessageEnvelope => ({
      id: output.length + 1, chatId, senderId: "123", text, outgoing: true, saved: chatId === "123",
    });
    for (const command of [".ai help", ".gt help"]) {
      assert.equal(await host.dispatchPrimary(message(command)), true, command);
    }
    assert.equal(output.length, 2);
    assert.match(output[0], /AI 助手/);
    for (const command of [".da help", ".dme help", ".sum list", ".yvlu config"]) {
      assert.equal(await host.dispatchPrimary(message(command)), false, command);
    }
    assert.equal(output.length, 2);
    const saved = (text: string): MessageEnvelope => ({id: output.length + 1, chatId: "123", senderId: "123", text,
      outgoing: true, saved: true});
    assert.equal(await host.dispatchPrimary(saved(".ai config add main https://fixture.invalid/v1 secret openai-compatible")), true);
    assert.equal(await host.dispatchPrimary(saved(".ai model chat main fixture-chat")), true);
    assert.equal(await host.dispatchPrimary(saved(".ai fixture question")), true);
    assert.match(output.at(-1) ?? "", /fixture answer/);
    assert.equal(await host.dispatchPrimary(saved(".gt en fixture text")), true);
    assert.match(output.at(-1) ?? "", /fixture answer/);
    assert.equal(await host.dispatchPrimary(saved(".ai model image main gpt-image-2")), true);
    assert.equal(await host.dispatchPrimary(saved(".ai image fixture art")), true);
    assert.match(files[0] ?? "", /ai_image_.*\.png/);
    assert.equal(await host.dispatchPrimary(saved(".ai model video main fixture-video")), true);
    assert.equal(await host.dispatchPrimary(saved(".ai video fixture clip")), true);
    assert.match(files[1] ?? "", /ai_video_.*\.mp4/);
    assert.equal((await releases.shutdown(5000)).completed, true);
    assert.equal((await host.shutdown(5000)).completed, true);
    host = new PluginHost(hostOptions);
    releases = new PluginReleases(host, {artifactRoot: path.join(directory, 'dist/v2-plugins'), store: selection});
    for (const [id, selected] of Object.entries((await selection.read()).plugins)) await releases.activate(id, selected.current);
    assert.deepEqual(releases.snapshot().generations.map(item => item.id).sort(), ['ai', 'gt']);
    assert.equal(await host.dispatchPrimary(saved('.ai configuration survives restart')), true);
    assert.match(output.at(-1) ?? '', /fixture answer/);
    await releases.remove('gt');
    assert.equal(await host.dispatchPrimary(saved('.gt en removed')), false);
    assert.deepEqual(Object.keys((await selection.read()).plugins), ['ai']);
    const released = await releases.shutdown(5000);
    const report = await host.shutdown(5000);
    stopped = released.completed && report.completed;
    assert.equal(released.completed, true);
    assert.equal(report.completed, true);
    assert.equal(report.pendingTasks, 0);
    assert.equal(report.pendingResources, 0);
  } finally {
    if (!stopped) {
      const released = await releases.shutdown(5000);
      stopped = (await host.shutdown(5000)).completed && released.completed;
    }
    await storage.close();
    if (stopped) {
      await rm(directory, {recursive: true, force: true});
    }
  }
});
