import { AsyncLocalStorage } from "node:async_hooks";
import { KeyedExecutor, ExecutorClosedError } from "./executor";
import { ResourceScope, type DrainReport } from "./lifecycle";
import { StorageRoot, type JsonStore } from "./storage";
import { PluginScheduler, type ScheduledJob } from "./scheduler";
import { ScopedHttp, type ScopedHttpOptions } from "./http";
import type { TelegramClient } from "teleproto";
import path from "node:path";
import {SqliteStore, type SqliteConnection, type SqliteOptions} from "./sqlite";
import {DEFAULT_PROCESS_LIMITS, ProcessAbortedError, ProcessClosedError, resolveProcessLimits, ScopedProcesses,
  type ProcessLimits, type ProcessRunOptions} from "./processes";
import {SettingsRegistry} from "./settings";
import {ScopedFiles} from "./files";
import {ScopedSafeRegExp} from "./safe-regexp";
import { definePlugin, type ApplicationInfo, type CommandDefinition, type CommandDispatchResult, type PluginDefinition, type PluginContext, type PluginLogger, type MessageEnvelope, type MessageFilter, type TelegramPort } from "./sdk";
import {renderRichText} from "./ui/document";
import {renderCommandHelp, resolveHelpPath, type CommandHelpSource, type SubcommandDefinition, type SubcommandHelpSource} from "./commands";

/** Admission is evaluated before any business handler receives the message. */
function admitsMessage(message: MessageEnvelope, filter: MessageFilter | undefined): boolean {
  if (!filter) return true;
  const direction = message.direction ?? (message.outgoing ? "outgoing" : "incoming");
  const saved = message.saved === true;
  if (filter.direction !== undefined && filter.direction !== direction && !(saved && filter.includeSaved === true)) return false;
  if (filter.chats !== undefined) {
    const chatType = message.chatType ?? "unknown";
    if (chatType === "unknown" || !filter.chats.includes(chatType)) return false;
  }
  if (filter.ignoreForwarded === true && message.forwarded === true) return false;
  return true;
}

interface SqliteEntry {store: SqliteStore; readonly: boolean; mustExist: boolean; timeoutMs: number}
interface PluginStorage { json: StorageRoot; sqlite: Map<string, SqliteEntry>; legacySqlite: Map<string, SqliteEntry>; }
interface LoadedPlugin { definition: PluginDefinition; scope: ResourceScope; storage: PluginStorage; context: PluginContext; ready: boolean; owner?: object; }
interface CommandTarget { plugin: LoadedPlugin; name: string; }
interface ParsedCommand { prefix: string; command: string; args: string[]; text: string }

/** Deep-frozen, handler-free subcommand metadata including nested levels. */
function describeSubcommand(sub: SubcommandDefinition): SubcommandHelpSource {
  const nested = sub.subcommands
    ? Object.freeze(Object.fromEntries(Object.entries(sub.subcommands).map(([name, child]) => [name, describeSubcommand(child)])))
    : undefined;
  return Object.freeze({
    description: sub.description,
    ...(sub.aliases ? {aliases: Object.freeze([...sub.aliases])} : {}),
    ...(sub.args !== undefined ? {args: sub.args} : {}),
    ...(sub.alternates ? {alternates: Object.freeze(sub.alternates.map(variant => Object.freeze({...variant})))} : {}),
    ...(sub.arguments ? {arguments: Object.freeze(sub.arguments.map(argument => Object.freeze({...argument})))} : {}),
    ...(sub.examples ? {examples: Object.freeze(sub.examples.map(example => Object.freeze({...example})))} : {}),
    ...(sub.help ? {help: Object.freeze(sub.help.map(section => Object.freeze({...section})))} : {}),
    ...(nested ? {subcommands: nested} : {}),
    ...(sub.defaultSubcommand !== undefined ? {defaultSubcommand: sub.defaultSubcommand} : {}),
    ...(sub.subcommandsCaseSensitive !== undefined ? {subcommandsCaseSensitive: sub.subcommandsCaseSensitive} : {}),
    ...(sub.caseSensitive !== undefined ? {caseSensitive: sub.caseSensitive} : {}),
    ...(sub.group !== undefined ? {group: sub.group} : {}),
    ...(sub.notes ? {notes: Object.freeze([...sub.notes])} : {}),
    ...(sub.public !== undefined ? {public: sub.public} : {}),
  });
}

