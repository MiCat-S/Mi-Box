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
  for (const name of ['mibot.service', 'mibot-update.service', 'mibot-update-monitor.service', 'mibot-update.timer']) {
    const unit = fs.readFileSync(path.join(base, 'units', name), 'utf8');
    if (name !== 'mibot-update.timer') assert.ok(unit.includes(`WorkingDirectory=${root}/\n`));
    if (name === 'mibot.service') assert.ok(unit.includes(`${root}/dist/v2/index.js`));
    if (name.includes('update') && name.endsWith('.service')) assert.ok(unit.includes(`${root}/scripts/update-service.sh`));
  }
  assert.match(fs.readFileSync(path.join(base, 'units/mibot-update.timer'), 'utf8'), /OnCalendar=\*:0\/10/);
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

test('service generation shares actual repository and Node paths across runtime and update units', () => {
  const {renderUnits} = require('./render-service.cjs');
  for (const root of ['/root/mibot/mibot', '/srv/apps/My Bot']) {
    const units = renderUnits({root, node: '/opt/node24/bin/node', searchPath: '/opt/npm/bin:/usr/bin'});
    for (const name of ['mibot.service', 'mibot-update.service', 'mibot-update-monitor.service']) {
      const unit = units[name];
      assert.ok(unit.includes(`WorkingDirectory=${root}/\n`));
      assert.ok(unit.includes('Environment="PATH=/opt/node24/bin:/opt/npm/bin:/usr/bin:'));
      assert.doesNotMatch(unit, /@[A-Z_]+@/);
    }
    assert.ok(units['mibot.service'].includes(`ExecStart="/opt/node24/bin/node" "${root}/dist/v2/index.js" --serve`));
    assert.ok(units['mibot-update.service'].includes(`ExecStart="/bin/bash" "${root}/scripts/update-service.sh"`));
    assert.ok(units['mibot-update-monitor.service'].includes(`ExecStart="/bin/bash" "${root}/scripts/update-service.sh" --automatic`));
    assert.match(units['mibot-update.timer'], /Unit=mibot-update-monitor\.service/);
    assert.doesNotMatch(units['mibot-update.timer'], /@[A-Z_]+@/);
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

function updateFixture(t, failure = '', rootOption = '', requestId = '') {
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
  if [[ "$1" == rev-parse ]]; then
    if [[ -f .fixture-pulled ]]; then printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;
    else printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi
  elif [[ "$1" == pull ]]; then
    printf '%s\\n' '{"name":"fixture","version":"0.7.6"}' > package.json
    touch .fixture-pulled
  fi
}
npm() {
  printf 'npm %s\\n' "$*" >> "$commands"
  if [[ "$*" == "$FAIL_STEP" ]]; then printf '%s\\n' build-failed >&2; return 7; fi
  if [[ "$1" == ci ]]; then mkdir -p node_modules; fi
}
systemctl() {
  printf 'systemctl %s\\n' "$*" >> "$commands"
  if [[ "$1" == show && "$*" == *InvocationID* ]]; then printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi
}
journalctl() { printf '%s\\n' '{"event":"runtime.ready"}'; }
acquire_update_lock() { return 0; }
shift 3
main "$@"
`;
  const commands = path.join(base, 'commands');
  const selected = path.join(base, 'selected bot');
  if (rootOption) fs.mkdirSync(selected);
  const actualRoot = rootOption ? selected : root;
  fs.writeFileSync(path.join(actualRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(actualRoot, 'package.json'), '{"name":"fixture","version":"0.7.5"}\n');
  if (requestId) {
    fs.mkdirSync(path.join(actualRoot, 'temp'), {recursive: true});
    fs.writeFileSync(path.join(actualRoot, 'temp/update-request.json'), JSON.stringify({requestId}));
  }
  const args = rootOption === '--root' ? ['--root', './selected bot'] : rootOption ? ['./selected bot'] : [];
  const result = spawnSync('bash', ['-c', harness, 'update-test', updater, process.execPath, commands, ...args],
    {cwd: base, encoding: 'utf8', env: {...process.env, FAIL_STEP: failure}});
  return {root: actualRoot, result, calls: fs.readFileSync(commands, 'utf8'),
    receipt: JSON.parse(fs.readFileSync(path.join(actualRoot, 'temp/update-result.json'), 'utf8'))};
}

function automaticUpdateFixture(t, options = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'service-auto-update-')));
  const root = path.join(base, 'deployment');
  fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
  const updater = path.join(root, 'scripts/update-service.sh');
  fs.copyFileSync(path.join(__dirname, 'update-service.sh'), updater);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"0.7.6"}\n');
  fs.mkdirSync(path.join(root, 'temp'));
  const manualReceipt = {status: 'success', reason: 'manual-result'};
  fs.writeFileSync(path.join(root, 'temp/update-result.json'), JSON.stringify(manualReceipt));
  const commands = path.join(base, 'commands');
  const harness = `source "$1"
node_binary="$2"
commands="$3"
node() { "$node_binary" "$@"; }
git() {
  printf 'git %s\\n' "$*" >> "$commands"
  if [[ "$1" == -C ]]; then shift 2; fi
  case "$1" in
    rev-parse)
      if [[ "$*" == *refs/remotes/origin/main* ]]; then printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      elif [[ -f .fixture-merged ]]; then printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      else printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi ;;
    rev-list) printf '%s %s\\n' "$AHEAD" "$BEHIND" ;;
    diff) [[ "$DIRTY" != true ]] ;;
    ls-files) [[ "$UNTRACKED" != true ]] || printf '%s\\n' unexpected-source.ts ;;
    merge)
      printf '%s\\n' '{"name":"fixture","version":"0.7.7"}' > package.json
      printf '%s\\n' '{"lockfileVersion":3,"revision":"new"}' > package-lock.json
      touch .fixture-merged ;;
    reset)
      printf '%s\\n' '{"name":"fixture","version":"0.7.6"}' > package.json
      printf '%s\\n' '{"lockfileVersion":3}' > package-lock.json
      rm -f .fixture-merged ;;
  esac
}
npm() {
  printf 'npm %s\\n' "$*" >> "$commands"
  if [[ "$*" == "$FAIL_STEP" && ! -f .fixture-failed ]]; then
    touch .fixture-failed
    printf '%s\\n' automatic-build-failed >&2
    return 7
  fi
  if [[ "$1" == ci ]]; then mkdir -p node_modules; fi
}
systemctl() {
  printf 'systemctl %s\\n' "$*" >> "$commands"
  if [[ "$1" == show && "$*" == *InvocationID* ]]; then printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi
}
journalctl() { printf '%s\\n' '{"event":"runtime.ready"}'; }
acquire_update_lock() { return 0; }
shift 3
main --automatic --root "$1"
`;
  const result = spawnSync('bash', ['-c', harness, 'automatic-update-test', updater, process.execPath, commands, root],
    {cwd: root, encoding: 'utf8', env: {...process.env, AHEAD: String(options.ahead ?? 0),
      BEHIND: String(options.behind ?? 1), DIRTY: String(options.dirty ?? false),
      UNTRACKED: String(options.untracked ?? false),
      FAIL_STEP: options.failure ?? ''}});
  const resultFile = path.join(root, 'temp/automatic-update-result.json');
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  return {root, result, calls: fs.readFileSync(commands, 'utf8'),
    receipt: fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : undefined,
    manualReceipt: JSON.parse(fs.readFileSync(path.join(root, 'temp/update-result.json'), 'utf8'))};
}

test('updater accepts an explicit deployment using named or positional paths', t => {
  for (const option of ['--root', 'positional']) {
    const {root, result, calls, receipt} = updateFixture(t, '', option);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls.startsWith(`git -C ${root} rev-parse --is-inside-work-tree\n`));
    assert.match(calls, /systemctl restart mibot.service/);
    assert.deepEqual(receipt, {status: 'success', reason: '', previousVersion: '0.7.5', currentVersion: '0.7.6',
      previousRevision: 'a'.repeat(40), currentRevision: 'b'.repeat(40)});
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
  assert.match(calls,
    /npm ci\nnpm run package:v2\nnpm run check:v2\nsystemctl restart mibot.service\nsystemctl show mibot.service -p InvocationID --value\n$/);
  assert.deepEqual(receipt, {status: 'success', reason: '', previousVersion: '0.7.5', currentVersion: '0.7.6',
    previousRevision: 'a'.repeat(40), currentRevision: 'b'.repeat(40)});
});

test('updater preserves a failed step exit code and does not restart after failed build', t => {
  const {result, calls, receipt} = updateFixture(t, 'run package:v2');
  assert.equal(result.status, 7, result.stderr);
  assert.doesNotMatch(calls, /systemctl|run check:v2/);
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.reason, /构建主程序失败（退出码 7）：build-failed/);
});

test('updater carries the accepted request id into its atomic result', t => {
  const requestId = '12345678-1234-4234-8234-123456789abc';
  const {root, result, receipt} = updateFixture(t, '', '--root', requestId);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(receipt, {status: 'success', reason: '', requestId,
    previousVersion: '0.7.5', currentVersion: '0.7.6', previousRevision: 'a'.repeat(40),
    currentRevision: 'b'.repeat(40)});
  assert.equal(fs.existsSync(path.join(root, 'temp/update-request.json')), false);
  assert.equal(fs.readdirSync(path.join(root, 'temp')).some(name => name.startsWith('update-request.claim.')), false);
});

test('automatic checks leave a current deployment untouched and silent', t => {
  const {result, calls, receipt} = automaticUpdateFixture(t, {behind: 0});
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /git fetch origin main/);
  assert.match(calls, /git rev-list --left-right --count HEAD\.\.\.refs\/remotes\/origin\/main/);
  assert.doesNotMatch(calls, /git merge|npm |systemctl restart/);
  assert.equal(receipt, undefined);
});

test('automatic checks fast-forward, verify readiness and record an isolated deduplicated result', t => {
  const {result, calls, receipt, manualReceipt} = automaticUpdateFixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /git merge --ff-only refs\/remotes\/origin\/main/);
  assert.match(calls, /systemctl restart mibot.service/);
  assert.deepEqual(receipt, {
    status: 'success', reason: '', previousVersion: '0.7.6', currentVersion: '0.7.7',
    previousRevision: 'a'.repeat(40), currentRevision: 'b'.repeat(40),
    trigger: 'automatic', automaticId: receipt.automaticId,
  });
  assert.match(receipt.automaticId, /^[0-9a-f]{64}$/);
  assert.deepEqual(manualReceipt, {status: 'success', reason: 'manual-result'});
});

test('automatic checks refuse tracked changes before updating', t => {
  const {result, calls, receipt} = automaticUpdateFixture(t, {dirty: true});
  assert.equal(result.status, 1);
  assert.doesNotMatch(calls, /git merge|npm |systemctl restart/);
  assert.match(receipt.reason, /未提交的已跟踪文件变更/);
  assert.equal(receipt.trigger, 'automatic');
});

test('automatic checks refuse untracked files before updating', t => {
  const {result, calls, receipt} = automaticUpdateFixture(t, {untracked: true});
  assert.equal(result.status, 1);
  assert.doesNotMatch(calls, /git merge|npm |systemctl restart/);
  assert.match(receipt.reason, /未提交的未跟踪文件/);
  assert.equal(receipt.trigger, 'automatic');
});

test('automatic update failures restore the verified previous revision', t => {
  const {root, result, calls, receipt} = automaticUpdateFixture(t, {failure: 'run package:v2'});
  assert.equal(result.status, 7);
  assert.match(calls, /git reset --hard a{40}/);
  assert.equal(calls.match(/^npm ci$/gm)?.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.7.6');
  const fingerprint = require('node:crypto').createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex');
  assert.equal(fs.readFileSync(path.join(root, 'node_modules/.mibot-package-lock.sha256'), 'utf8'), fingerprint + '\n');
  assert.match(receipt.reason, /构建主程序失败.*已自动恢复上一版本/);
  assert.equal(receipt.currentRevision, 'a'.repeat(40));
});

test('automatic failure and success results for one remote revision have distinct notification ids', t => {
  const failed = automaticUpdateFixture(t, {failure: 'run package:v2'});
  const succeeded = automaticUpdateFixture(t);
  assert.equal(failed.result.status, 7);
  assert.equal(succeeded.result.status, 0, succeeded.result.stderr);
  assert.notEqual(failed.receipt.automaticId, succeeded.receipt.automaticId);
});

test('a rejected updater lock does not consume or overwrite another request', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'service-update-lock-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'deployment');
  fs.mkdirSync(path.join(root, 'temp'), {recursive: true});
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const request = {requestId: '12345678-1234-4234-8234-123456789abc'};
  const previous = {status: 'success', reason: 'previous', requestId: '87654321-4321-4321-8321-cba987654321'};
  fs.writeFileSync(path.join(root, 'temp/update-request.json'), JSON.stringify(request));
  fs.writeFileSync(path.join(root, 'temp/update-result.json'), JSON.stringify(previous));
  const updater = path.join(__dirname, 'update-service.sh');
  const harness = 'source "$1"; git() { :; }; acquire_update_lock() { return 3; }; main "$2"';
  const result = spawnSync('bash', ['-c', harness, 'lock-test', updater, root], {encoding: 'utf8'});
  assert.equal(result.status, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'temp/update-request.json'), 'utf8')), request);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'temp/update-result.json'), 'utf8')), previous);
});

test('updater retries dependency installation after an interrupted npm ci', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'service-update-retry-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'deployment');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(path.join(root, 'node_modules'), {recursive: true});
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"dep":{"version":"1"}}}\n');
  const executable = (name, body) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, body, {mode: 0o755});
  };
  executable('git', '#!/bin/bash\nif [[ "$1" == -C ]]; then shift 2; fi\nif [[ "$1" == rev-parse ]]; then echo true; fi\n');
  executable('npm', `#!/bin/bash
