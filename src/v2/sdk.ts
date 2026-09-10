export {maskIpText, getIpPrivacy} from "./ip-privacy";
export {getBotName} from "./branding";
export * as ui from "./ui";
export * from "./commands";
import type { ResourceScope } from "./lifecycle";
import type { JsonStore } from "./storage";
import type { ScheduledJob } from "./scheduler";
import type { ScopedHttp } from "./http";
import type { TelegramClient } from "teleproto";
import type { SqliteStore, SqliteOptions } from "./sqlite";
import type {ProcessLimits, ScopedProcesses} from "./processes";
import type {SettingsAdapter} from "./settings";
import type {ScopedFiles} from "./files";
import {
  dispatchCommand, normalizeMessageFilter, usesStructuredMetadata,
  type ChatType, type CommandArgument, type CommandExample, type HelpSection,
  type MessageDirection, type MessageFilter, type SubcommandDefinition, type SubcommandVariant,
} from "./commands";

/** Frozen artifact ABI. The build manifest records this value. */
export const PLUGIN_API_VERSION = 1 as const;
/**
 * Definition capability for structured command metadata and message filters.
 * An older host rejects these definitions instead of silently ignoring them.
 */
export const STRUCTURED_PLUGIN_API_VERSION = 2 as const;
export type PluginApiVersion = typeof PLUGIN_API_VERSION | typeof STRUCTURED_PLUGIN_API_VERSION;

/** Named SDK capabilities that plugins can assert before relying on a helper. */
export const SDK_FEATURES = Object.freeze({commandMetadata: 1, messageFilter: 1, commandHelp: 1} as const);
export type SdkFeature = keyof typeof SDK_FEATURES;

/**
 * Assert that the host SDK exposes the requested capability names. On a host
 * whose `telebox/sdk` predates this helper the call itself fails at load time,
 * which is the intended explicit incompatibility signal.
 */
export function requireSdkFeatures(...features: readonly SdkFeature[]): void {
  const missing = features.filter(feature => !Object.hasOwn(SDK_FEATURES, feature));
  if (missing.length) throw new Error(`Unsupported SDK feature: ${missing.join(", ")}`);
}

export interface MessageEnvelope {
  readonly id: number;
  readonly chatId: string;
  readonly senderId?: string;
  readonly text: string;
  readonly outgoing: boolean;
  /** Protocol-derived direction; optional so existing envelopes keep compiling. */
  readonly direction?: MessageDirection;
  /** Protocol and known-entity classification; never fetched per message. */
  readonly chatType?: ChatType;
  readonly saved?: boolean;
  readonly edited?: boolean;
  readonly forwarded?: boolean;
  readonly replyToId?: number;
  readonly topicId?: number;
  readonly raw?: unknown;
}

/** Omitted parseMode means literal text, independent of the client's global default. */
export interface MessageOptions { parseMode?: "html" | "markdown"; linkPreview?: boolean; }