/** Immutable command metadata snapshot exposed to the help center. Handlers are never exposed. */
function describeCommand(name: string, command: CommandDefinition): CommandHelpSource & {name: string} {
  const subcommands = command.subcommands
    ? Object.freeze(Object.fromEntries(Object.entries(command.subcommands).map(([subName, sub]) => [subName, describeSubcommand(sub)])))
    : undefined;
  return Object.freeze({
    name, description: command.description,
    ...(command.args !== undefined ? {args: command.args} : {}),
    ...(command.alternates ? {alternates: Object.freeze(command.alternates.map(variant => Object.freeze({...variant})))} : {}),
    ...(command.arguments ? {arguments: Object.freeze(command.arguments.map(argument => Object.freeze({...argument})))} : {}),
    ...(command.examples ? {examples: Object.freeze(command.examples.map(example => Object.freeze({...example})))} : {}),
    ...(command.help ? {help: Object.freeze(command.help.map(section => Object.freeze({...section})))} : {}),
    ...(subcommands ? {subcommands} : {}),
    ...(command.defaultSubcommand !== undefined ? {defaultSubcommand: command.defaultSubcommand} : {}),
    ...(command.subcommandsCaseSensitive !== undefined ? {subcommandsCaseSensitive: command.subcommandsCaseSensitive} : {}),
    ...(command.helpArgs ? {helpArgs: Object.freeze([...command.helpArgs])} : {}),
  });
}

export interface HostOptions {
  storageRoot: string;
  tempRoot?: string;
  /** Application-owned metadata snapshot; plugins cannot select filesystem paths. */
  application?: Readonly<ApplicationInfo>;
  telegram: TelegramPort;
  logger: PluginLogger;
  prefixes?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  concurrency?: number;
  queueCapacity?: number;
  http?: ScopedHttpOptions;
  processes?: ProcessLimits;
  /** Authenticated account id; required for plugin-initiated command dispatch. */
  selfId?: string;
  /** Normalizes a transport message for dispatch and throws when it is not a real protocol message. */
  envelope?: (message: unknown) => MessageEnvelope;
}

/** Bounded chain length for plugin-initiated command dispatch, independent of executor concurrency. */
const MAX_COMMAND_DISPATCH_DEPTH = 4;

export class PluginHost {
  private readonly safeRegExp = new ScopedSafeRegExp();
  private readonly root = new ResourceScope();
  private readonly executor: KeyedExecutor;
  private readonly scheduler: PluginScheduler;
  private readonly dispatchContext = new AsyncLocalStorage<{depth: number; signal: AbortSignal}>();
  private readonly settings = new SettingsRegistry();
  private processes?: ScopedProcesses;
  private readonly processCaps: Required<ProcessLimits>;
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly commands = new Map<string, CommandTarget>();
  private readonly application: Readonly<ApplicationInfo>;
  private prefixes: readonly string[] = [];
  private aliases: ReadonlyMap<string, string>;

  constructor(private readonly options: HostOptions) {
    this.application = Object.freeze(options.application?.licenseModifiedAt === undefined
      ? {} : {licenseModifiedAt: options.application.licenseModifiedAt});
    this.processCaps = resolveProcessLimits(options.processes);
    this.replacePrefixes(options.prefixes === undefined ? ["."] : options.prefixes);
    this.aliases = new Map();
    this.replaceAliases(options.aliases ?? {});
    this.scheduler = new PluginScheduler(options.logger);
    this.executor = new KeyedExecutor(options.concurrency ?? 4, options.queueCapacity ?? 64, this.root.signal);
    this.root.add("plugins-executor-storage", async () => {
      const failures: unknown[] = [];
      await Promise.all([this.executor.close(), ...[...this.plugins.values()].map(async plugin => {
        let report: DrainReport;
        do { report = await plugin.scope.drain(); }
        while (report.pendingTasks || report.pendingResources);
        await this.closeStorage(plugin.storage);
        failures.push(...report.errors);
      })]);
      // Keep the cleanup pending across observation timeouts. Stores must not
      // close while a cancelled handler or its cleanup still owns them.
      this.plugins.clear();
      this.commands.clear();
      if (failures.length) throw new AggregateError(failures, "Plugin cleanup failures");
    });
  }

