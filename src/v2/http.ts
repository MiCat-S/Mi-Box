import { ResourceScope } from "./lifecycle";
import {lookup as dnsLookup, type LookupAddress} from "node:dns";
import {BlockList, isIP} from "node:net";
import {Agent} from "undici";

const messages = {
  ABORTED: "HTTP operation was cancelled",
  TIMEOUT: "HTTP operation exceeded its deadline",
  RESPONSE_TOO_LARGE: "HTTP response exceeded the byte limit",
  INVALID_JSON: "HTTP response is not valid JSON",
  DNS_FAILED: "HTTP hostname resolution failed",
  CONNECTION_REFUSED: "HTTP connection was refused",
  FAILED: "HTTP operation failed",
  CLEANUP_FAILED: "HTTP response cleanup failed",
  REDIRECT_BLOCKED: "HTTP redirect target is not allowed",
  TOO_MANY_REDIRECTS: "HTTP response exceeded the redirect limit",
  ADDRESS_BLOCKED: "HTTP target address is not allowed",
  CLOSED: "HTTP response lifetime ended",
} as const;

export type HttpErrorCode = keyof typeof messages;

export class HttpError extends Error {
  readonly code: HttpErrorCode;

  constructor(code: HttpErrorCode) {
    super(messages[code]);
    this.name = "HttpError";
    this.code = code;
  }
}

/** Opt-in status policy: throw this from consume when a status is unacceptable. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new RangeError("HTTP status must be an integer between 100 and 599");
    }
    super(`HTTP response status ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export interface ScopedHttpOptions {
  fetch?: typeof fetch;
  /** Test seam for the public-address dispatcher. */
  lookup?: typeof dnsLookup;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface HttpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** When set, redirects are followed manually and every target hostname is checked. */
  redirects?: {
    allowedHosts: readonly string[];
    maxRedirects?: number;
  };
  /** Resolve and connect only to public Internet addresses, including every redirect. */
  denyPrivateAddresses?: boolean;
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");

