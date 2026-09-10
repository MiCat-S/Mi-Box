'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('Core and extensions share an id only for passive compatibility packages', () => {
  const {pluginIds} = require('./test-v2-plugins.cjs');
  const {buildPlugin} = require('./build-v2-plugin.cjs');
  const preferred = path.resolve(root, '../mibot-plugins');
  const plugins = fs.existsSync(preferred) ? preferred : path.resolve(root, '../TeleBox-Plugins');
  for (const id of pluginIds(plugins)) {
    if (!fs.existsSync(path.join(root, 'src/v2/builtins', `${id}.ts`))) continue;
    const {artifactDir} = buildPlugin({id, packageRoot: path.join(plugins, id), entry: 'v2.ts'});
    const definition = require(path.join(artifactDir, 'index.cjs')).default();
    assert.deepEqual(Object.keys(definition.commands), [], `${id}: commands must have one implementation owner`);
    assert.equal(definition.listeners?.length ?? 0, 0, `${id}: listeners must have one implementation owner`);
    for (const key of ['jobs', 'services']) assert.deepEqual(Object.keys(definition[key] ?? {}), [], `${id}: ${key} must have one implementation owner`);
    for (const key of ['setup', 'cleanup', 'settings']) assert.equal(definition[key], undefined, `${id}: compatibility package must be passive`);
  }
});
test('packaging and runtime agree on the two default repository plugins', () => {
  const {DAILY_PLUGINS} = require('./package-v2-daily.cjs');
  const runtime = require('../dist/v2/runtime.js');
  assert.deepEqual(DAILY_PLUGINS, ['ai', 'gt']);
  assert.deepEqual(runtime.DAILY_PLUGINS, DAILY_PLUGINS);
});
test('runtime loads only the requested default builtins', async () => {
  const [{API}, ts] = await Promise.all([
    import('typescript/unstable/sync'),
    import('typescript/unstable/ast'),
  ]);
  const runtime = path.join(root, 'src/v2/runtime.ts');
  const api = new API({cwd: root});
  try {
    const snapshot = api.updateSnapshot({openFiles: [runtime]});
    const project = snapshot.getDefaultProjectForFile(runtime);
    assert.ok(project);
    const source = project.program.getSourceFile(runtime);
    assert.ok(source);
    const variables = new Map();
    const visitVariables = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer && ts.isCallExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)) {
        variables.set(node.name.text, node.initializer.expression.text);
      }
      node.forEachChild(visitVariables);
    };
    visitVariables(source);
    const builtins = [];
    const visitLoads = node => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'host'
        && node.expression.name.text === 'load') {
        const argument = node.arguments[0];
        const factory = ts.isCallExpression(argument) && ts.isIdentifier(argument.expression)
          ? argument.expression.text
          : ts.isIdentifier(argument) ? variables.get(argument.text) : undefined;
        if (factory?.startsWith('create')) builtins.push(factory.slice('create'.length).toLowerCase());
      }
      node.forEachChild(visitLoads);
    };
    visitLoads(source);
    assert.deepEqual(builtins.sort(), ['agent', 'alias', 'autofix', 'bf', 'env', 'exec', 'help', 'loglevel',
      'memory', 'ping', 'prefix', 'privacy', 'restart', 'status', 'sudo', 'sysinfo', 'tpm', 'update', 'version'].sort());
  } finally {
    api.close();
  }
});
