'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {resolvePluginRoot} = require('./package-v2-daily.cjs');

function quote(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Service paths must not contain control characters');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
}

// Exec arguments expand dollars independently of unit-file quoting.
const argument = value => quote(value.replace(/\$/g, () => '$$'));

function renderUnits({root, node, plugins, searchPath = process.env.PATH || '', bash = '/bin/bash'}) {
  for (const value of [root, node, plugins, bash]) {
    if (!path.isAbsolute(value)) throw new Error('Service paths must be absolute');
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Service paths must not contain control characters');
  }
  const commandPath = [...new Set([path.dirname(node), ...searchPath.split(path.delimiter).filter(path.isAbsolute),
    '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'])].join(path.delimiter);
  const replacements = {
    // WorkingDirectory takes a literal path, unlike the quoted Exec/Environment fields.
    ROOT: root.replace(/%/g, '%%') + '/', NODE: quote(node), RUNTIME: argument(path.join(root, 'dist/v2/index.js')),
    BASH: quote(bash), UPDATE_SCRIPT: argument(path.join(root, 'scripts/update-service.sh')),
    PATH: quote(`PATH=${commandPath}`), PLUGINS: quote(`MIBOT_PLUGINS_DIR=${plugins}`),
  };
  return Object.fromEntries(['mibot.service', 'mibot-update.service'].map(name => {
    const template = fs.readFileSync(path.join(__dirname, '../deploy/systemd', name), 'utf8');
    const content = template.replace(/@([A-Z_]+)@/g, (_match, key) => {
      if (!Object.hasOwn(replacements, key)) throw new Error(`Unknown service placeholder: ${key}`);
      return replacements[key];
    });
    return [name, content];
  }));
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3 || process.argv[2].startsWith('--')) throw new Error('Usage: node scripts/render-service.cjs OUTPUT_DIRECTORY');
    if (process.versions.node.split('.')[0] !== '24') throw new Error('Node 24 required');
    const root = fs.realpathSync(path.resolve(__dirname, '..'));
    const units = renderUnits({root, node: process.execPath, plugins: resolvePluginRoot(root)});
    fs.mkdirSync(process.argv[2], {recursive: true});
    for (const [name, content] of Object.entries(units)) fs.writeFileSync(path.join(process.argv[2], name), content, {mode: 0o600});
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}

module.exports = {renderUnits};