function ipv6Words(address: string): number[] | undefined {
  let source = address.toLowerCase().split("%", 1)[0]!;
  const dotted = source.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dotted) {
    const octets = dotted.split(".").map(Number);
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return;
    source = `${source.slice(0, -dotted.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return;
  const words = [...left, ...Array(missing).fill("0"), ...right].map(value => /^[0-9a-f]{1,4}$/.test(value) ? Number.parseInt(value, 16) : -1);
  return words.length === 8 && words.every(value => value >= 0 && value <= 0xffff) ? words : undefined;
}

function embeddedIpv4(address: string): string | undefined {
  const words = ipv6Words(address);
  if (!words) return;
  const mapped = words.slice(0, 5).every(value => value === 0) && words[5] === 0xffff;
  const wellKnownNat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(value => value === 0);
  if (!mapped && !wellKnownNat64) return;
  return `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`;
}

function addressBlocked(address: string, family?: number): boolean {
  const detected = family === 4 || family === 6 ? family : isIP(address);
  if (!detected) return true;
  const embedded = detected === 6 ? embeddedIpv4(address) : undefined;
  return embedded ? blockedAddresses.check(embedded, "ipv4")
    : blockedAddresses.check(address, detected === 4 ? "ipv4" : "ipv6");
}

function blockedAddressError(): Error & {code: string} {
  return Object.assign(new Error("Blocked address"), {code: "TELEBOX_ADDRESS_BLOCKED"});
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

function createPublicLookup(resolve: typeof dnsLookup) {
  return (hostname: string, options: {family?: number; hints?: number; all?: boolean}, callback: LookupCallback): void => {
  resolve(hostname, {...options, all: true}, (error, addresses) => {
    if (error) { callback(error); return; }
    if (!addresses.length || addresses.some(item => addressBlocked(item.address, item.family))) {
      callback(blockedAddressError());
      return;
    }
    const selected = options.family ? addresses.filter(item => item.family === options.family) : addresses;
    if (!selected.length) { callback(blockedAddressError()); return; }
    if (options.all) callback(null, selected);
    else callback(null, selected[0]!.address, selected[0]!.family);
  });
  };
}

function publicTarget(input: string | URL): URL {
  let url: URL;
  try { url = new URL(input.toString()); }
  catch { throw new HttpError("ADDRESS_BLOCKED"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError("ADDRESS_BLOCKED");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || family && addressBlocked(hostname, family)) {
    throw new HttpError("ADDRESS_BLOCKED");
  }
  return url;
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be finite and between 0 and 2147483647");
  }
}

function redirectConfiguration(options: HttpRequestOptions["redirects"]): {allowed: ReadonlySet<string>; maximum: number} | undefined {
  if (!options) return;
  if (!Array.isArray(options.allowedHosts) || options.allowedHosts.length === 0) {
    throw new TypeError("Redirect policy requires at least one hostname");
  }
  const allowed = new Set<string>();
  for (const host of options.allowedHosts) {
    if (typeof host !== "string" || !host || host !== host.trim() || /[/:@\s\0]/u.test(host)) {
      throw new TypeError("Redirect policy contains an invalid hostname");
    }
    allowed.add(host.toLowerCase());
  }
  const maximum = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 20) {
    throw new RangeError("maxRedirects must be an integer between 0 and 20");
  }
  return {allowed, maximum};
}

function allowedURL(input: string | URL, base: URL | undefined, hosts: ReadonlySet<string>): URL {
  let url: URL;
  try { url = base ? new URL(input.toString(), base) : new URL(input.toString()); }
  catch { throw new HttpError("REDIRECT_BLOCKED"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !hosts.has(url.hostname.toLowerCase())) {
    throw new HttpError("REDIRECT_BLOCKED");
  }
  return url;
}

function redirectedInit(current: URL, next: URL, status: number, input: RequestInit): RequestInit {
  const output: RequestInit = {...input, redirect: "manual"};
  if (current.origin !== next.origin) {
    const headers = new Headers(input.headers);
    for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
    output.headers = headers;
  }
  const method = (input.method ?? "GET").toUpperCase();
  if (status === 303 && method !== "HEAD" || (status === 301 || status === 302) && method === "POST") {
    output.method = "GET";
    delete output.body;
    const headers = new Headers(output.headers);
    headers.delete("content-length");
    headers.delete("content-type");
    output.headers = headers;
  }
  return output;
}

function ownErrorValue(error: unknown, key: "code" | "cause"): unknown {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const property = Object.getOwnPropertyDescriptor(error, key);
    return property && "value" in property ? property.value : undefined;
  } catch {
    return undefined;
  }
}

function nativeErrorCode(error: unknown): HttpErrorCode | undefined {
  switch (ownErrorValue(error, "code")) {
    case "ENOTFOUND":
    case "EAI_AGAIN": return "DNS_FAILED";
    case "ECONNREFUSED": return "CONNECTION_REFUSED";
    case "TELEBOX_ADDRESS_BLOCKED": return "ADDRESS_BLOCKED";
    default: return undefined;
  }
}

function safeError(error: unknown): HttpError | HttpStatusError {
  // Never carry upstream messages, stacks, causes, headers or payloads across this boundary.
  if (error instanceof HttpStatusError && Number.isInteger(error.status) &&
      error.status >= 100 && error.status <= 599) {
    return new HttpStatusError(error.status);
  }
  if (error instanceof HttpError && Object.hasOwn(messages, error.code)) {
    return new HttpError(error.code);
  }
  // Node fetch wraps native errors in one cause; do not traverse chains or invoke getters.
  return new HttpError(nativeErrorCode(error) ?? nativeErrorCode(ownErrorValue(error, "cause")) ?? "FAILED");
}

export class ScopedHttp {
  private readonly scope: ResourceScope;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly lookup: typeof dnsLookup;
  private publicAgent?: Agent;

  constructor(scope: ResourceScope, options: ScopedHttpOptions = {}) {
    this.scope = scope;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.lookup = options.lookup ?? dnsLookup;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    validateTimeout(this.timeoutMs);
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 0) {
      throw new RangeError("maxResponseBytes must be a non-negative safe integer");
    }
  }

  private publicDispatcher(): Agent {
    if (this.publicAgent) return this.publicAgent;
    const agent = new Agent({connect: {lookup: createPublicLookup(this.lookup) as never}});
    this.publicAgent = agent;
    this.scope.add("http-public-dispatcher", async () => {
      this.publicAgent = undefined;
      await agent.close();
    });
    return agent;
  }

  /**
   * No retries or implicit status checks. The deadline covers fetch, consume and cleanup.
   * Cancellation requests cooperation; the promise/task stays pending until work settles.
   * Consume must await all its work, not retain/clone the response, and release owned readers
   * in finally. Its signal also closes at callback lifetime end to stop native fetch I/O.
   * Only text/json enforce maxResponseBytes; custom consumers own their streaming limits.
   */
  withResponse<T>(
    url: string | URL,
    init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    options: HttpRequestOptions = {},
  ): Promise<T> {
    const redirects = redirectConfiguration(options.redirects);
    let started = false;
    const task = this.scope.run("http", async (scopeSignal) => {
      started = true;
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      validateTimeout(timeoutMs);
      const controller = new AbortController();
      const signal = controller.signal;
      let cancellation: HttpError | undefined;
      const cancel = (code: "ABORTED" | "TIMEOUT"): void => {
        cancellation ??= new HttpError(code);
        controller.abort(cancellation);
      };
      const inputs = new Set([scopeSignal, init.signal, options.signal]);
      const onAbort = (): void => cancel("ABORTED");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Response | undefined;
      let value!: T;
      let failure: HttpError | HttpStatusError | undefined;
      try {
        for (const input of inputs) {
          if (!input) continue;
          if (input.aborted) cancel("ABORTED");
          else input.addEventListener("abort", onAbort, { once: true });
        }
        if (timeoutMs === 0) cancel("TIMEOUT");
        if (cancellation) throw cancellation;
        timer = setTimeout(() => cancel("TIMEOUT"), timeoutMs);
        const withAddressPolicy = (request: RequestInit): RequestInit => options.denyPrivateAddresses
          ? ({...request, dispatcher: this.publicDispatcher()} as RequestInit) : request;
        // Do not race cancellation against this promise: ignored signals must stay tracked.
        if (!redirects) {
          const target = options.denyPrivateAddresses ? publicTarget(url) : url;
          response = await this.fetchImpl(target, withAddressPolicy({ ...init, signal }));
        } else {
          let current = allowedURL(url, undefined, redirects.allowed);
          if (options.denyPrivateAddresses) publicTarget(current);
          let request: RequestInit = {...init, redirect: "manual"};
          let followed = 0;
          while (true) {
            response = await this.fetchImpl(current, withAddressPolicy({...request, redirect: "manual", signal}));
            if (![301, 302, 303, 307, 308].includes(response.status)) break;
            const location = response.headers.get("location");
            if (location === null) break;
            if (followed >= redirects.maximum) throw new HttpError("TOO_MANY_REDIRECTS");
            const next = allowedURL(location, current, redirects.allowed);
            if (options.denyPrivateAddresses) publicTarget(next);
            request = redirectedInit(current, next, response.status, request);
            if (response.body && !response.body.locked) await response.body.cancel();
            response = undefined;
            current = next;
            followed += 1;
          }
        }
        if (cancellation) throw cancellation;
        value = await consume(response, signal);
      } catch (error) {
        failure = cancellation ?? safeError(error);
      } finally {
        try {
          if (response?.body && !response.body.locked) await response.body.cancel();
        } catch {
          failure ??= new HttpError("CLEANUP_FAILED");
        } finally {
          // Native fetch also cancels a body whose reader is still locked by the consumer.
          controller.abort(cancellation ?? new HttpError("CLOSED"));
          if (timer !== undefined) clearTimeout(timer);
          for (const input of inputs) input?.removeEventListener("abort", onAbort);
        }
      }
      if (cancellation) throw cancellation;
      if (failure) throw failure;
      return value;
    }).catch((error: unknown) => {
      // A pre-aborted scope rejects before invoking the callback; its reason is also private.
      if (!started && this.scope.signal.aborted) throw new HttpError("ABORTED");
      throw safeError(error);
    });
    void task.catch(() => undefined);
    return task;
  }

  /** Returns bounded UTF-8 text for any HTTP status, including non-2xx. */
  text(url: string | URL, init: RequestInit = {}, options: HttpRequestOptions = {}): Promise<string> {
    return this.withResponse(url, init, (response, signal) => this.readText(response, signal), options);
  }

  /** Parsing is tracked too. T is a caller assertion, not runtime schema validation. */
  json<T = unknown>(url: string | URL, init: RequestInit = {}, options: HttpRequestOptions = {}): Promise<T> {
    return this.withResponse(url, init, async (response, signal) => {
      const text = await this.readText(response, signal);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpError("INVALID_JSON");
      }
    }, options);
  }

  private async readText(response: Response, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    const batchSize = 16 * 1024;
    let batch: Uint8Array | undefined;
    let buffered = 0;
    let total = 0;
    let done = false;
    let cancellation: Promise<void> | undefined;
    let failure: HttpError | HttpStatusError | undefined;
    const cancel = (): Promise<void> => cancellation ??= reader.cancel(new HttpError("CLOSED"));
    const onAbort = (): void => { void cancel().catch(() => undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) {
          done = true;
          break;
        }
        // Fetch exposes decompressed bytes; Content-Length can describe compressed data or lie.
        total += chunk.value.byteLength;
        if (total > this.maxResponseBytes) throw new HttpError("RESPONSE_TOO_LARGE");
        // Coalesce tiny transport chunks so retained strings scale with bytes,
        // not with the number of network reads. Decode large chunks directly.
        if (!buffered && chunk.value.byteLength >= batchSize) {
          parts.push(decoder.decode(chunk.value, {stream: true}));
        } else if (chunk.value.byteLength) {
          batch ??= new Uint8Array(batchSize);
          for (let offset = 0; offset < chunk.value.byteLength;) {
            const length = Math.min(batchSize - buffered, chunk.value.byteLength - offset);
            batch.set(chunk.value.subarray(offset, offset + length), buffered);
            buffered += length;
            offset += length;
            if (buffered === batchSize) {
              parts.push(decoder.decode(batch, {stream: true}));
              buffered = 0;
            }
          }
        }
      }
      if (buffered) parts.push(decoder.decode(batch!.subarray(0, buffered), {stream: true}));
      parts.push(decoder.decode());
    } catch (error) {
      failure = safeError(error);
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        if (!done) await cancel();
      } catch {
        failure ??= new HttpError("CLEANUP_FAILED");
      } finally {
        reader.releaseLock();
      }
    }
    if (failure) throw failure;
    return parts.join("");
  }
}
