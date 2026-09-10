'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pluginIds} = require('./test-v2-plugins.cjs');

test('full plugin verification includes every V2 entry independently of descriptions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mibox-plugin-catalog-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const id of ['listed', 'sure', 're', 'leech', 'git_PR', 'legacy', '.hidden']) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, id === 'legacy' ? 'legacy.ts' : 'v2.ts'), '');
  }
  fs.writeFileSync(path.join(root, 'plugins.json'), JSON.stringify({listed: {desc: 'listed'}, legacy: {desc: 'legacy'}}));
  const expected = ['git_PR', 'leech', 'listed', 're', 'sure'];
  assert.deepEqual(pluginIds(root), expected);
  fs.writeFileSync(path.join(root, 'plugins.json'), '{broken');
  assert.deepEqual(pluginIds(root), expected);
  fs.unlinkSync(path.join(root, 'plugins.json'));
  assert.deepEqual(pluginIds(root), expected);
});
