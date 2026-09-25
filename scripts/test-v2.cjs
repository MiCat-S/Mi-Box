'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {findPlugins} = require('./test-v2-paths.cjs');
const root = path.resolve(__dirname, '..');
const plugins = findPlugins(root);
const env = {...process.env, ...(plugins ? {TELEBOX_PLUGINS_ROOT: plugins} : {})};
if (!plugins) console.warn('未找到插件仓库：仅跳过跨仓插件检查，继续执行全部 Core 测试。完整检查请克隆 Mi-Box-Plugins 或设置 TELEBOX_PLUGINS_ROOT。');

function run(args) {
  const result = spawnSync(process.execPath, args, {cwd: root, stdio: 'inherit', shell: false, env});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
run([tsc, '-p', 'tsconfig.v2.json']);
if (plugins) run([tsc, '-p', path.join(plugins, 'tsconfig.v2.json')]);
run([path.join(__dirname, 'build-v2.cjs'), '--test']);
const tests = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile() && file.endsWith('.test.js')) tests.push(file);
  }
}
visit(path.join(root, 'dist/v2'));
if (!tests.length) throw new Error('No compiled v2 tests found');
tests.push(path.join(__dirname, 'node-version.test.cjs'));
tests.push(path.join(__dirname, 'build-v2.test.cjs'));
tests.push(path.join(__dirname, 'build-v2-plugin.test.cjs'));
tests.push(path.join(__dirname, 'server-v2-check.test.cjs'));
tests.push(path.join(__dirname, 'login-v2.test.cjs'));
tests.push(path.join(__dirname, 'install-service.test.cjs'));
tests.push(path.join(__dirname, 'default-plugins.test.cjs'));
tests.push(path.join(__dirname, 'plugin-repository.test.cjs'));
tests.push(path.join(__dirname, 'test-v2-plugins.test.cjs'));
tests.push(path.join(__dirname, 'test-v2-runner.test.cjs'));
tests.push(path.join(__dirname, 'tpm-id-rules.test.cjs'));
tests.push(path.join(__dirname, 'owner-sendas.test.cjs'));
tests.push(path.join(__dirname, 'v2-entrypoints.test.cjs'));
if (plugins) {
  const extensionTests = fs.readdirSync(path.join(plugins, 'scripts'), {withFileTypes: true})
    .filter(entry => entry.isFile() && /-v2(?:-[a-z0-9-]+)?\.test\.js$/.test(entry.name))
    .map(entry => path.join(plugins, 'scripts', entry.name));
  if (!extensionTests.length) throw new Error('No migrated extension tests found');
  tests.push(...extensionTests);
}
run(['--unhandled-rejections=strict', '--test', ...tests.sort()]);
