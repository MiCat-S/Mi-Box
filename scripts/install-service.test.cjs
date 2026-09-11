'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const script = path.join(__dirname, 'install-service.sh');
test('service installer passes bash syntax validation', () => {
  const result = spawnSync('bash', ['-n', script], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});
test('installer help is available without root or systemd and does not install', () => {
  const result = spawnSync('bash', [script, '--help'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Requires Linux\/systemd/);
  assert.match(result.stdout, /Refuses active or enabled services/);
});
test('installer rejects unexpected arguments before operating on host', () => {
  const result = spawnSync('bash', [script, '--force'], {encoding: 'utf8'});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unsupported arguments/);
});
test('public installer command and documented invocation match', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['service:install'], 'bash scripts/install-service.sh');
  assert.match(fs.readFileSync(path.join(root, 'INSTALL.md'), 'utf8'), /npm run service:install/);
});

test('installer validates option values before operating on the host', () => {
  for (const option of ['--root', '--node']) {
    for (const extra of [[], ['--node', '/tmp/node']]) {
      const result = spawnSync('bash', [script, option, ...extra], {encoding: 'utf8'});
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Missing value/);
    }
  }
});

test('installer resolves caller-relative paths before entering the selected deployment', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'service-install-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  fs.mkdirSync(path.join(base, 'deployed bot'));
  fs.symlinkSync(path.join(base, 'deployed bot'), path.join(base, 'alias'));
  const source = fs.readFileSync(script, 'utf8');
  // Exercise argument and path handling, stopping before systemd or account operations.
  const setup = source.slice(0, source.indexOf('for executable in '))
    .replace(/^\[\[ \$\(uname -s\).*$/m, '');
  const result = spawnSync('bash', ['-c', `${setup}\nprintf '%s\\n' "$PWD" "$node"`,
    script, '--root', './alias', '--node', process.execPath], {cwd: base, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [path.join(base, 'deployed bot'), process.execPath]);
});

test('renderer CLI uses the selected deployment without a plugin source checkout', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'service-render-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'nested', 'deployed bot');
  fs.mkdirSync(root, {recursive: true});
  fs.symlinkSync(root, path.join(base, 'alias'));
  const result = spawnSync(process.execPath, [path.join(__dirname, 'render-service.cjs'), './units', '--root', './alias'],
    {cwd: base, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['mibot.service', 'mibot-update.service']) {
    const unit = fs.readFileSync(path.join(base, 'units', name), 'utf8');
    assert.ok(unit.includes(`WorkingDirectory=${root}/\n`));
    assert.ok(unit.includes(name === 'mibot.service' ? `${root}/dist/v2/index.js` : `${root}/scripts/update-service.sh`));
  }
});

test('renderer rejects invalid arguments before writing service files', t => {
  const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'service-invalid-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  for (const args of [['--root'], ['--root', '--help'], ['--force']]) {
    const output = path.join(base, 'units');
    const result = spawnSync(process.execPath, [path.join(__dirname, 'render-service.cjs'), output, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing value|Unsupported argument/);
    assert.equal(fs.existsSync(output), false);
  }
});

test('service generation shares actual repository and Node paths across both units', () => {
  const {renderUnits} = require('./render-service.cjs');
  for (const root of ['/root/mibot/mibot', '/srv/apps/My Bot']) {
    const units = renderUnits({root, node: '/opt/node24/bin/node', searchPath: '/opt/npm/bin:/usr/bin'});
    for (const unit of Object.values(units)) {
      assert.ok(unit.includes(`WorkingDirectory=${root}/\n`));
      assert.ok(unit.includes('Environment="PATH=/opt/node24/bin:/opt/npm/bin:/usr/bin:'));
      assert.doesNotMatch(unit, /@[A-Z_]+@/);
    }
    assert.ok(units['mibot.service'].includes(`ExecStart="/opt/node24/bin/node" "${root}/dist/v2/index.js" --serve`));
    assert.ok(units['mibot-update.service'].includes(`ExecStart="/bin/bash" "${root}/scripts/update-service.sh"`));
  }
});

test('service generation preserves literal percent, dollar, quotes and spaces in paths', () => {
  const {renderUnits} = require('./render-service.cjs');
  const root = '/srv/50%/bot $name "quoted"';
  const unit = renderUnits({root, node: '/opt/node/bin/node', searchPath: '/usr/bin'})['mibot.service'];
  assert.ok(unit.includes('WorkingDirectory=/srv/50%%/bot $name "quoted"/\n'));
  assert.ok(unit.includes('"/srv/50%%/bot $$name \\"quoted\\"/dist/v2/index.js"'));
  assert.throws(() => renderUnits({root: '/srv/bot\nExecStart=/bin/false', node: '/bin/node'}), /control characters/);
});

function updateFixture(t, failure = '', rootOption = '') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'service-update-')));
  const root = path.join(base, 'nested bot');
  fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
  const updater = path.join(root, 'scripts/update-service.sh');
  fs.copyFileSync(path.join(__dirname, 'update-service.sh'), updater);
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  // Replace external operations with shell functions; execute the original updater functions.
  const harness = `source "$1"
node_binary="$2"
commands="$3"
node() { "$node_binary" "$@"; }
git() {
  printf 'git %s\\n' "$*" >> "$commands"
  if [[ "$1" == rev-parse ]]; then printf '%s\\n' fixture-head; fi
}
npm() {
  printf 'npm %s\\n' "$*" >> "$commands"
  if [[ "$*" == "$FAIL_STEP" ]]; then printf '%s\\n' build-failed >&2; return 7; fi
}
systemctl() { printf 'systemctl %s\\n' "$*" >> "$commands"; }
acquire_update_lock() { return 0; }
shift 3
main "$@"
`;
  const commands = path.join(base, 'commands');
  const selected = path.join(base, 'selected bot');
  if (rootOption) fs.mkdirSync(selected);
  const args = rootOption === '--root' ? ['--root', './selected bot'] : rootOption ? ['./selected bot'] : [];
  const result = spawnSync('bash', ['-c', harness, 'update-test', updater, process.execPath, commands, ...args],
    {cwd: base, encoding: 'utf8', env: {...process.env, FAIL_STEP: failure}});
  const actualRoot = rootOption ? selected : root;
  return {root: actualRoot, result, calls: fs.readFileSync(commands, 'utf8'),
    receipt: JSON.parse(fs.readFileSync(path.join(actualRoot, 'temp/update-result.json'), 'utf8'))};
}

