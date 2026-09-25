'use strict';

const {engines} = require('../package.json');

// engines.node pins one major ("24.x"); minor and patch are free.
function requiredMajor() {
  const match = /^(\d+)\.x$/.exec(engines.node ?? '');
  if (!match) throw new Error(`engines.node must look like "24.x", got: ${engines.node}`);
  return Number(match[1]);
}

// Native modules are compiled for one Node ABI and plugin bundles target the
// pinned major, so a build or test run on another major fails later in
// confusing ways. Refuse up front and say what to do instead.
function assertSupportedNode(version = process.versions.node) {
  const required = requiredMajor();
  const running = Number(version.split('.')[0]);
  if (running === required) return;
  throw new Error(
    `Node.js ${required} is required (engines.node = ${engines.node}), but this is v${version}. ` +
    'Switch with `nvm use`, then reinstall dependencies with `npm ci`.');
}

module.exports = {assertSupportedNode, requiredMajor};
