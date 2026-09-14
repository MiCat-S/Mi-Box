'use strict';
const fs = require('node:fs');
const path = require('node:path');

function findPlugins(root, environment = process.env) {
  const explicit = environment.TELEBOX_PLUGINS_ROOT;
  const candidates = explicit !== undefined
    ? [path.resolve(root, explicit)]
    : [path.resolve(root, '../mibot-plugins'), path.resolve(root, '../TeleBox-Plugins')];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) && explicit === undefined) continue;
    if (!fs.existsSync(path.join(candidate, 'tsconfig.v2.json')) ||
        !fs.existsSync(path.join(candidate, 'scripts')) ||
        !fs.statSync(path.join(candidate, 'scripts')).isDirectory()) {
      throw new Error(`Invalid plugin checkout: ${candidate} (requires tsconfig.v2.json and scripts/)`);
    }
    return candidate;
  }
  return undefined;
}

module.exports = {findPlugins};
