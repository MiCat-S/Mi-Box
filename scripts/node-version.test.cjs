'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {assertSupportedNode, requiredMajor} = require('./node-version.cjs');

test('the running Node satisfies engines.node', () => {
  assertSupportedNode();
});

test('any minor and patch of the pinned major pass', () => {
  const major = requiredMajor();
  assertSupportedNode(`${major}.0.0`);
  assertSupportedNode(`${major}.99.7`);
});

test('another major is refused and both versions are named', () => {
  const required = requiredMajor();
  const other = `${required + 1}.0.0`;
  assert.throws(() => assertSupportedNode(other), error =>
    error.message.includes(`Node.js ${required} is required`) && error.message.includes(`v${other}`));
});
