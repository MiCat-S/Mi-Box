'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {buildPlugin} = require('./build-v2-plugin.cjs');

function run(action, ...targets) {
  const validId = value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
  if (!['search', 'build', 'build-all', 'build-selected'].includes(action) ||
      action === 'build' && (targets.length !== 1 || !validId(targets[0])) ||
      ['build-all', 'build-selected'].includes(action) && targets.some(id => !validId(id))) throw new Error('Invalid plugin request');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-plugins-'));
  try {
    const repository = path.join(stage, 'repository');
    const git = (args, cwd) => {
      const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args],
        {cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
          env: {...process.env, GIT_TERMINAL_PROMPT: '0'}});
      if (result.error || result.status !== 0) throw new Error('Plugin repository unavailable');
      return result.stdout;
    };
    git(['clone', '--filter=blob:none', '--no-checkout', '--depth=1', '--branch=main',
      '--single-branch', 'https://github.com/MiCat-S/Mi-Box-Plugins.git', repository],
      stage);
    const ids = git(['ls-tree', '-r', '--name-only', 'HEAD'], repository).split('\n')
      .filter(file => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/v2\.ts$/.test(file))
      .map(file => file.split('/')[0]).sort();
    if (action === 'search') return {ids};
    // Resolve user input to the declared id so configuration paths keep their
    // original spelling (for example git_pr -> git_PR). Exact matches win.
    const resolve = value => {
      if (ids.includes(value)) return value;
      const matches = ids.filter(name => name.toLowerCase() === value.toLowerCase());
      if (matches.length > 1) throw new Error('Ambiguous plugin id');
      return matches[0];
    };
    if (action === 'build') {
      const id = resolve(targets[0]);
      if (!id) throw new Error('V2 plugin not available');
      git(['sparse-checkout', 'set', '--no-cone', `/${id}/v2.ts`, `/${id}/v2/`], repository);
      git(['checkout', 'HEAD'], repository);
      const {manifest} = buildPlugin({id, packageRoot: path.join(repository, id), entry: 'v2.ts'});
      return {id, revision: manifest.revision};
    }
    const excluded = new Set(action === 'build-all' ? targets : []);
    const requested = action === 'build-selected' ? targets.map(value => ({raw: value, id: resolve(value)})) : [];
    const selected = action === 'build-all' ? ids.filter(value => !excluded.has(value))
      : [...new Set(requested.map(item => item.id).filter(Boolean))];
    const missing = action === 'build-selected'
      ? requested.filter(item => !item.id).map(item => ({id: item.raw, error: 'NOT_AVAILABLE'})) : [];
    if (!selected.length) return {ids, candidates: missing};
    git(['sparse-checkout', 'set', '--no-cone', ...selected.flatMap(value => [`/${value}/v2.ts`, `/${value}/v2/`])], repository);
    git(['checkout', 'HEAD'], repository);
    const candidates = selected.map(id => {
      try {
        const {manifest} = buildPlugin({id, packageRoot: path.join(repository, id), entry: 'v2.ts'});
        return {id, revision: manifest.revision};
      } catch { return {id, error: 'BUILD'}; }
    });
    return {ids, candidates: [...candidates, ...missing]};
  } finally {fs.rmSync(stage, {recursive: true, force: true});}
}
if (require.main === module) {
  try {console.log(JSON.stringify(run(...process.argv.slice(2))));}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
module.exports = {run};
