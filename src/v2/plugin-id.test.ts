import test from "node:test";
import assert from "node:assert/strict";
import {isPluginId, resolvePluginId} from "./plugin-id";

test("plugin ids keep the SDK spelling rules", () => {
  for (const value of ["ai", "git_PR", "a", "A1", "9lives", "with-dash", "with_underscore"]) {
    assert.equal(isPluginId(value), true, value);
  }
  for (const value of ["", "-leading", "_leading", "has space", "has/slash", "a".repeat(65), "有中文"]) {
    assert.equal(isPluginId(value), false, value);
  }
});

test("user input resolves to the declared id without changing stored spelling", () => {
  const ids = ["ai", "git_PR", "nezha"];
  assert.deepEqual(resolvePluginId("git_PR", ids), {id: "git_PR"});
  assert.deepEqual(resolvePluginId("git_pr", ids), {id: "git_PR"});
  assert.deepEqual(resolvePluginId("GIT_PR", ids), {id: "git_PR"});
  assert.deepEqual(resolvePluginId("NEZHA", ids), {id: "nezha"});
  assert.deepEqual(resolvePluginId("missing", ids), {error: "NOT_FOUND"});
});

test("case collisions are reported instead of resolved arbitrarily", () => {
  const ids = ["git_PR", "GIT_pr", "ai"];
  assert.deepEqual(resolvePluginId("git_pr", ids), {error: "AMBIGUOUS"});
  assert.deepEqual(resolvePluginId("git_PR", ids), {id: "git_PR"});
});
