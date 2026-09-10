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
    // Case-fold collisions are a repository anomaly: two declared ids that only
    // differ by case would map to the same path on case-insensitive filesystems.
    const folded = new Map();
    for (const id of ids) {
      const key = id.toLowerCase();
      const group = folded.get(key) ?? [];
      group.push(id);
      folded.set(key, group);
    }
    const collisions = [...folded.values()].filter(group => group.length > 1);
    if (action === 'search') {
      const descriptions = Object.create(null);
      let descriptionsAvailable = true;
      try {
        const catalog = JSON.parse(git(['show', 'HEAD:plugins.json'], repository));
        if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('Invalid plugin index');
        for (const id of ids) {
          const entry = Object.hasOwn(catalog, id) ? catalog[id] : undefined;
          if (entry && typeof entry.desc === 'string' && entry.desc.trim()) {
            descriptions[id] = entry.desc.replace(/\s+/g, ' ').trim();
          }
        }
      } catch { descriptionsAvailable = false; }
      return {ids, collisions, descriptions, descriptionsAvailable};
    }
    // Resolve user input to the declared id so configuration paths keep their
    // original spelling (for example git_pr -> git_PR). Exact matches win;
    // only a non-exact case-fold collision is reported as AMBIGUOUS.
    const resolve = value => {
      if (ids.includes(value)) return {id: value};
      const matches = ids.filter(name => name.toLowerCase() === value.toLowerCase());
      if (!matches.length) return {error: 'NOT_FOUND'};
      if (matches.length > 1) return {error: 'AMBIGUOUS', ids: matches};
      return {id: matches[0]};
    };
    if (action === 'build') {
      const resolved = resolve(targets[0]);
      if (resolved.error) return {id: targets[0], ...resolved};
      const id = resolved.id;
      git(['sparse-checkout', 'set', '--no-cone', `/${id}/v2.ts`, `/${id}/v2/`], repository);
      git(['checkout', 'HEAD'], repository);
      const {manifest} = buildPlugin({id, packageRoot: path.join(repository, id), entry: 'v2.ts'});
      return {id, revision: manifest.revision};
    }
    const groupOf = new Map();
    for (const group of collisions) for (const id of group) groupOf.set(id, group);
    const excluded = new Set(action === 'build-all' ? targets : []);
    const requested = action === 'build-selected' ? targets.map(value => ({raw: value, ...resolve(value)})) : [];
    const requestedIds = new Set(requested.map(item => item.id).filter(Boolean));
    // A case-fold collision group is only safe to build when exactly one member
    // is requested. Batch/all requests must not check out both spellings into
    // the same case-insensitive directory.
    const blocked = new Set();
    for (const group of collisions) {
      const members = group.filter(id => action === 'build-all' ? !excluded.has(id) : requestedIds.has(id));
      if (members.length > 1) for (const id of members) blocked.add(id);
    }
    const selected = (action === 'build-all' ? ids.filter(value => !excluded.has(value)) : [...requestedIds])
      .filter(id => !blocked.has(id));
    const missing = action === 'build-selected'
      ? requested.filter(item => item.error).map(item => ({id: item.raw, error: item.error, ...(item.ids ? {ids: item.ids} : {})})) : [];
    const conflicts = action === 'build-all'
      ? [...blocked].map(id => ({id, error: 'AMBIGUOUS', ids: groupOf.get(id)}))
      : requested.filter(item => item.id && blocked.has(item.id))
        .map(item => ({id: item.raw, error: 'AMBIGUOUS', ids: groupOf.get(item.id)}));
    if (!selected.length) return {ids, collisions, candidates: [...conflicts, ...missing]};
    git(['sparse-checkout', 'set', '--no-cone', ...selected.flatMap(value => [`/${value}/v2.ts`, `/${value}/v2/`])], repository);
    git(['checkout', 'HEAD'], repository);
    const candidates = selected.map(id => {
      try {
        const {manifest} = buildPlugin({id, packageRoot: path.join(repository, id), entry: 'v2.ts'});
        return {id, revision: manifest.revision};
      } catch { return {id, error: 'BUILD'}; }
    });
    return {ids, collisions, candidates: [...candidates, ...conflicts, ...missing]};
  } finally {fs.rmSync(stage, {recursive: true, force: true});}
}
if (require.main === module) {
  try {console.log(JSON.stringify(run(...process.argv.slice(2))));}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
module.exports = {run};
