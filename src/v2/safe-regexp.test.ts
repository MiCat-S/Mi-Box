import assert from "node:assert/strict";
import test from "node:test";
import {performance} from "node:perf_hooks";
import {SafeRegExpError, ScopedSafeRegExp} from "./safe-regexp";

test("safe regexp preserves ordinary matching and supported flags", async () => {
  const matcher = new ScopedSafeRegExp();
  assert.deepEqual(await matcher.test("^hello$", "HELLO", {flags: "i"}), {matched: true, timedOut: false});
  assert.deepEqual(await matcher.test("^hello$", "world"), {matched: false, timedOut: false});
  await assert.rejects(matcher.test("[", "value"), (error: unknown) =>
    error instanceof SafeRegExpError && error.code === "INVALID_PATTERN");
  await assert.rejects(matcher.test("x", "value", {flags: "gg"}), (error: unknown) =>
    error instanceof SafeRegExpError && error.code === "INVALID_PATTERN");
});

test("safe regexp preempts catastrophic backtracking outside the event loop", async () => {
  const matcher = new ScopedSafeRegExp();
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 10);
  const started = performance.now();
  const result = await matcher.test("(a+)+$", `${"a".repeat(30)}!`);
  clearTimeout(timer);
  assert.deepEqual(result, {matched: false, timedOut: true});
  assert.equal(timerFired, true);
  assert.ok(performance.now() - started < 1000);
});

test("safe regexp enforces input budgets and cancellation", async () => {
  const matcher = new ScopedSafeRegExp();
  await assert.rejects(matcher.test("x".repeat(513), ""), (error: unknown) =>
    error instanceof SafeRegExpError && error.code === "INPUT_TOO_LARGE");
  await assert.rejects(matcher.test("x", "x".repeat(4097)), (error: unknown) =>
    error instanceof SafeRegExpError && error.code === "INPUT_TOO_LARGE");
  await assert.rejects(matcher.test("x", "x", {}, AbortSignal.abort()), {name: "AbortError"});
});

test("safe regexp bounds workers, rejects queue overflow and cancels queued work", async () => {
  const matcher = new ScopedSafeRegExp({concurrency: 1, queueCapacity: 1});
  const running = matcher.test("(a+)+$", `${"a".repeat(30)}!`);
  const controller = new AbortController();
  const queued = matcher.test("x", "x", {}, controller.signal);
  await assert.rejects(matcher.test("y", "y"), (error: unknown) =>
    error instanceof SafeRegExpError && error.code === "QUEUE_FULL");
  controller.abort();
  await assert.rejects(queued, {name: "AbortError"});
  assert.deepEqual(await running, {matched: false, timedOut: true});
  assert.deepEqual(await matcher.test("z", "z"), {matched: true, timedOut: false});
});
