'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {build} = require('./build-v2.cjs');
const {buildPlugin} = require('./build-v2-plugin.cjs');

const core = path.resolve(__dirname, '..');
const defaultPlugins = fs.existsSync(path.resolve(core, '../mibot-plugins'))
  ? path.resolve(core, '../mibot-plugins') : path.resolve(core, '../TeleBox-Plugins');

async function verifyOne(id, plugins, PluginHost) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mibox-v2-${id}-`)));
  const artifact = buildPlugin({id, packageRoot: path.join(plugins, id), entry: 'v2.ts', rootDir: core});
  const loaded = require(path.join(artifact.artifactDir, artifact.manifest.entry));
  const factory = loaded.default ?? loaded;
  if (typeof factory !== 'function') throw new Error(`${id}: default export must be a plugin factory`);
  const definition = factory();
  if (!definition || definition.id !== id) throw new Error(`${id}: factory returned the wrong plugin id`);
  const unavailable = async () => { throw new Error('External operations are unavailable during host verification'); };
  const host = new PluginHost({
    storageRoot: path.join(root, 'assets'), tempRoot: path.join(root, 'temp'),
    logger: {info() {}, error() {}},
    telegram: {edit: unavailable, reply: unavailable, invoke: unavailable, getReply: unavailable, withClient: unavailable},
    processes: {concurrency: 2, queueCapacity: 16, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024},
  });
  try {
    host.preflight(definition);
    await host.load(definition);
    const report = await host.unload(id, 5_000);
    if (!report?.completed) throw new Error(`${id}: plugin did not unload cleanly`);
  } finally {
    const report = await host.shutdown(5_000);
    if (!report.completed) throw new Error(`${id}: host did not shut down cleanly`);
    fs.rmSync(root, {recursive: true, force: true});
  }
  return artifact.manifest.revision;
}

async function main() {
  const plugins = fs.realpathSync(process.argv[2] || defaultPlugins);
  const catalog = JSON.parse(fs.readFileSync(path.join(plugins, 'plugins.json'), 'utf8'));
  const ids = Object.keys(catalog).filter(id => fs.existsSync(path.join(plugins, id, 'v2.ts'))).sort();
  build();
  const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
  const revisions = {};
  for (const id of ids) revisions[id] = await verifyOne(id, plugins, PluginHost);
  process.stdout.write(JSON.stringify({plugins: ids.length, revisions}, null, 2) + '\n');
}

if (require.main === module) main().catch(error => {
  console.error(error instanceof Error ? error.message : 'V2 plugin verification failed');
  process.exitCode = 1;
});

module.exports = {verifyOne};
