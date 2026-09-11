import {installIpPrivacy} from "./ip-privacy";
import createPrivacy from "./builtins/privacy";
import path from "node:path";
import * as fs from "node:fs/promises";
import {TelegramClient, Api} from "teleproto";
import {StringSession} from "teleproto/sessions";
import {Logger, LogLevel as NativeLogLevel, type LogRecord} from "teleproto/extensions/Logger";
import {PluginHost} from "./host";
import {ResourceScope, type DrainReport} from "./lifecycle";
import {RuntimeLogger, LogLevel} from "./logging";
import {PrefixEnvStore, prefixesFromEnv} from "./prefixes";
import {createHelp} from "./builtins/help";
import {createAlias} from "./builtins/alias";
import {createPrefix} from "./builtins/prefix";
import {createLogLevel} from "./builtins/loglevel";
import createMemory from "./builtins/memory";
import createPing from "./builtins/ping";
import createStatus from "./builtins/status";
import createEnv from "./builtins/env";
import createSysinfo from "./builtins/sysinfo";
import createVersion from "./builtins/version";
import createAgent from "./builtins/agent";
import createExec from "./builtins/exec";
import createRestart from "./builtins/restart";
import createBf from "./builtins/bf";
import createSudo from "./builtins/sudo";
import {PluginReleases, type ReleaseState} from "./releases";
import {StorageRoot} from "./storage";
import createTpm from "./builtins/tpm";
import createUpdate from "./builtins/update";
import createAutofix from "./builtins/autofix";
import {TeleprotoPort, subscribeMessages} from "./telegram";
import {AccountError, assertLegacyStopped, lockAccount, readAccount, readEnvironment} from "./account";
import {installProtocolCompatibility, type ProtocolCompatibility, type ProtocolLogDecision} from "./protocol-compat";

export interface RuntimeOptions {
  root?: string;
  signals?: readonly NodeJS.Signals[];
}
export interface RuntimeResult {
  reason: string;
  plugins: readonly string[];
  lifecycle: {host: DrainReport; events: DrainReport; transport: DrainReport; logging: DrainReport};
}

function logLine(level: "info" | "error", event: string, fields?: Readonly<Record<string, string | number | boolean>>): void {
  const line = JSON.stringify({time: new Date().toISOString(), level, event, ...fields}) + "\n";
  (level === "error" ? process.stderr : process.stdout).write(line);
}

function protocolSink(compatibility: () => ProtocolCompatibility | undefined): (record: LogRecord) => void {
  return record => {
    const decision: ProtocolLogDecision = compatibility()?.handleLog({message: record.message, error: record.error}) ?? "pass";
    if (decision === "suppress") return;
    const level = decision === "warn" || record.level === NativeLogLevel.WARN ? "info" : record.level === NativeLogLevel.ERROR ? "error" : "info";
    logLine(level, decision === "warn" ? "telegram.channel_gap" : "telegram.protocol", {nativeLevel: record.level});
  };
}

function waitForStop(signals: readonly NodeJS.Signals[], scope: ResourceScope): Promise<string> {
  return new Promise(resolve => {
    let settled = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      resolve(reason);
    };
    for (const signal of signals) {
      const handler = (): void => finish(signal);
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    scope.add("runtime:signal-listeners", () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      finish("scope");
    });
  });
}

function requireComplete(name: string, report: DrainReport): void {
  if (!report.completed) throw new Error(`${name} did not stop cleanly`);
}