printf '%s\\n' "$*" >> calls
if [[ "$1" == ci ]]; then
  mkdir -p node_modules
  if [[ ! -f attempted ]]; then touch attempted node_modules/incomplete; exit 27; fi
  rm -f node_modules/incomplete
elif [[ "$1 $2" == 'run package:v2' && -f node_modules/incomplete ]]; then
  exit 34
fi
`);
  executable('systemctl', '#!/bin/bash\nprintf "%s\\n" "systemctl $*" >> calls\nif [[ "$1" == show && "$*" == *InvocationID* ]]; then printf "%s\\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi\n');
  executable('journalctl', '#!/bin/bash\nprintf "%s\\n" "{\\"event\\":\\"runtime.ready\\"}"\n');
  const updater = path.join(__dirname, 'update-service.sh');
  const harness = 'source "$1"; acquire_update_lock() { :; }; main "$2"';
  const run = () => spawnSync('bash', ['-c', harness, 'retry-test', updater, root], {cwd: root, encoding: 'utf8',
    env: {...process.env, PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + process.env.PATH}});
  assert.equal(run().status, 27);
  assert.equal(run().status, 0);
  const calls = fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n');
  assert.equal(calls.filter(call => call === 'ci').length, 2);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/incomplete')), false);
  assert.match(fs.readFileSync(path.join(root, 'node_modules/.mibot-package-lock.sha256'), 'utf8'), /^[0-9a-f]{64}\n$/);
});

test('installer rollback restores runtime and automatic update units while preserving account data', t => {
  const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'service-restore-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  fs.mkdirSync(path.join(base, 'backup'));
  fs.mkdirSync(path.join(base, 'dist/v2'), {recursive: true});
  fs.writeFileSync(path.join(base, 'backup/service.before'), 'previous runtime unit');
  fs.writeFileSync(path.join(base, 'backup/update-service.before'), 'previous update unit');
  fs.writeFileSync(path.join(base, 'backup/update-monitor-service.before'), 'previous update monitor unit');
  fs.writeFileSync(path.join(base, 'backup/update-timer.before'), 'previous update timer');
  fs.writeFileSync(path.join(base, 'mibot.service'), 'candidate runtime unit');
  fs.writeFileSync(path.join(base, 'mibot-update.service'), 'candidate update unit');
  fs.writeFileSync(path.join(base, 'mibot-update-monitor.service'), 'candidate update monitor unit');
  fs.writeFileSync(path.join(base, 'mibot-update.timer'), 'candidate update timer');
  fs.writeFileSync(path.join(base, 'config.json'), 'account fixture');
  const source = fs.readFileSync(script, 'utf8');
  const restore = source.slice(source.indexOf('restore() {'), source.indexOf('trap restore EXIT'))
    .replaceAll('/usr/bin/systemctl', 'systemctl');
  const result = spawnSync('bash', ['-c', `backup="$PWD/backup"
unit="$PWD/mibot.service"
update_unit="$PWD/mibot-update.service"
update_monitor_unit="$PWD/mibot-update-monitor.service"
update_timer_unit="$PWD/mibot-update.timer"
changed=true
systemctl() { return 0; }
${restore}
(exit 7)
restore`, 'rollback-test'], {cwd: base, encoding: 'utf8'});
  assert.equal(result.status, 7, result.stderr);
  assert.equal(fs.readFileSync(path.join(base, 'mibot.service'), 'utf8'), 'previous runtime unit');
  assert.equal(fs.readFileSync(path.join(base, 'mibot-update.service'), 'utf8'), 'previous update unit');
  assert.equal(fs.readFileSync(path.join(base, 'mibot-update-monitor.service'), 'utf8'), 'previous update monitor unit');
  assert.equal(fs.readFileSync(path.join(base, 'mibot-update.timer'), 'utf8'), 'previous update timer');
  assert.equal(fs.readFileSync(path.join(base, 'config.json'), 'utf8'), 'account fixture');
});
