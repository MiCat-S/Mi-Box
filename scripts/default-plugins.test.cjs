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
test('a standalone Core checkout builds and checks while preserving installed extensions and account data', t => {
  const {spawnSync} = require('node:child_process');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mibot-standalone-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const project = path.join(base, 'core');
  fs.mkdirSync(path.join(project, 'scripts'), {recursive: true});
  for (const name of ['build-v2.cjs', 'render-service.cjs']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(project, 'scripts', name));
  for (const name of ['package.json', 'tsconfig.v2.json']) fs.copyFileSync(path.join(root, name), path.join(project, name));
  fs.cpSync(path.join(root, 'src/v2'), path.join(project, 'src/v2'), {recursive: true,
    filter: source => !source.endsWith('.test.ts')});
  fs.cpSync(path.join(root, 'deploy/systemd'), path.join(project, 'deploy/systemd'), {recursive: true});
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  const preserved = ['config.json', 'assets/ai/config.json', 'assets/tpm/releases.json', 'dist/v2-plugins/ai/installed/index.cjs'];
  for (const name of preserved) {
    fs.mkdirSync(path.dirname(path.join(project, name)), {recursive: true});
    fs.writeFileSync(path.join(project, name), 'fixture data');
  }
  const build = spawnSync('npm', ['run', 'package:v2'], {cwd: project, encoding: 'utf8',
    env: {...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH}, timeout: 30000});
  assert.equal(build.status, 0, build.stderr);
  const check = spawnSync(process.execPath, ['dist/v2/index.js', '--check'], {cwd: project, encoding: 'utf8', timeout: 15000});
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).result, 'ok');
  const units = spawnSync(process.execPath, ['scripts/render-service.cjs', 'temp/systemd'], {cwd: project, encoding: 'utf8'});
  assert.equal(units.status, 0, units.stderr);
  assert.equal(fs.existsSync(path.join(project, 'dist/v2-plugins-active')), false);
  assert.deepEqual(fs.readdirSync(base), ['core']);
  for (const name of preserved) assert.equal(fs.readFileSync(path.join(project, name), 'utf8'), 'fixture data', name);
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
