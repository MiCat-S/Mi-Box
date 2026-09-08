'use strict';

// Offline workloads; pass --modules <directory> to compare compiled revisions.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {setImmediate: turn} = require('node:timers/promises');

const flags = process.argv.slice(2);
const option = name => flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined;
const modules = path.resolve(option('--modules') ?? path.join(__dirname, '../dist/v2'));
const workload = option('--case');
const memory = () => ({...process.memoryUsage(), maxRSSKiB: process.resourceUsage().maxRSS});

async function collect() {
  // WeakRef targets remain alive for their current JS job. Collect on later turns.
  for (let i = 0; i < 8; i++) { await turn(); global.gc(); }
}

async function executor() {
  const {KeyedExecutor} = require(path.join(modules, 'executor.js'));
  const queue = new KeyedExecutor(1, 0);
  const timers = [], references = [];
  const keepTimer = () => timers.push(setInterval(() => {}, 60_000));
  async function submitPayload() {
    const payload = Buffer.alloc(16 * 1024 * 1024, 7);
    references.push(new WeakRef(payload));
    await queue.submit('message', () => { assert.equal(payload[0], 7); keepTimer(); });
  }
  await collect();
  const before = memory();
  try {
    for (let i = 0; i < 4; i++) await submitPayload();
    await collect();
    const after = memory();
    const retainedPayloads = references.filter(reference => reference.deref() !== undefined).length;
    assert.deepEqual(queue.snapshot(), {active: 0, queued: 0, closed: false});
    return {before, after, retainedPayloads, allocatedPayloadBytes: 64 * 1024 * 1024};
  } finally {
    for (const timer of timers) clearInterval(timer);
    await queue.close();
  }
}

async function storage() {
  const {JsonStore} = require(path.join(modules, 'storage.js'));
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'mibot-memory-store-'));
  const file = path.join(directory, 'state.json');
  // Seed incrementally so benchmark setup does not dominate the measured peak.
  const handle = await fs.open(file, 'w', 0o600);
  await handle.write('{"records":[');
  for (let i = 0; i < 512; i++) {
    const records = Array.from({length: 64}, (_, j) => ({id: i * 64 + j, text: `${i}/${j}:` + 'x'.repeat(500)}));
    await handle.write((i ? ',' : '') + JSON.stringify(records).slice(1, -1));
  }
  await handle.write('],"count":0}');
  await handle.close();
  const store = new JsonStore(file, {});
  await collect();
  const before = memory();
  let mutatorMemory;
  try {
    const started = performance.now();
    const value = await store.update(current => {
      global.gc();
      mutatorMemory = memory();
      current.count++;
      return current;
    });
    assert.equal(value.records.length, 32768);
    assert.equal(value.count, 1);
    return {before, mutatorMemory, after: memory(), elapsedMs: performance.now() - started,
      fileBytes: (await fs.stat(file)).size};
  } finally {
    await store.close();
    await fs.rm(directory, {recursive: true, force: true});
  }
}

async function http() {
  const {ResourceScope} = require(path.join(modules, 'lifecycle.js'));
  const {ScopedHttp} = require(path.join(modules, 'http.js'));
  const scope = new ResourceScope();
  const size = 2 * 1024 * 1024;
  const chunkSize = Number(option('--chunk') ?? 1);
  assert.ok(Number.isSafeInteger(chunkSize) && chunkSize > 0 && chunkSize <= size, 'Invalid chunk size');
  const chunk = new Uint8Array(chunkSize).fill(120);
  let sent = 0, bufferedMemory;
  const response = new Response(new ReadableStream({pull(controller) {
    if (sent === size) {
      global.gc();
      bufferedMemory = memory();
      controller.close();
    } else {
      const count = Math.min(chunkSize, size - sent);
      controller.enqueue(chunk.subarray(0, count));
      sent += count;
    }
  }}));
  const client = new ScopedHttp(scope, {fetch: async () => response, maxResponseBytes: size});
  await collect();
  const before = memory();
  const started = performance.now();
  try {
    const result = await client.text('https://offline.invalid/fixture');
    assert.equal(result.length, size);
    assert.equal(result, 'x'.repeat(size));
    return {before, bufferedMemory, after: memory(), elapsedMs: performance.now() - started,
      bodyBytes: size, chunkSize};
  } finally { assert.equal((await scope.drain()).completed, true); }
}

async function plugin() {
  const {PluginHost} = require(path.join(modules, 'host.js'));
  const {prepareArtifact} = require(path.join(modules, 'artifacts.js'));
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'mibot-memory-plugin-'));
  let handle;
  const host = new PluginHost({storageRoot: directory, logger: {info() {}, error() {}},
    http: {fetch: async () => { throw new Error('Unexpected network request'); }},
    telegram: {async edit() {}, async reply() {}, async getReply() {},
      async invoke() { throw new Error('Unexpected RPC'); },
      async withClient() { throw new Error('Unexpected client operation'); }}});
  await collect();
  const before = memory();
  try {
    handle = await prepareArtifact(path.resolve(option('--artifact')));
    const definition = handle.create();
    await host.load(definition);
    await host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text: `.${definition.id}`});
    await collect();
    const loadedLibraries = ['sharp', 'cheerio', 'archiver'].filter(name =>
      Object.keys(require.cache).some(file => file.includes(`/node_modules/${name}/`)));
    return {plugin: definition.id, before, after: memory(), loadedLibraries};
  } finally {
    assert.equal((await host.shutdown()).completed, true);
    handle?.release();
    await fs.rm(directory, {recursive: true, force: true});
  }
}

async function main() {
  if (!workload) {
    for (const name of ['executor', 'storage', 'http']) {
      const result = spawnSync(process.execPath, ['--expose-gc', __filename, '--modules', modules, '--case', name],
        {encoding: 'utf8', timeout: 60_000});
      if (result.error) throw result.error;
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.status !== 0) throw new Error(`Memory workload failed: ${name}`);
    }
    return;
  }
  assert.equal(typeof global.gc, 'function', 'Run workloads with --expose-gc');
  const run = {executor, storage, http, plugin}[workload];
  assert.ok(run, 'Unknown workload');
  console.log(JSON.stringify({workload, node: process.version, platform: process.platform, ...await run()}));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