export async function serve(options: RuntimeOptions = {}): Promise<RuntimeResult> {
  if (process.platform !== "linux") throw new AccountError("PLATFORM");
  const root = await fs.realpath(options.root ?? process.cwd());
  await assertLegacyStopped(root);
  const configuration = await readAccount(root);
  const environment = await readEnvironment(root, process.env);
  const session = new StringSession(configuration.session);
  await session.load();
  const key = session.authKey?.getKey();
  if (!key) throw new AccountError("CONFIG");
  const releaseLock = await lockAccount(key);
  const transport = new ResourceScope();
  const events = new ResourceScope();
  const logging = new ResourceScope();
  const rootScope = new ResourceScope();
  let compatibility: ProtocolCompatibility | undefined;
  let releasePrivacy: (() => void) | undefined;
  const nativeLogger = new Logger(NativeLogLevel.WARN);
  nativeLogger.handler = protocolSink(() => compatibility);
  const logger = new RuntimeLogger(path.join(root, "assets/logger/config.json"), {
    write(level, event, fields) {logLine(level >= LogLevel.ERROR ? "error" : "info", event, fields);},
  }, logging);
  const client = new TelegramClient(session, configuration.apiId, configuration.apiHash, {
    deviceModel: configuration.deviceModel, proxy: configuration.proxy,
    baseLogger: nativeLogger, connectionRetries: 5, reconnectRetries: Infinity,
    requestRetries: 5, autoReconnect: true, timeout: 10,
  });
  let host: PluginHost | undefined;
  let releases: PluginReleases | undefined;
  const releaseStorage = new StorageRoot(path.join(root, "assets"));
  let detach: (() => Promise<void>) | undefined;
  let plugins: string[] = [];
  let reason = "startup-failed";
  let failure: unknown;
  let lifecycle: RuntimeResult["lifecycle"] | undefined;
  try {
    compatibility = installProtocolCompatibility(client);
    releasePrivacy = installIpPrivacy(client);
    await client.connect();
    if (!await client.checkAuthorization()) throw new AccountError("CONFIG");
    const me = await client.getMe();
    if (!(me instanceof Api.User) || !me.self || me.bot) throw new AccountError("CONFIG");
    const selfId = me.id.toString();
    await logger.initialize();
    client.setLogLevel(logger.getProtocolLevel() as NativeLogLevel);
    host = new PluginHost({storageRoot: path.join(root, "assets"), tempRoot: path.join(root, "temp"),
      telegram: new TeleprotoPort(client, transport, {selfId}), logger, prefixes: prefixesFromEnv(environment),
      processes: {concurrency: 2, queueCapacity: 16, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024},
    });
    await host.load(createPrivacy(selfId));
    await host.load(createHelp(host, selfId));
    await host.load(createAlias(host));
    await host.load(createPrefix(host, new PrefixEnvStore(path.join(root, ".env"))));
    await host.load(createLogLevel(logger));
    await host.load(createMemory());
    await host.load(createPing());
    await host.load(createStatus(root));
    await host.load(createEnv());
    await host.load(createSysinfo());
    await host.load(createVersion(root));
    await host.load(createAgent());
    await host.load(createExec(selfId));
    const restart = createRestart(selfId, rootScope.signal);
    await host.load(restart);
    await host.load(createBf(root, selfId));
    await host.load(createSudo(selfId));
    const selection = releaseStorage.json<ReleaseState>("tpm", "releases.json", {schemaVersion: 1, plugins: {}});
    releases = new PluginReleases(host, {artifactRoot: path.join(root, "dist/v2-plugins"), store: selection});
    await host.load(createTpm(host, releases, root, selfId));
    const update = createUpdate(root, selfId);
    await host.load(update);
    await host.load(createAutofix(root));
    for (const [id, selected] of Object.entries((await selection.read()).plugins)) {
      await releases.activate(id, selected.current);
    }
    detach = await subscribeMessages(client, events, async (message, signal) => {
      signal.throwIfAborted();
      try {
        await host!.dispatchPrimary(message);
        signal.throwIfAborted();
        await host!.dispatchListeners(message);
      } catch (error) {
        if (!signal.aborted) logger.error("runtime.message_failed", {kind: error instanceof Error ? error.name : "unknown"});
      }
    }, {selfId});
    plugins = releases.snapshot().generations.map(item => item.id);
    logLine("info", "runtime.ready", {plugins: plugins.length, builtins: 19,
      extensions: plugins.length});
    const stopped = waitForStop(options.signals ?? ["SIGINT", "SIGTERM"], rootScope);
    await restart.notifyReady();
    await update.notifyReady();
    reason = await stopped;
  } catch (error) {
    failure = error;
  } finally {
    const failures: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {try {await operation();} catch (error) {failures.push(error);}};
    await attempt(() => rootScope.drain(5000).then(report => requireComplete("runtime", report)));
    await attempt(async () => {if (detach) await detach();});
    let eventReport = events.snapshot();
    let hostReport = host ? host.snapshot().lifecycle : rootScope.snapshot();
    let transportReport = transport.snapshot();
    let loggingReport = logging.snapshot();
    await attempt(async () => {eventReport = await events.drain(15000); requireComplete("events", eventReport);});
    await attempt(async () => {if (releases) requireComplete("plugins", await releases.shutdown(30000));});
    await attempt(async () => {if (host) {hostReport = await host.shutdown(30000); requireComplete("host", hostReport);}});
    await attempt(() => releaseStorage.close());
    await attempt(async () => {transportReport = await transport.drain(15000); requireComplete("transport", transportReport);});
    await attempt(async () => {loggingReport = await logging.drain(15000); requireComplete("logging", loggingReport);});
    await attempt(() => client.destroy());
    releasePrivacy?.();
    compatibility?.cleanup();
    await attempt(releaseLock);
    lifecycle = {host: hostReport, events: eventReport, transport: transportReport, logging: loggingReport};
    if (failures.length) failure = failure === undefined ? new AggregateError(failures, "Runtime shutdown failed")
      : new AggregateError([failure, ...failures], "Runtime and shutdown failed");
  }
  if (failure !== undefined) throw failure;
  return {reason, plugins, lifecycle: lifecycle!};
}
