import assert from "node:assert/strict";
import test from "node:test";
import {SafeRegExpError, ScopedSafeRegExp} from "./safe-regexp";

test("safe regexp supports Node 24 flags with a fresh lastIndex per evaluation", async () => {
  const matcher = new ScopedSafeRegExp();
  assert.deepEqual(await matcher.test("a", "a", {flags: "g"}), {matched: true, timedOut: false});
  assert.deepEqual(await matcher.test("a", "a", {flags: "g"}), {matched: true, timedOut: false});
  assert.deepEqual(await matcher.test("a", "a", {flags: "d"}), {matched: true, timedOut: false});
  assert.deepEqual(await matcher.test("a", "a", {flags: "v"}), {matched: true, timedOut: false});
  assert.deepEqual(await matcher.test("[a]", "a", {flags: "v"}), {matched: true, timedOut: false});
});

test("sticky matching differs from an unanchored match", async () => {
  const matcher = new ScopedSafeRegExp();
  assert.deepEqual(await matcher.test("b", "ab", {flags: "y"}), {matched: false, timedOut: false});
  assert.deepEqual(await matcher.test("b", "ab"), {matched: true, timedOut: false});
});

test("invalid, duplicate and mutually exclusive flags fail explicitly", async () => {
  const matcher = new ScopedSafeRegExp();
  await assert.rejects(matcher.test("x", "x", {flags: "gg"}), (error: unknown) =>
    error instanceof SafeRegExpError && error.code === "INVALID_PATTERN");
  await assert.rejects(matcher.test("x", "x", {flags: "uv"}), (error: unknown) =>
    error instanceof SafeRegExpError && error.code === "INVALID_PATTERN");
  await assert.rejects(matcher.test("x", "x", {flags: "z"}), (error: unknown) =>
    error instanceof SafeRegExpError && error.code === "INVALID_PATTERN");
});
