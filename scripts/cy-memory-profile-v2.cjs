'use strict';

// Offline comparison of the existing renderer and one scoped process per image.
// Run with Node 24 after build:v2; no Telegram session or network access is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fork, spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {setImmediate: turn} = require('node:timers/promises');
const core = path.resolve(__dirname, '..');
const flags = process.argv.slice(2);
const option = name => flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined;
const memory = () => ({...process.memoryUsage(), maxRSSKiB: process.resourceUsage().maxRSS});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function collect() {
  for (let i = 0; i < 3; i++) {await turn(); global.gc();}
}
function tree(root) {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {encoding: 'utf8'});
  if (result.error || result.status !== 0) throw new Error('Cannot sample the process tree with ps');
  const entries = result.stdout.trim().split('\n').map(line => {
    const [pid, parent, rssKiB] = line.trim().split(/\s+/).map(Number);
    return {pid, parent, rssKiB};
  });
  const ids = new Set([root]);
  let size;
  do {size = ids.size; for (const row of entries) if (ids.has(row.parent)) ids.add(row.pid);} while (size !== ids.size);
  const selected = entries.filter(row => ids.has(row.pid));
  let pssKiB = process.platform === 'linux' ? 0 : null;
  for (const row of selected) {
    if (pssKiB === null) break;
    try {
      const data = syncFs.readFileSync(`/proc/${row.pid}/smaps_rollup`, 'utf8');
      const match = data.match(/^Pss:\s+(\d+)/m);
      if (!match) pssKiB = null;
      else pssKiB += Number(match[1]);
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      pssKiB = null;
    }
  }
  return {processes: selected.length, rssKiB: selected.reduce((sum, row) => sum + row.rssKiB, 0), pssKiB};
}

async function render() {
  const [artifact, input, output] = flags.slice(1);
  const cloud = require(artifact);
  const {items, count, validMessages} = JSON.parse(await fs.readFile(input, 'utf8'));
  await fs.writeFile(output, cloud.renderWordCloud(items, count, validMessages), {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({memory: memory()}));
}

function resume(signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {process.off('message', onMessage); signal.removeEventListener('abort', onAbort);};
    const onMessage = message => {if (message !== 'go') return; cleanup(); resolve();};
    const onAbort = () => {cleanup(); reject(new Error('Profile cancelled'));};
    process.on('message', onMessage); signal.addEventListener('abort', onAbort, {once: true});
    if (signal.aborted) onAbort();
  });
}

async function worker() {
  const [mode, artifact, directory, rawRuns] = flags.slice(1);
  const cloud = require(artifact);
  const {ResourceScope} = require(path.join(core, 'dist/v2/lifecycle.js'));
  const {ScopedProcesses} = require(path.join(core, 'dist/v2/processes.js'));
  const scope = new ResourceScope();
  const processes = new ScopedProcesses(scope, {timeoutMs: 60_000, maxOutputBytes: 65536});
  const stop = () => scope.abort();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const counts = new Map();
  for (let i = 0; i < 220; i++) {
    cloud.collectWords(`engine${i} engine${i} engine${i} benchmark${i % 19}`, counts);
  }
  for (let i = 0; i < 20; i++) cloud.collectWords('异步编程 数据分析 开源社区 监控图表', counts);
  const items = cloud.buildWordItems(counts);
  const input = path.join(directory, `${mode}-input.json`);
  await fs.writeFile(input, JSON.stringify({items, count: 500, validMessages: 240}), {flag: 'wx', mode: 0o600});
  await collect();
  const before = memory();
  const go = resume(scope.signal);
  process.send({phase: 'ready'});
  const runs = [];
  try {
    await go;
    for (let i = 0; i < Number(rawRuns); i++) {
      scope.signal.throwIfAborted();
      const output = path.join(directory, `${mode}-${i}.png`);
      const start = performance.now();
      let childMemory;
      if (mode === 'inline') {
        await fs.writeFile(output, cloud.renderWordCloud(items, 500, 240), {flag: 'wx', mode: 0o600});
      } else {
        const result = await processes.run(process.execPath, [__filename, '--render', artifact, input, output],
          {env: process.env, maxOutputBytes: 65536}); // inherited: full parent environment
        childMemory = JSON.parse(result.stdout.toString()).memory;
      }
      const elapsedMs = performance.now() - start;
      const bytes = await fs.readFile(output);
      const entry = {elapsedMs, pngBytes: bytes.length, pngSHA256: digest(bytes), afterRender: memory(), childMemory};
      await collect();
      entry.afterGC = memory();
      runs.push(entry);
      const next = resume(scope.signal);
      process.send({phase: 'idle', index: i});
      await next;
    }
    const canvasLoadedInParent = Object.keys(require.cache).some(file => /[\\/]node_modules[\\/]canvas[\\/]/.test(file));
    const drainReport = await scope.drain();
    assert.equal(drainReport.completed, true);
    const runner = processes.snapshot();
    assert.equal(runner.active, 0);
    assert.equal(runner.queued, 0);
    process.send({phase: 'done', result: {mode, words: items.length, before, runs, canvasLoadedInParent, runner}});
  } catch (error) {
    await scope.drain();
    throw error;
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    process.disconnect();
  }
}