test('updater accepts an explicit deployment using named or positional paths', t => {
  for (const option of ['--root', 'positional']) {
    const {root, result, calls, receipt} = updateFixture(t, '', option);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls.startsWith(`git -C ${root} rev-parse --is-inside-work-tree\n`));
    assert.match(calls, /systemctl restart mibot.service/);
    assert.deepEqual(receipt, {status: 'success', reason: ''});
  }
});

test('updater help and invalid arguments never enter update operations', () => {
  const updater = path.join(__dirname, 'update-service.sh');
  for (const args of [['--help'], ['--root'], ['--root', '--help'], ['--force']]) {
    const result = spawnSync('bash', [updater, ...args], {encoding: 'utf8'});
    assert.equal(result.status, args[0] === '--help' ? 0 : 2, result.stderr);
    assert.match(result.stdout + result.stderr, /Usage: bash scripts\/update-service.sh/);
  }
});

test('updater detects a nested repository from its script and records successful restart', t => {
  const {root, result, calls, receipt} = updateFixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.startsWith(`git -C ${root} rev-parse --is-inside-work-tree\n`));
  assert.match(calls, /npm ci\nnpm run package:v2\nnpm run check:v2\nsystemctl restart mibot.service\n$/);
  assert.deepEqual(receipt, {status: 'success', reason: ''});
});

test('updater preserves a failed step exit code and does not restart after failed build', t => {
  const {result, calls, receipt} = updateFixture(t, 'run package:v2');
  assert.equal(result.status, 7, result.stderr);
  assert.doesNotMatch(calls, /systemctl|run check:v2/);
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.reason, /构建主程序失败（退出码 7）：build-failed/);
});

test('installer rollback restores both service units and preserves account data', t => {
  const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'service-restore-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  fs.mkdirSync(path.join(base, 'backup'));
  fs.mkdirSync(path.join(base, 'dist/v2'), {recursive: true});
  fs.writeFileSync(path.join(base, 'backup/service.before'), 'previous runtime unit');
  fs.writeFileSync(path.join(base, 'backup/update-service.before'), 'previous update unit');
  fs.writeFileSync(path.join(base, 'mibot.service'), 'candidate runtime unit');
  fs.writeFileSync(path.join(base, 'mibot-update.service'), 'candidate update unit');
  fs.writeFileSync(path.join(base, 'config.json'), 'account fixture');
  const source = fs.readFileSync(script, 'utf8');
  const restore = source.slice(source.indexOf('restore() {'), source.indexOf('trap restore EXIT'))
    .replaceAll('/usr/bin/systemctl', 'systemctl');
  const result = spawnSync('bash', ['-c', `backup="$PWD/backup"
unit="$PWD/mibot.service"
update_unit="$PWD/mibot-update.service"
changed=true
systemctl() { return 0; }
${restore}
(exit 7)
restore`, 'rollback-test'], {cwd: base, encoding: 'utf8'});
  assert.equal(result.status, 7, result.stderr);
  assert.equal(fs.readFileSync(path.join(base, 'mibot.service'), 'utf8'), 'previous runtime unit');
  assert.equal(fs.readFileSync(path.join(base, 'mibot-update.service'), 'utf8'), 'previous update unit');
  assert.equal(fs.readFileSync(path.join(base, 'config.json'), 'utf8'), 'account fixture');
});