// The transport is supplied by the authenticated account runtime. The SDK
// never creates another client or imports the protocol library at module load.
export interface TelegramPort {
  edit(message: MessageEnvelope, text: string, options: MessageOptions, signal: AbortSignal): Promise<void>;
  reply(message: MessageEnvelope, text: string, options: MessageOptions, signal: AbortSignal): Promise<void>;
  invoke(request: unknown, signal: AbortSignal): Promise<unknown>;
  getReply(message: MessageEnvelope, signal: AbortSignal): Promise<MessageEnvelope | undefined>;
  withClient<T>(operation: (client: TelegramClient, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T>;
}

export interface PluginLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  error(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}

export interface PluginContext {
  readonly signal: AbortSignal;
  readonly tasks: ResourceScope;
  readonly telegram: {
    edit(message: MessageEnvelope, text: string, options?: MessageOptions): Promise<void>;
    reply(message: MessageEnvelope, text: string, options?: MessageOptions): Promise<void>;
    invoke(request: unknown): Promise<unknown>;
    getReply(message: MessageEnvelope): Promise<MessageEnvelope | undefined>;
    withClient<T>(operation: (client: TelegramClient, signal: AbortSignal) => Promise<T>): Promise<T>;
  };
  readonly storage: {
    json<T extends Record<string, unknown>>(fileName: string, defaults: T): Pick<JsonStore<T>, "read" | "update">;
    sqlite(fileName: string, options?: SqliteOptions): Pick<SqliteStore, "read" | "transaction" | "preflight">;
  };
  readonly jobs: {
    register(id: string, spec: ScheduledJob, handler: (signal: AbortSignal) => void | Promise<void>): Promise<() => Promise<void>>;
  };
  readonly services: {
    available(pluginId: string, service: string): boolean;
    call<T = unknown>(pluginId: string, service: string, input: unknown, signal?: AbortSignal): Promise<T>;
  };
  readonly plugins: {
    list(): readonly Readonly<{id: string; description: string}>[];
  };
  /** Read-only view of the host's current prefix and alias routing rules. */
  readonly commands: {
    parse(text: string): CommandRoute | undefined;
  };
  readonly http: Pick<ScopedHttp, "withResponse" | "text" | "json">;
  readonly processes: Pick<ScopedProcesses, "run">;
  readonly files: Pick<ScopedFiles, "dataPath" | "dataDirectory" | "dataFile" | "withTemp">;
  readonly log: PluginLogger;
}

export interface CommandRoute {
  readonly prefix: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly text: string;
}

export interface CommandInvocation {
  readonly message: MessageEnvelope;
  readonly command: string;
  readonly prefix: string;
  readonly args: readonly string[];
  /** Deepest matched subcommand name. */
  readonly subcommand?: string;
  /** Full matched subcommand path from the root, when a declared path matched. */
  readonly subcommands?: readonly string[];
}

export interface CommandDefinition {
  readonly description: string;
  /** Usage tail rendered with the active prefix, for example `[关键词]`. */
  readonly args?: string;
  /** Extra usage spellings of the root handler, each with its own explanation. */
  readonly alternates?: readonly SubcommandVariant[];
  readonly arguments?: readonly CommandArgument[];
  readonly examples?: readonly CommandExample[];
  /** Recursive standard subcommands routed by the shared dispatcher. */
  readonly subcommands?: Readonly<Record<string, SubcommandDefinition>>;
  /** Subcommand selected when no argument is supplied. */
  readonly defaultSubcommand?: string;
  /** Match subcommand names and aliases case-sensitively. Defaults to insensitive. */
  readonly subcommandsCaseSensitive?: boolean;
  /** Long-form, structured help sections. `{prefix}` expands to the escaped active prefix. */
  readonly help?: readonly HelpSection[];
  /** Show the plugin's help when this command has no arguments. */
  readonly helpOnEmpty?: boolean;
  /** Additional single-argument help requests, preserving command-specific syntax. */
  readonly helpArgs?: readonly string[];
  readonly ignoreEdited?: boolean;
  /** Only admit messages in this direction before dispatching a handler. */
  readonly direction?: MessageDirection;
  /** Only admit these chat classifications; unknown never matches a restricted list. */
  readonly chats?: readonly ChatType[];
  /** Drop forwarded messages before dispatching a handler. */
  readonly ignoreForwarded?: boolean;
  /** Keep Saved Messages admitted even when the direction filter would reject them. */
  readonly includeSaved?: boolean;
  /** Top-level authorization, always run before a dispatched handler. */
  authorize?(invocation: CommandInvocation, context: PluginContext): boolean | void | Promise<boolean | void>;
  /** Business entry point and fallback for inputs the dispatcher does not claim. */
  handle(invocation: CommandInvocation, context: PluginContext): void | Promise<void>;
}

export interface MessageListener extends MessageFilter {
  readonly edited?: boolean;
  readonly ignoreCommands?: boolean;
  handle(message: MessageEnvelope, context: PluginContext): void | Promise<void>;
}

export interface JobDefinition extends ScheduledJob {
  handle(context: PluginContext, signal: AbortSignal): void | Promise<void>;
}

export interface ServiceDefinition {
  readonly description: string;
  handle(input: unknown, context: PluginContext, signal: AbortSignal): unknown | Promise<unknown>;
}

export interface PluginDefinition {
  readonly apiVersion: PluginApiVersion;
  readonly id: string;
  readonly description: string;
  /** Help HTML for the current prefix; also handles exact --help requests. */
  readonly renderHelp?: (prefix: string) => string;
  readonly commands: Readonly<Record<string, CommandDefinition>>;
  readonly listeners?: readonly MessageListener[];
  readonly jobs?: Readonly<Record<string, JobDefinition>>;
  readonly services?: Readonly<Record<string, ServiceDefinition>>;
  readonly settings?: (context: PluginContext) => SettingsAdapter;
  /** Optional per-plugin helper-process defaults, bounded by the host's hard limits. */
  readonly resources?: {
    readonly processes?: Pick<ProcessLimits, "concurrency" | "queueCapacity" | "timeoutMs" | "maxOutputBytes">;
  };
  setup?(context: PluginContext): void | Promise<void>;
  cleanup?(context: PluginContext): void | Promise<void>;
}

const DISPATCHER = Symbol("telebox.command.dispatcher");
type DispatcherHandle = CommandDefinition["handle"] & {[DISPATCHER]?: {fallback: CommandDefinition["handle"]}};

/** Unwrap a generated dispatcher back to the original business handler. */
function fallbackHandle(handle: CommandDefinition["handle"]): CommandDefinition["handle"] {
  return (handle as DispatcherHandle)[DISPATCHER]?.fallback ?? handle;
}

/** Build a dispatcher that is idempotent across repeated normalization. */
function dispatcherFor(definition: () => CommandDefinition, fallback: CommandDefinition["handle"]): CommandDefinition["handle"] {
  const handler = ((invocation, context) => dispatchCommand(definition(), fallback, invocation, context)) as DispatcherHandle;
  Object.defineProperty(handler, DISPATCHER, {value: {fallback}});
  return handler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid ${label}`);
  return value;
}

function normalizeArguments(command: string, value: unknown): readonly CommandArgument[] {
  if (!Array.isArray(value)) throw new Error(`Invalid command arguments: ${command}`);
  const seen = new Set<string>();
  return Object.freeze(value.map(entry => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 64 ||
        (entry.required !== undefined && typeof entry.required !== "boolean") ||
        (entry.description !== undefined && typeof entry.description !== "string")) {
      throw new Error(`Invalid command argument: ${command}`);
    }
    if (seen.has(entry.name)) throw new Error(`Duplicate command argument: ${command}`);
    seen.add(entry.name);
    return Object.freeze({
      name: entry.name,
      ...(entry.required !== undefined ? {required: entry.required} : {}),
      ...(entry.description !== undefined ? {description: entry.description} : {}),
    });
  }));
}

function normalizeExamples(command: string, value: unknown): readonly CommandExample[] {
  if (!Array.isArray(value)) throw new Error(`Invalid command examples: ${command}`);
  return Object.freeze(value.map(entry => {
    if (!isRecord(entry) || (entry.args !== undefined && (typeof entry.args !== "string" || entry.args.includes("\0"))) ||
        (entry.description !== undefined && typeof entry.description !== "string")) {
      throw new Error(`Invalid command example: ${command}`);
    }
    return Object.freeze({
      ...(entry.args !== undefined ? {args: entry.args} : {}),
      ...(entry.description !== undefined ? {description: entry.description} : {}),
    });
  }));
}

function normalizeVariants(command: string, value: unknown): readonly SubcommandVariant[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`Invalid command alternates: ${command}`);
  return Object.freeze(value.map(entry => {
    if (!isRecord(entry) || typeof entry.args !== "string" || !entry.args.trim() || entry.args.includes("\0") ||
        typeof entry.description !== "string") {
      throw new Error(`Invalid command alternate: ${command}`);
    }
    return Object.freeze({args: entry.args, description: entry.description});
  }));
}

function normalizeHelp(command: string, value: unknown): readonly HelpSection[] {
  if (!Array.isArray(value)) throw new Error(`Invalid command help: ${command}`);
  return Object.freeze(value.map(entry => {
    if (!isRecord(entry) || typeof entry.body !== "string" ||
        (entry.heading !== undefined && typeof entry.heading !== "string")) {
      throw new Error(`Invalid command help: ${command}`);
    }
    return Object.freeze({
      ...(entry.heading !== undefined ? {heading: entry.heading} : {}),
      body: entry.body,
    });
  }));
}

function normalizeAliases(command: string, value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.some(alias => typeof alias !== "string" || !alias.trim() || /\s/.test(alias))) {
    throw new Error(`Invalid subcommand aliases: ${command}`);
  }
  return Object.freeze([...value]);
}

function normalizeSubcommands(command: string, value: unknown, sensitive: boolean): Readonly<Record<string, SubcommandDefinition>> {
  if (!isRecord(value)) throw new Error(`Invalid subcommands: ${command}`);
  const registered: {token: string; sensitive: boolean; owner: string}[] = [];
  const result: Record<string, SubcommandDefinition> = Object.create(null);
  for (const [subName, entry] of Object.entries(value)) {
    const label = `${command} ${subName}`;
    if (!/^[a-z0-9_][a-z0-9_-]*$/i.test(subName) || !isRecord(entry) || typeof entry.description !== "string" ||
        typeof entry.handle !== "function" ||
        (entry.public !== undefined && typeof entry.public !== "boolean") ||
        (entry.group !== undefined && typeof entry.group !== "string") ||
        (entry.authorize !== undefined && typeof entry.authorize !== "function") ||
        (entry.caseSensitive !== undefined && typeof entry.caseSensitive !== "boolean") ||
        (entry.subcommandsCaseSensitive !== undefined && typeof entry.subcommandsCaseSensitive !== "boolean")) {
      throw new Error(`Invalid subcommand definition: ${label}`);
    }
    const aliases = normalizeAliases(label, entry.aliases);
    const childSensitive = entry.caseSensitive ?? sensitive;
    for (const token of [subName, ...(aliases ?? [])]) {
      // Matching overlaps when the literal spellings are equal, or when at least
      // one side is case-insensitive and their case folds are equal. Two
      // case-sensitive siblings may keep differently-cased names.
      for (const previous of registered) {
        const overlap = token === previous.token ||
          ((!childSensitive || !previous.sensitive) && token.toLowerCase() === previous.token.toLowerCase());
        if (overlap && previous.owner !== subName) throw new Error(`Conflicting subcommand name: ${command} ${token}`);
      }
      registered.push({token, sensitive: childSensitive, owner: subName});
    }
    const args = optionalString(entry.args, `subcommand arguments: ${label}`);
    const alternates = entry.alternates === undefined ? undefined : normalizeVariants(label, entry.alternates);
    const notes = entry.notes === undefined ? undefined : (() => {
      if (!Array.isArray(entry.notes) || entry.notes.some(note => typeof note !== "string")) {
        throw new Error(`Invalid subcommand notes: ${label}`);
      }
      return Object.freeze([...entry.notes]);
    })();
    const nested = entry.subcommands === undefined
      ? undefined
      : normalizeSubcommands(label, entry.subcommands, entry.subcommandsCaseSensitive ?? sensitive);
    if (entry.defaultSubcommand !== undefined &&
        (typeof entry.defaultSubcommand !== "string" || !nested || !Object.hasOwn(nested, entry.defaultSubcommand))) {
      throw new Error(`Invalid default subcommand: ${label}`);
    }
    result[subName] = Object.freeze({
      description: entry.description,
      ...(aliases ? {aliases} : {}),
      ...(args !== undefined ? {args} : {}),
      ...(alternates ? {alternates} : {}),
      ...(entry.arguments !== undefined ? {arguments: normalizeArguments(label, entry.arguments)} : {}),
      ...(entry.examples !== undefined ? {examples: normalizeExamples(label, entry.examples)} : {}),
      ...(entry.help !== undefined ? {help: normalizeHelp(label, entry.help)} : {}),
      ...(nested ? {subcommands: nested} : {}),
      ...(entry.defaultSubcommand !== undefined ? {defaultSubcommand: entry.defaultSubcommand} : {}),
      ...(entry.subcommandsCaseSensitive !== undefined ? {subcommandsCaseSensitive: entry.subcommandsCaseSensitive} : {}),
      ...(entry.caseSensitive !== undefined ? {caseSensitive: entry.caseSensitive} : {}),
      ...(entry.group !== undefined ? {group: entry.group} : {}),
      ...(notes ? {notes} : {}),
      ...(entry.public !== undefined ? {public: entry.public} : {}),
      ...(entry.authorize ? {authorize: entry.authorize as SubcommandDefinition["authorize"]} : {}),
      handle: entry.handle as SubcommandDefinition["handle"],
    });
  }
  return Object.freeze(result);
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  if (definition.apiVersion !== PLUGIN_API_VERSION && definition.apiVersion !== STRUCTURED_PLUGIN_API_VERSION) {
    throw new Error("Unsupported plugin API version");
  }
  if (definition.apiVersion < STRUCTURED_PLUGIN_API_VERSION && usesStructuredMetadata(definition)) {
    throw new Error("Structured command metadata requires plugin API version 2");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(definition.id)) throw new Error("Invalid plugin id");
  if (typeof definition.description !== "string" || !definition.commands || typeof definition.commands !== "object") {
    throw new Error("Plugin description and commands are required");
  }
  const commands: Record<string, CommandDefinition> = Object.create(null);
  for (const [name, value] of Object.entries(definition.commands)) {
    if (!/^[a-z0-9_]+$/i.test(name) || !isRecord(value) || typeof value.description !== "string") {
      throw new Error(`Invalid command definition: ${name}`);
    }
    const command = value as unknown as CommandDefinition;
    if (typeof command.handle !== "function") throw new Error(`Invalid command definition: ${name}`);
    if (command.helpOnEmpty !== undefined && typeof command.helpOnEmpty !== "boolean") throw new Error("Invalid empty-command help policy");
    if (command.helpArgs !== undefined && (!Array.isArray(command.helpArgs) || command.helpArgs.some(arg => typeof arg !== "string" || !arg || /\s/.test(arg)))) {
      throw new Error("Invalid command help arguments");
    }
    if (command.subcommandsCaseSensitive !== undefined && typeof command.subcommandsCaseSensitive !== "boolean") {
      throw new Error(`Invalid subcommand case policy: ${name}`);
    }
    if (command.authorize !== undefined && typeof command.authorize !== "function") {
      throw new Error(`Invalid command authorization: ${name}`);
    }
    const filter = normalizeMessageFilter(`command ${name}`, command as unknown as Record<string, unknown>);
    const args = optionalString(command.args, `command arguments: ${name}`);
    const alternates = command.alternates === undefined ? undefined : normalizeVariants(name, command.alternates);
    const normalizedSubcommands = command.subcommands !== undefined
      ? normalizeSubcommands(name, command.subcommands, command.subcommandsCaseSensitive === true)
      : undefined;
    if (command.defaultSubcommand !== undefined &&
        (typeof command.defaultSubcommand !== "string" || !normalizedSubcommands ||
         !Object.hasOwn(normalizedSubcommands, command.defaultSubcommand))) {
      throw new Error(`Invalid default subcommand: ${name}`);
    }
    const rawFallback = fallbackHandle(command.handle);
    const normalized: CommandDefinition = Object.freeze({
      description: command.description,
      ...(args !== undefined ? {args} : {}),
      ...(alternates ? {alternates} : {}),
      ...(command.arguments !== undefined ? {arguments: normalizeArguments(name, command.arguments)} : {}),
      ...(command.examples !== undefined ? {examples: normalizeExamples(name, command.examples)} : {}),
      ...(command.help !== undefined ? {help: normalizeHelp(name, command.help)} : {}),
      ...(normalizedSubcommands ? {subcommands: normalizedSubcommands} : {}),
      ...(command.defaultSubcommand !== undefined ? {defaultSubcommand: command.defaultSubcommand} : {}),
      ...(command.subcommandsCaseSensitive !== undefined ? {subcommandsCaseSensitive: command.subcommandsCaseSensitive} : {}),
      ...(command.helpOnEmpty !== undefined ? {helpOnEmpty: command.helpOnEmpty} : {}),
      ...(command.helpArgs ? {helpArgs: Object.freeze([...command.helpArgs])} : {}),
      ...(command.ignoreEdited !== undefined ? {ignoreEdited: command.ignoreEdited} : {}),
      ...(filter ?? {}),
      ...(command.authorize ? {authorize: command.authorize} : {}),
      handle: (command.authorize || normalizedSubcommands)
        ? dispatcherFor(() => normalized, rawFallback)
        : command.handle,
    });
    commands[name] = normalized;
  }
  const listeners = definition.listeners?.map(listener => {
    if (!listener || typeof listener.handle !== "function") throw new Error("Invalid message listener");
    if (listener.edited !== undefined && typeof listener.edited !== "boolean") throw new Error("Invalid message listener");
    if (listener.ignoreCommands !== undefined && typeof listener.ignoreCommands !== "boolean") throw new Error("Invalid message listener");
    const filter = normalizeMessageFilter("listener", listener as unknown as Record<string, unknown>);
    return Object.freeze({
      ...listener,
      ...(filter ?? {}),
    });
  });
  if (definition.renderHelp !== undefined && typeof definition.renderHelp !== "function") throw new Error("Invalid help renderer");
  if (definition.settings !== undefined && typeof definition.settings !== "function") throw new Error("Invalid settings factory");
  for (const [name, service] of Object.entries(definition.services ?? {})) {
    if (!/^[a-z0-9_]+$/i.test(name) || !service || typeof service.description !== "string" || typeof service.handle !== "function") {
      throw new Error("Invalid service definition");
    }
  }
  for (const [name, job] of Object.entries(definition.jobs ?? {})) {
    if (!/^[a-z0-9_]+$/i.test(name) || !job || typeof job.cron !== "string" || typeof job.description !== "string" || typeof job.handle !== "function") {
      throw new Error("Invalid scheduled job definition");
    }
  }
  const freezeEntries = <T extends object>(entries: Readonly<Record<string, T>> | undefined) => entries &&
    Object.freeze(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, Object.freeze({...value})])));
  const resources = definition.resources && Object.freeze({
    ...definition.resources,
    processes: definition.resources.processes && Object.freeze({...definition.resources.processes}),
  });
  return Object.freeze({...definition, resources, commands: Object.freeze(commands),
    listeners: listeners && Object.freeze(listeners),
    jobs: freezeEntries(definition.jobs), services: freezeEntries(definition.services),
  });
}