function measure(mode, artifact, directory, runs, interval) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, ['--worker', mode, artifact, directory, String(runs)],
      {execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    const stop = () => child.kill('SIGTERM');
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    let stderr = '', result, timer, samplingError;
    let samples = 0, maxGapMs = 0, last = performance.now();
    const peaks = {rssKiB: 0, pssKiB: null, processes: 0};
    const idle = [];
    const sample = () => {
      try {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - last); last = now;
        const value = tree(child.pid); samples++;
        peaks.rssKiB = Math.max(peaks.rssKiB, value.rssKiB);
        if (value.pssKiB !== null) peaks.pssKiB = Math.max(peaks.pssKiB ?? 0, value.pssKiB);
        peaks.processes = Math.max(peaks.processes, value.processes);
        return value;
      } catch (error) {samplingError = error; child.kill();}
    };
    child.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-65536);});
    child.on('error', reject);
    child.on('message', message => {
      if (message.phase === 'ready') {
        sample(); timer = setInterval(sample, interval); child.send('go');
      } else if (message.phase === 'idle') {
        idle.push(sample()); child.send('go');
      } else if (message.phase === 'done') result = message.result;
    });
    child.on('exit', (code, signal) => {
      clearInterval(timer);
      process.off('SIGTERM', stop); process.off('SIGINT', stop);
      if (samplingError) reject(samplingError);
      else if (code !== 0 || signal || !result) reject(new Error(`Profile ${mode} failed (${code ?? signal}): ${stderr}`));
      else resolve({...result, sampledTreePeak: peaks, idleTrees: idle, samples, maxSampleGapMs: maxGapMs, stderr});
    });
  });
}

async function main() {
  if (flags[0] === '--render') return render();
  if (flags[0] === '--worker') return worker();
  if (flags.includes('--help')) {
    console.log('Usage: node scripts/cy-memory-profile-v2.cjs [--plugins DIR] [--runs 1-20] [--interval-ms 5-1000] [--order inline-first|child-first] [--output NEW_FILE]');
    return;
  }
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Use Node.js 24');
  assert.ok(['linux', 'darwin'].includes(process.platform), 'Profiling requires Linux or macOS');
  const order = option('--order') ?? 'inline-first';
  assert.ok(['inline-first', 'child-first'].includes(order), 'Invalid --order');
  const runs = Number(option('--runs') ?? 5), interval = Number(option('--interval-ms') ?? 20);
  assert.ok(Number.isSafeInteger(runs) && runs >= 1 && runs <= 20, '--runs must be 1–20');
  assert.ok(Number.isSafeInteger(interval) && interval >= 5 && interval <= 1000, '--interval-ms must be 5–1000');
  const plugins = path.resolve(option('--plugins') ?? path.join(core, '../TeleBox-Plugins'));
  await fs.mkdir(path.join(core, 'temp'), {recursive: true});
  const directory = await fs.mkdtemp(path.join(core, 'temp/cy-profile-'));
  try {
    const source = path.join(plugins, 'cy/v2/wordcloud.ts');
    const artifact = path.join(directory, 'wordcloud.cjs');
    require('esbuild').buildSync({entryPoints: [source], outfile: artifact, bundle: true, packages: 'external',
      platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent'});
    const results = [];
    for (const mode of order === 'inline-first' ? ['inline', 'child'] : ['child', 'inline']) results.push(await measure(mode, artifact, directory, runs, interval));
    const hashes = new Set(results.flatMap(result => result.runs.map(run => run.pngSHA256)));
    assert.equal(hashes.size, 1, 'PNG output differs between runs or execution modes');
    assert.equal(results.find(result => result.mode === 'inline').canvasLoadedInParent, true);
    assert.equal(results.find(result => result.mode === 'child').canvasLoadedInParent, false);
    assert.ok(results.every(result => result.idleTrees.every(tree => tree.processes === 1)), 'Child survived a completed render');
    const fonts = ['/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'].filter(file => syncFs.existsSync(file));
    const report = {node: process.version, platform: process.platform, architecture: process.arch, release: os.release(),
      canvas: require('canvas/package.json').version, sourceSHA256: digest(await fs.readFile(source)), fonts,
      runs, order, sampleIntervalMs: interval, pngEquivalent: true, childEnvStrategy: 'inherited',
      notes: ['Synthetic input; no Telegram or HTTP requests.', 'Inline and child render the same compiled code and use the same environment.',
        'Child processes inherit the full parent environment; repeat the measurement with the deployment environment policy if it differs.',
        'RSS sums count shared pages more than once; Linux PSS apportions shared pages.',
        'Sampled peaks are lower bounds. Child maxRSS is reported separately and is not a simultaneous process-tree peak.',
        'Idle samples follow explicit JavaScript GC. Font availability and other plugins affect production results.'], results};
    const text = JSON.stringify(report, null, 2) + '\n';
    if (option('--output')) await fs.writeFile(path.resolve(option('--output')), text, {flag: 'wx', mode: 0o600});
    process.stdout.write(text);
  } finally {await fs.rm(directory, {recursive: true, force: true});}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