  listCommands(): {name: string; pluginId: string; description: string}[] {
    return [...this.commands].filter(([, target]) => target.plugin.ready).map(([name, target]) => ({
      name, pluginId: target.plugin.definition.id, description: target.plugin.definition.commands[target.name].description,
    })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  configuration() {
    return {prefixes: [...this.prefixes], aliases: Object.fromEntries(this.aliases)};
  }

  replacePrefixes(prefixes: readonly string[]): void {
    this.root.signal.throwIfAborted();
    if (!Array.isArray(prefixes) || !prefixes.length ||
        [...prefixes].some(prefix => typeof prefix !== "string" || !prefix || /[\s\0]/u.test(prefix))) {
      throw new Error("Non-empty command prefix tokens required");
    }
    this.prefixes = Object.freeze([...new Set(prefixes)]);
  }

  replaceAliases(aliases: Readonly<Record<string, string>>): void {
    this.root.signal.throwIfAborted();
    const entries = Object.entries(aliases);
    if (entries.some(([name, target]) => !name.trim() || typeof target !== "string" || !target.trim())) {
      throw new Error("Aliases require non-empty names and targets");
    }
    this.aliases = new Map(entries);
  }

  listPlugins() {
    return [...this.plugins.values()].filter(plugin => plugin.ready).map(({definition}) => ({
      id: definition.id, description: definition.description,
      ...(definition.renderHelp ? {renderHelp: definition.renderHelp} : {}),
      commands: Object.entries(definition.commands).map(([name, command]) => describeCommand(name, command)),
      jobs: Object.entries(definition.jobs ?? {}).map(([name, job]) => ({name, cron: job.cron, description: job.description})),
    }));
  }

  listSettings() { return this.settings.list(); }
  settingsSchema(id: string) { return this.settings.schema(id); }
  readSettings(id: string) { return this.settings.read(id); }
  patchSettings(id: string, patch: unknown) { return this.settings.patch(id, patch); }

  pluginState(id: string, owner?: object): "active" | "draining" | undefined {
    const plugin = this.plugins.get(id);
    if (owner && plugin?.owner !== owner) return undefined;
    return plugin && (plugin.ready ? "active" : "draining");
  }

  assertCanUnload(id: string, timeoutMs = 15000, owner?: object): void {
    const plugin = this.plugins.get(id);
    if (owner && plugin?.owner !== owner) return;
    plugin?.scope.assertCanDrain(timeoutMs);
  }

  preflight(input: PluginDefinition, replacingId?: string): void {
    this.root.signal.throwIfAborted();
    const definition = definePlugin(input);
    this.validateProcessRequirements(definition);
    if (this.plugins.has(definition.id) && definition.id !== replacingId) throw new Error("Plugin already loaded");
    for (const name of Object.keys(definition.commands)) {
      const target = this.commands.get(name);
      if (target && target.plugin.definition.id !== replacingId) throw new Error("Command conflict");
    }
  }

  private validateProcessRequirements(definition: PluginDefinition): void {
    const requested = definition.resources?.processes;
    if (!requested) return;
    const limits = resolveProcessLimits({
      concurrency: requested.concurrency ?? Math.min(DEFAULT_PROCESS_LIMITS.concurrency, this.processCaps.concurrency),
      queueCapacity: requested.queueCapacity ?? Math.min(DEFAULT_PROCESS_LIMITS.queueCapacity, this.processCaps.queueCapacity),
      timeoutMs: requested.timeoutMs ?? Math.min(DEFAULT_PROCESS_LIMITS.timeoutMs, this.processCaps.timeoutMs),
      maxOutputBytes: requested.maxOutputBytes ?? Math.min(DEFAULT_PROCESS_LIMITS.maxOutputBytes, this.processCaps.maxOutputBytes),
      maxInputBytes: Math.min(DEFAULT_PROCESS_LIMITS.maxInputBytes, this.processCaps.maxInputBytes),
      killGraceMs: Math.min(DEFAULT_PROCESS_LIMITS.killGraceMs, this.processCaps.killGraceMs),
    });
    for (const key of ["concurrency", "queueCapacity", "timeoutMs", "maxOutputBytes"] as const) {
      if (requested[key] !== undefined && limits[key] > this.processCaps[key]) {
        throw new Error(`Plugin ${definition.id} process ${key} exceeds host limit`);
      }
    }
  }

  private async closeStorage(storage: PluginStorage): Promise<void> {
    await Promise.all([storage.json.close(),
      ...[...storage.sqlite.values(), ...storage.legacySqlite.values()].map(value => value.store.close())]);
    storage.sqlite.clear();
    storage.legacySqlite.clear();
  }

  private contextFor(definition: PluginDefinition, scope: ResourceScope, storage: PluginStorage): PluginContext {
    const id = definition.id;
    const allowedLegacySqlite = new Set(definition.legacyStorage?.sqlite ?? []);
    const combined = (signal: AbortSignal, caller?: AbortSignal) => caller ? AbortSignal.any([signal, caller]) : signal;
    // A plugin-initiated dispatch runs the target handler inside the caller's
    // async context. Managed operations must honour that combined signal, while
    // the plugin scope keeps owning its own long-lived jobs.
    let cachedExtra: AbortSignal | undefined;
    let cachedScoped: AbortSignal | undefined;
    const scopedSignal = (signal: AbortSignal): AbortSignal => {
      const extra = this.dispatchContext.getStore()?.signal;
      if (!extra) return signal;
      if (extra !== cachedExtra) {
        cachedExtra = extra;
        cachedScoped = AbortSignal.any([signal, extra]);
      }
      return cachedScoped!;
    };
    const run = <T>(label: string, operation: (signal: AbortSignal) => T | Promise<T>): Promise<T> =>
      scope.run(label, signal => {
        // The plugin scope is still active during a cancelled dispatch, so the
        // combined signal must gate every managed operation before it starts.
        const active = scopedSignal(signal);
        active.throwIfAborted();
        return operation(active);
      });
    const requested = definition.resources?.processes;
    const pluginProcessLimits = requested && resolveProcessLimits({
      concurrency: requested.concurrency ?? Math.min(DEFAULT_PROCESS_LIMITS.concurrency, this.processCaps.concurrency),
      queueCapacity: requested.queueCapacity ?? Math.min(DEFAULT_PROCESS_LIMITS.queueCapacity, this.processCaps.queueCapacity),
      timeoutMs: requested.timeoutMs ?? Math.min(DEFAULT_PROCESS_LIMITS.timeoutMs, this.processCaps.timeoutMs),
      maxOutputBytes: requested.maxOutputBytes ?? Math.min(DEFAULT_PROCESS_LIMITS.maxOutputBytes, this.processCaps.maxOutputBytes),
      maxInputBytes: Math.min(DEFAULT_PROCESS_LIMITS.maxInputBytes, this.processCaps.maxInputBytes),
      killGraceMs: Math.min(DEFAULT_PROCESS_LIMITS.killGraceMs, this.processCaps.killGraceMs),
    });
    const processQueue = pluginProcessLimits && new KeyedExecutor(
      pluginProcessLimits.concurrency, pluginProcessLimits.queueCapacity, scope.signal,
    );
    let processSequence = 0;
    if (processQueue) scope.add("plugin-process-queue", () => processQueue.close());
    const runProcess = (command: string, args: readonly string[] = [], options: ProcessRunOptions = {}) => {
      if (pluginProcessLimits) {
        if (options.timeoutMs !== undefined && options.timeoutMs > pluginProcessLimits.timeoutMs) {
          throw new RangeError("Plugin helper timeout exceeds declared limit");
        }
        if (options.maxOutputBytes !== undefined && options.maxOutputBytes > pluginProcessLimits.maxOutputBytes) {
          throw new RangeError("Plugin helper output exceeds declared limit");
        }
      }
      const invocation = {
        ...options,
        timeoutMs: options.timeoutMs ?? pluginProcessLimits?.timeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? pluginProcessLimits?.maxOutputBytes,
      };
      return run("process:run", signal => {
        this.processes ??= new ScopedProcesses(this.root, this.processCaps);
        const callerSignal = combined(signal, options.signal);
        const execute = () => this.processes!.run(command, args, {...invocation, signal: callerSignal});
        if (!processQueue) return execute();
        return processQueue.submit(String(++processSequence), execute, callerSignal).catch(error => {
          if (callerSignal.aborted && error === callerSignal.reason) {
            throw scope.signal.aborted ? new ProcessClosedError() : new ProcessAbortedError();
          }
          if (error instanceof ExecutorClosedError) throw new ProcessClosedError();
          throw error;
        });
      });
    };
    const sqliteCapability = (entries: Map<string, SqliteEntry>, file: string, target: string,
      options: SqliteOptions, label: string): Pick<SqliteStore, "read" | "transaction" | "preflight"> => {
      scope.signal.throwIfAborted();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(db|sqlite|sqlite3)$/.test(file)) throw new Error("Invalid plugin SQLite filename");
      let entry = entries.get(file);
      const readonly = options.readonly ?? false;
      const mustExist = options.mustExist ?? false;
      const timeoutMs = options.timeoutMs ?? 5000;
      if (entry && (entry.readonly !== readonly || entry.mustExist !== mustExist || entry.timeoutMs !== timeoutMs)) {
        throw new Error("SQLite store options conflict");
      }
      if (!entry) {
        entry = {store: new SqliteStore(target, options), readonly, mustExist, timeoutMs};
        entries.set(file, entry);
      }
      const sqlite = entry.store;
      return Object.freeze({
        read: <T>(callback: (db: SqliteConnection) => T, caller?: AbortSignal) =>
          run(`${label}:read`, signal => sqlite.read(callback, combined(signal, caller))),
        transaction: <T>(callback: (db: SqliteConnection) => T, caller?: AbortSignal) =>
          run(`${label}:transaction`, signal => sqlite.transaction(callback, combined(signal, caller))),
        preflight: (required?: Readonly<Record<string, readonly string[]>>, caller?: AbortSignal) =>
          run(`${label}:preflight`, signal => sqlite.preflight(required, combined(signal, caller))),
      });
    };
    const tasks = new Proxy(scope, {get(target, key) {
      if (key === "run") return <T>(label: string, operation: (signal: AbortSignal) => T | Promise<T>) => run(label, operation);
      // Synchronous signal reads (e.g. files.dataPath) must see the combined signal too.
      if (key === "signal") return scopedSignal(target.signal);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }}) as ResourceScope;
    return Object.freeze({
      get signal(): AbortSignal { return scopedSignal(scope.signal); }, tasks, application: this.application,
      log: this.options.logger,
      http: new ScopedHttp(tasks, this.options.http),
      files: new ScopedFiles(tasks, this.options.storageRoot, this.options.tempRoot ?? path.join(this.options.storageRoot, '.temp'), id),
      processes: {run: runProcess},
      storage: {json: <T extends Record<string, unknown>>(file: string, defaults: T): Pick<JsonStore<T>, "read" | "update"> => {
        const store = storage.json.json(id, file, defaults);
        return Object.freeze({
          read: (caller?: AbortSignal) => run("storage:read", signal => store.read(combined(signal, caller))),
          update: (mutator: (current: T) => T | Promise<T>, caller?: AbortSignal) =>
            run("storage:update", signal => store.update(mutator, combined(signal, caller))),
        });
      }, sqlite: (file: string, options: SqliteOptions = {}) =>
        sqliteCapability(storage.sqlite, file, path.join(this.options.storageRoot, id, file), options, "sqlite"),
      legacySqlite: (file: string, options: SqliteOptions = {}) => {
        if (!allowedLegacySqlite.has(file)) throw new Error("Legacy SQLite file is not declared");
        return sqliteCapability(storage.legacySqlite, file, path.join(this.options.storageRoot, file),
          {...options, mustExist: true}, "legacy-sqlite");
      }},
      jobs: {register: (name: string, spec: ScheduledJob, handler: (signal: AbortSignal) => void | Promise<void>) =>
        this.scheduler.register(id, name, spec, scope, signal => this.executor.submit(`job:${id}:${name}`,
          // A cron timer may be created during a plugin-initiated dispatch; its future
          // ticks must not inherit that dispatch's signal or recursion depth.
          () => this.dispatchContext.exit(() => {
            const plugin = this.plugins.get(id);
            if (plugin?.scope === scope && plugin.ready) return handler(signal);
            return undefined;
          }), signal),
          // The creating dispatch may only admit or reject this registration; it never
          // owns the accepted timer, which stays bound to the target plugin scope.
          this.dispatchContext.getStore()?.signal)},
      plugins: Object.freeze({list: () => {
        scope.signal.throwIfAborted();
        return Object.freeze(this.listPlugins().map(({id, description}) => Object.freeze({id, description})));
      }}),
      commands: {
        parse: (text: string) => {
          const parsed = this.parse(text);
          return parsed && Object.freeze({...parsed, args: Object.freeze([...parsed.args])});
        },
        dispatch: (message: unknown) => run("command:dispatch", () => this.dispatchCommandMessage(message, scope)),
      },
      services: {
        available: (pluginId: string, service: string) => {
          const provider = this.plugins.get(pluginId);
          return !!provider?.ready && Object.hasOwn(provider.definition.services ?? {}, service);
        },
        call: <T>(pluginId: string, service: string, input: unknown, caller?: AbortSignal) => run("service:call", signal => {
          const provider = this.plugins.get(pluginId);
          if (!provider?.ready || !Object.hasOwn(provider.definition.services ?? {}, service)) throw new Error("Plugin service unavailable");
          const handler = provider.definition.services![service];
          return provider.scope.run(`service:${service}`, providerSignal => {
            const callSignal = AbortSignal.any([signal, providerSignal, ...(caller ? [caller] : [])]);
            callSignal.throwIfAborted();
            return handler.handle(input, provider.context, callSignal);
          }) as Promise<T>;
        }),
      },
      regexp: Object.freeze({test: (pattern: string, input: string, options = {}, caller?: AbortSignal) =>
        run("regexp:test", signal => this.safeRegExp.test(pattern, input, options, combined(signal, caller)))}),
      telegram: {
        edit: (message: MessageEnvelope, text: string, options = {}) => run("telegram:edit", signal => this.options.telegram.edit(message, text, options, signal)),
        reply: (message: MessageEnvelope, text: string, options = {}) => run("telegram:reply", signal => this.options.telegram.reply(message, text, options, signal)),
        invoke: (request: unknown) => run("telegram:invoke", signal => this.options.telegram.invoke(request, signal)),
        getReply: (message: MessageEnvelope) => run("telegram:reply-read", signal => this.options.telegram.getReply(message, signal)),
        withClient: <T>(operation: (client: TelegramClient, signal: AbortSignal) => Promise<T>) =>
          run("telegram:native", signal => this.options.telegram.withClient(operation, signal)),
      },
    });
  }

  async load(input: PluginDefinition, owner?: object): Promise<void> {
    this.root.signal.throwIfAborted();
    const definition = definePlugin(input);
    this.validateProcessRequirements(definition);
    if (this.plugins.has(definition.id)) throw new Error(`Plugin already loaded: ${definition.id}`);
    for (const name of Object.keys(definition.commands)) {
      if (this.commands.has(name)) throw new Error(`Command conflict: ${name}`);
    }
    const scope = new ResourceScope(this.root.signal);
    const storage: PluginStorage = {json: new StorageRoot(this.options.storageRoot), sqlite: new Map(), legacySqlite: new Map()};
    const context = this.contextFor(definition, scope, storage);
    const plugin: LoadedPlugin = {definition, scope, storage, context, ready: false, owner};
    this.plugins.set(definition.id, plugin);
    // Reserve names before asynchronous setup so concurrent loads cannot collide.
    for (const name of Object.keys(definition.commands)) this.commands.set(name, {plugin, name});
    let finishSetup!: () => void;
    const setupSettled = new Promise<void>(resolve => { finishSetup = resolve; });
    if (definition.cleanup) scope.add("plugin:cleanup", async () => {
      await setupSettled;
      await definition.cleanup!(context);
    });
    try {
      try { await scope.run("plugin:setup", () => definition.setup?.(context)); }
      finally { finishSetup(); }
      this.root.signal.throwIfAborted();
      scope.signal.throwIfAborted();
      if (definition.settings) this.settings.register(definition.id, definition.settings(context), scope);
      for (const [name, job] of Object.entries(definition.jobs ?? {})) {
        await context.jobs.register(name, job, signal => job.handle(context, signal));
      }
      this.root.signal.throwIfAborted();
      scope.signal.throwIfAborted();
      plugin.ready = true;
    } catch (error) {
      const report = await scope.drain();
      if (!report.pendingTasks && !report.pendingResources) await this.closeStorage(storage);
      if (report.completed) this.remove(plugin);
      throw error;
    }
  }

  private remove(plugin: LoadedPlugin): void {
    if (this.plugins.get(plugin.definition.id) === plugin) this.plugins.delete(plugin.definition.id);
    for (const [name, target] of this.commands) if (target.plugin === plugin) this.commands.delete(name);
  }

  async unload(id: string, timeoutMs = 15000, owner?: object): Promise<DrainReport | undefined> {
    const plugin = this.plugins.get(id);
    if (!plugin || owner && plugin.owner !== owner) return undefined;
    plugin.scope.assertCanDrain(timeoutMs);
    plugin.ready = false;
    const report = await plugin.scope.drain(timeoutMs);
    if (!report.pendingTasks && !report.pendingResources) await this.closeStorage(plugin.storage);
    if (report.completed) this.remove(plugin);
    return report;
  }

  private parse(text: string): ParsedCommand | undefined {
    const prefix = this.prefixes.reduce<string | undefined>((matched, candidate) =>
      text.startsWith(candidate) && (matched === undefined || candidate.length > matched.length) ? candidate : matched,
    undefined);
    if (prefix === undefined) return;
    const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    for (let length = parts.length; length > 0; length--) {
      const alias = parts.slice(0, length).join(" ");
      if (length === 1 && this.commands.has(alias)) continue;
      const expansion = this.aliases.get(alias);
      if (expansion) {
        const expanded = [...expansion.trim().split(/\s+/), ...parts.slice(length)];
        return {prefix, command: expanded[0], args: expanded.slice(1), text: prefix + expanded.join(" ")};
      }
    }
    if (!/^[a-z0-9_]+$/i.test(parts[0])) return;
    return {prefix, command: parts[0], args: parts.slice(1), text};
  }

  // Network admission must provide an authenticated envelope. Other users'
  // commands go through the separate sudo/sure policy, never this primary path.
  dispatchPrimary(message: MessageEnvelope): Promise<boolean> {
    if (this.root.signal.aborted) return Promise.reject(new ExecutorClosedError());
    // `saved` alone does not prove authorship: Telegram also sets savedPeerId on
    // saved-dialog and monoforum messages written by other senders. A non-outgoing
    // message is admitted only when the authenticated account is provably its sender.
    if (!message.outgoing && !(message.saved === true &&
        this.options.selfId !== undefined && message.senderId === this.options.selfId)) {
      return Promise.resolve(false);
    }
    const parsed = this.parse(message.text);
    if (!parsed) return Promise.resolve(false);
    const target = this.commands.get(parsed.command);
    if (!target?.plugin.ready) return Promise.resolve(false);
    const command = target.plugin.definition.commands[target.name];
    if (message.edited && (command.ignoreEdited ?? true)) return Promise.resolve(false);
    if (!admitsMessage(message, command)) return Promise.resolve(false);
    const snapshot = Object.freeze({...message, text: parsed.text});
    const plugin = target.plugin;
    return plugin.scope.run(`command:${target.name}`, () =>
      this.executor.submit(`command:${message.chatId}:${message.id}`, () => this.executeCommand(target, parsed, snapshot), plugin.scope.signal));
  }

  /** Shared help resolution for network ingress and plugin-initiated dispatch. */
  private helpSource(target: CommandTarget, parsed: ParsedCommand): string | undefined {
    const plugin = target.plugin;
    const command = plugin.definition.commands[target.name];
    if (plugin.definition.apiVersion >= 2) {
      // Structured declarations resolve declared subcommand paths on top of the
      // root help policy; free-text inputs are never captured.
      const requestedPath = resolveHelpPath(command, parsed.args, command.helpArgs ?? []);
      if (requestedPath) {
        return requestedPath.length === 0 && plugin.definition.renderHelp
          ? plugin.definition.renderHelp(parsed.prefix)
          : renderCommandHelp(target.name, command, {prefix: parsed.prefix, path: requestedPath});
      }
      if (!parsed.args.length && command.helpOnEmpty) {
        return plugin.definition.renderHelp?.(parsed.prefix)
          ?? renderCommandHelp(target.name, command, {prefix: parsed.prefix});
      }
      return undefined;
    }
    if (plugin.definition.renderHelp) {
      // Legacy declaration keeps its historical behavior: only a root renderHelp
      // with an exact one-token help request or an empty helpOnEmpty invocation
      // is intercepted; everything else stays with the business handler.
      const explicitHelp = parsed.args.length === 1 &&
        ["--help", ...(command.helpArgs ?? [])].includes(parsed.args[0].toLowerCase());
      if (explicitHelp || (!parsed.args.length && command.helpOnEmpty)) return plugin.definition.renderHelp(parsed.prefix);
    }
    return undefined;
  }

  /** Shared command body: help interception then the business handler. */
  private async executeCommand(target: CommandTarget, parsed: ParsedCommand, snapshot: MessageEnvelope): Promise<boolean> {
    const plugin = target.plugin;
    const signal = this.dispatchContext.getStore()?.signal ?? plugin.scope.signal;
    signal.throwIfAborted();
    const helpSource = this.helpSource(target, parsed);
    if (helpSource !== undefined) {
      const pages = await renderRichText(helpSource);
      for (const [index, page] of pages.entries()) {
        signal.throwIfAborted();
        const options = {parseMode: "html", linkPreview: false} as const;
        if (index === 0) await plugin.context.telegram.edit(snapshot, page, options);
        else await plugin.context.telegram.reply(snapshot, page, options);
      }
      return true;
    }
    await plugin.definition.commands[target.name].handle({message: snapshot, command: target.name, prefix: parsed.prefix, args: Object.freeze([...parsed.args])}, plugin.context);
    return true;
  }

  /**
   * Plugin-initiated dispatch of a message the authenticated account just sent.
   * Runs inline when already inside an executor lane and otherwise enters the
   * global executor, so it can never bypass host concurrency. Cancellation
   * rejects with the combined signal's reason (AbortError) rather than a normal
   * ignored result.
   */
  private async dispatchCommandMessage(message: unknown, callerScope: ResourceScope): Promise<CommandDispatchResult> {
    if (this.root.signal.aborted) throw new ExecutorClosedError();
    const selfId = this.options.selfId;
    const normalize = this.options.envelope;
    if (selfId === undefined || normalize === undefined) throw new Error("Command dispatch is unavailable");
    const envelope = normalize(message);
    if (envelope.senderId !== selfId || (!envelope.outgoing && !envelope.saved)) {
      return {status: "ignored", reason: "not-self"};
    }
    const parsed = this.parse(envelope.text);
    if (!parsed) return {status: "ignored", reason: "no-command"};
    const target = this.commands.get(parsed.command);
    if (!target?.plugin.ready) return {status: "ignored", reason: "unknown-command"};
    const command = target.plugin.definition.commands[target.name];
    if (envelope.edited && (command.ignoreEdited ?? true)) return {status: "ignored", reason: "edited"};
    if (!admitsMessage(envelope, command)) return {status: "ignored", reason: "filtered"};
    const outer = this.dispatchContext.getStore();
    if ((outer?.depth ?? 0) >= MAX_COMMAND_DISPATCH_DEPTH) return {status: "ignored", reason: "recursion-limit"};
    const combined = AbortSignal.any([callerScope.signal, target.plugin.scope.signal, this.root.signal,
      ...(outer ? [outer.signal] : [])]);
    combined.throwIfAborted();
    const snapshot = Object.freeze({...envelope, text: parsed.text});
    const execute = (laneSignal?: AbortSignal) => {
      const base = laneSignal ? AbortSignal.any([combined, laneSignal]) : combined;
      return target.plugin.scope.run(`command:dispatched:${target.name}`, targetSignal => {
        const signal = AbortSignal.any([base, targetSignal]);
        signal.throwIfAborted();
        return this.dispatchContext.run({depth: (outer?.depth ?? 0) + 1, signal}, async () => {
          await this.executeCommand(target, parsed, snapshot);
          // A handler that resolves after cancellation must not masquerade as success.
          signal.throwIfAborted();
          return {status: "dispatched" as const, command: target.name, pluginId: target.plugin.definition.id};
        });
      });
    };
    if (this.executor.inLane()) return execute();
    return this.executor.submit(`command:dispatched:${envelope.chatId}:${envelope.id}`, signal => execute(signal), combined);
  }

  dispatchListeners(message: MessageEnvelope): Promise<void> {
    if (this.root.signal.aborted) return Promise.reject(new ExecutorClosedError());
    const snapshot = Object.freeze({...message});
    const work: Promise<unknown>[] = [];
    for (const plugin of this.plugins.values()) {
      if (!plugin.ready) continue;
      for (const listener of plugin.definition.listeners ?? []) {
        if (message.edited && !listener.edited) continue;
        if (listener.ignoreCommands && (message.text.trimStart().startsWith("/") ||
            this.prefixes.some(prefix => message.text.trimStart().startsWith(prefix)))) continue;
        if (!admitsMessage(message, listener)) continue;
        work.push(plugin.scope.run(`listener:${plugin.definition.id}`, () => this.executor.submit(message.chatId,
          () => listener.handle(snapshot, plugin.context), plugin.scope.signal)));
      }
    }
    return Promise.allSettled(work).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Message listener failures");
    });
  }

  snapshot() { return {plugins: this.plugins.size, commands: this.commands.size, queue: this.executor.snapshot(), jobs: this.scheduler.snapshot(), processes: this.processes?.snapshot(), lifecycle: this.root.snapshot()}; }
  async shutdown(timeoutMs = 15000): Promise<DrainReport> {
    this.root.assertCanDrain(timeoutMs);
    for (const plugin of this.plugins.values()) plugin.scope.assertCanDrain(timeoutMs);
    for (const plugin of this.plugins.values()) plugin.ready = false;
    return this.root.drain(timeoutMs);
  }
}
