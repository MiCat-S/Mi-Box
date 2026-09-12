import {Worker} from "node:worker_threads";
import {SAFE_REGEXP_LIMITS, type SafeRegExpErrorCode, type SafeRegExpOptions, type SafeRegExpResult} from "./sdk";
const WORKER_SOURCE = String.raw`
  const {parentPort} = require("node:worker_threads");
  parentPort.once("message", ({pattern, input, flags}) => {
    try { parentPort.postMessage({matched: new RegExp(pattern, flags).test(input)}); }
    catch { parentPort.postMessage({error: "INVALID_PATTERN"}); }
  });
`;

export class SafeRegExpError extends Error {
  constructor(readonly code: SafeRegExpErrorCode) {
    super(code === "INVALID_PATTERN" ? "Regular expression is invalid"
      : code === "INPUT_TOO_LARGE" ? "Regular expression input exceeds its limit"
      : code === "QUEUE_FULL" ? "Regular expression queue is full"
      : "Regular expression worker failed");
    this.name = "SafeRegExpError";
  }
}

interface QueueEntry {
  readonly signal?: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

export interface ScopedSafeRegExpOptions {
  readonly concurrency?: number;
  readonly queueCapacity?: number;
}

function flags(value: string | undefined): string {
  const selected = value ?? "";
  if (!/^[imsu]*$/.test(selected) || new Set(selected).size !== selected.length) {
    throw new SafeRegExpError("INVALID_PATTERN");
  }
  return selected;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

/** Runs one untrusted pattern in a disposable worker so a timeout can preempt it. */
export class ScopedSafeRegExp {
  private readonly concurrency: number;
  private readonly queueCapacity: number;
  private readonly queue: QueueEntry[] = [];
  private active = 0;

  constructor(options: ScopedSafeRegExpOptions = {}) {
    this.concurrency = options.concurrency ?? SAFE_REGEXP_LIMITS.concurrency;
    this.queueCapacity = options.queueCapacity ?? SAFE_REGEXP_LIMITS.queueCapacity;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 32 ||
        !Number.isInteger(this.queueCapacity) || this.queueCapacity < 0 || this.queueCapacity > 1024) {
      throw new RangeError("Invalid safe regular expression executor limits");
    }
  }

  async test(pattern: string, input: string, options: SafeRegExpOptions = {}, signal?: AbortSignal): Promise<SafeRegExpResult> {
    if (typeof pattern !== "string" || typeof input !== "string" ||
        pattern.length > SAFE_REGEXP_LIMITS.maxPatternLength || input.length > SAFE_REGEXP_LIMITS.maxInputLength) {
      throw new SafeRegExpError("INPUT_TOO_LARGE");
    }
    const selectedFlags = flags(options.flags);
    signal?.throwIfAborted();
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await this.run(pattern, input, selectedFlags, signal);
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.queueCapacity) return Promise.reject(new SafeRegExpError("QUEUE_FULL"));
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {signal, resolve, reject, onAbort: () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError(signal!));
      }};
      this.queue.push(entry);
      signal?.addEventListener("abort", entry.onAbort, {once: true});
    });
  }

  private release(): void {
    this.active -= 1;
    const entry = this.queue.shift();
    if (!entry) return;
    entry.signal?.removeEventListener("abort", entry.onAbort);
    this.active += 1;
    entry.resolve();
  }

  private async run(pattern: string, input: string, selectedFlags: string, signal?: AbortSignal): Promise<SafeRegExpResult> {
    const worker = new Worker(WORKER_SOURCE, {eval: true});
    let termination: Promise<number> | undefined;
    const terminate = (): Promise<number> => {
      termination ??= worker.terminate();
      return termination;
    };
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          worker.removeListener("online", onOnline);
          worker.removeListener("error", onError);
          if (error) reject(error); else resolve();
        };
        const onOnline = (): void => finish();
        const onError = (): void => finish(new SafeRegExpError("WORKER_FAILED"));
        const onAbort = (): void => { void terminate(); finish(abortError(signal!)); };
        const timer = setTimeout(() => { void terminate(); finish(new SafeRegExpError("WORKER_FAILED")); }, SAFE_REGEXP_LIMITS.startupTimeoutMs);
        worker.once("online", onOnline);
        worker.once("error", onError);
        signal?.addEventListener("abort", onAbort, {once: true});
      });
      signal?.throwIfAborted();
      return await new Promise<SafeRegExpResult>((resolve, reject) => {
        let settled = false;
        const finish = (result?: SafeRegExpResult, error?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          worker.removeListener("message", onMessage);
          worker.removeListener("error", onError);
          void terminate();
          if (error) reject(error); else resolve(result!);
        };
        const onMessage = (message: {matched?: unknown; error?: unknown}): void => {
          if (message?.error === "INVALID_PATTERN") finish(undefined, new SafeRegExpError("INVALID_PATTERN"));
          else if (typeof message?.matched === "boolean") finish({matched: message.matched, timedOut: false});
          else finish(undefined, new SafeRegExpError("WORKER_FAILED"));
        };
        const onError = (): void => finish(undefined, new SafeRegExpError("WORKER_FAILED"));
        const onAbort = (): void => finish(undefined, abortError(signal!));
        const timer = setTimeout(() => finish({matched: false, timedOut: true}), SAFE_REGEXP_LIMITS.executionTimeoutMs);
        worker.once("message", onMessage);
        worker.once("error", onError);
        signal?.addEventListener("abort", onAbort, {once: true});
        worker.postMessage({pattern, input, flags: selectedFlags});
      });
    } finally {
      await terminate().catch(() => undefined);
    }
  }
}
