import {bold, code, text} from "./ui/text";
import type {CommandDefinition, CommandInvocation, PluginContext} from "./sdk";

/** Classification of the chat a message belongs to. Unknown fails closed. */
export type ChatType = "private" | "group" | "supergroup" | "broadcast" | "unknown";
export type MessageDirection = "incoming" | "outgoing";

export const CHAT_TYPES: readonly ChatType[] = Object.freeze([
  "private", "group", "supergroup", "broadcast", "unknown",
]);
export const MESSAGE_DIRECTIONS: readonly MessageDirection[] = Object.freeze(["incoming", "outgoing"]);

/** Optional message admission declared next to the handler it protects. */
export interface MessageFilter {
  /** Only admit messages in this direction. Omitted means both directions. */
  readonly direction?: MessageDirection;
  /** Only admit these chat classifications. A restricted list never matches unknown. */
  readonly chats?: readonly ChatType[];
  /** Drop forwarded messages before any business handler runs. */
  readonly ignoreForwarded?: boolean;
  /** Keep Saved Messages admitted even when the direction filter would reject them. */
  readonly includeSaved?: boolean;
}

export interface CommandArgument {
  readonly name: string;
  readonly required?: boolean;
  readonly description?: string;
}

export interface CommandExample {
  /** Argument tail appended to the command invocation, for example `search nezha`. */
  readonly args?: string;
  readonly description?: string;
}

/** A long-form, plugin-authored help block. `{prefix}` expands to the escaped active prefix. */
export interface HelpSection {
  readonly heading?: string;
  readonly body: string;
}

/** One usage spelling of a handler with its own explanation. */
export interface SubcommandVariant {
  readonly args: string;
  readonly description: string;
}

/** Recursive, handler-free command metadata consumed by the help renderer. */
export interface CommandHelpSource {
  readonly description: string;
  /** Usage tail rendered with the active prefix, for example `[关键词]`. */
  readonly args?: string;
  /** Extra usage spellings for the root handler. */
  readonly alternates?: readonly SubcommandVariant[];
  readonly arguments?: readonly CommandArgument[];
  readonly examples?: readonly CommandExample[];
  readonly subcommands?: Readonly<Record<string, SubcommandHelpSource>>;
  readonly defaultSubcommand?: string;
  readonly subcommandsCaseSensitive?: boolean;
  readonly help?: readonly HelpSection[];
  /** Single-argument help requests in addition to `--help`. */
  readonly helpArgs?: readonly string[];
}

/** Recursive, handler-free subcommand metadata. */
export interface SubcommandHelpSource {
  readonly description: string;
  readonly aliases?: readonly string[];
  /** First usage tail, for example `[关键词]`. Rendered with the active prefix. */
  readonly args?: string;
  /** Extra usage spellings of the same handler, each with its own explanation. */
  readonly alternates?: readonly SubcommandVariant[];
  readonly arguments?: readonly CommandArgument[];
  readonly examples?: readonly CommandExample[];
  readonly subcommands?: Readonly<Record<string, SubcommandHelpSource>>;
  readonly defaultSubcommand?: string;
  readonly subcommandsCaseSensitive?: boolean;
  readonly help?: readonly HelpSection[];
  /** Heading used to group this subcommand in generated help. */
  readonly group?: string;
  /** Extra trusted-HTML bullet lines rendered after this subcommand. */
  readonly notes?: readonly string[];
  /**
   * Exempts this node's own authorization. A public direct child also exempts
   * the root command authorization; deeper public nodes never skip a higher
   * ancestor's check.
   */
  readonly public?: boolean;
  /**
   * Match this node's own name and aliases case-sensitively, overriding the
   * enclosing level's `subcommandsCaseSensitive` policy. Used when a command
   * mixes insensitive and sensitive spellings at the same level.
   */
  readonly caseSensitive?: boolean;
}

/** A standard subcommand. The shared dispatcher resolves names, aliases, defaults and nesting. */
export interface SubcommandDefinition extends SubcommandHelpSource {
  readonly subcommands?: Readonly<Record<string, SubcommandDefinition>>;
  /** Runs before this node's handler and before descending into its children. */
  readonly authorize?: CommandAuthorization;
  handle(invocation: CommandInvocation, context: PluginContext): void | Promise<void>;
}

export interface CommandHelpOptions {
  readonly prefix: string;
  /** Trusted HTML title; empty string omits the title block. */
  readonly title?: string;
  /** Trusted HTML summary; defaults to the selected node description. */
  readonly description?: string;
  /** Trusted HTML lead paragraph rendered after the summary. */
  readonly intro?: string;
  /** Trusted HTML footer lines; `{prefix}` expands to the escaped active prefix. */
  readonly footer?: readonly string[];
  /** Declared subcommand path to render, for example `["install"]`. Defaults to the root. */
  readonly path?: readonly string[];
}

export type CommandAuthorization = (
  invocation: CommandInvocation, context: PluginContext,
) => boolean | void | Promise<boolean | void>;

type SubcommandTree = {
  readonly subcommands?: Readonly<Record<string, SubcommandHelpSource>>;
  readonly subcommandsCaseSensitive?: boolean;
  readonly defaultSubcommand?: string;
};

/** Resolve a raw token against one level of the declared tree, honoring per-child case policy. */
export function resolveSubcommandName(
  source: SubcommandTree,
  token: string | undefined,
  sensitive = source.subcommandsCaseSensitive === true,
): string | undefined {
  if (token === undefined || !source.subcommands) return undefined;
  const matches = (value: string, childSensitive: boolean): boolean =>
    childSensitive ? value === token : value.toLowerCase() === token.toLowerCase();
  for (const [name, sub] of Object.entries(source.subcommands)) {
    if (matches(name, sub.caseSensitive ?? sensitive)) return name;
  }
  for (const [name, sub] of Object.entries(source.subcommands)) {
    for (const alias of sub.aliases ?? []) if (matches(alias, sub.caseSensitive ?? sensitive)) return name;
  }
  return undefined;
}

/**
 * A declared help request: a fully resolved subcommand path followed by exactly
 * one help token. Root help accepts the command's declared `helpArgs`; deeper
 * paths accept only `--help` so free-text arguments are never captured.
 */
export function resolveHelpPath(
  source: CommandHelpSource,
  args: readonly string[],
  helpTokens: readonly string[] = ["--help"],
): string[] | undefined {
  if (!args.length) return undefined;
  const last = args[args.length - 1].toLowerCase();
  const pathTokens = args.slice(0, -1);
  if (!pathTokens.length) {
    const rootTokens = new Set(["--help", ...helpTokens].map(token => token.toLowerCase()));
    return rootTokens.has(last) ? [] : undefined;
  }
  if (last !== "--help") return undefined;
  const path: string[] = [];
  let node: SubcommandTree = source;
  let sensitive = source.subcommandsCaseSensitive === true;
  for (const token of pathTokens) {
    const match = resolveSubcommandName(node, token, sensitive);
    if (!match) return undefined;
    path.push(match);
    const next = node.subcommands![match];
    node = next;
    sensitive = next.subcommandsCaseSensitive ?? sensitive;
  }
  return path;
}

/** Validate and freeze a message admission declaration, or return undefined when absent. */
export function normalizeMessageFilter(label: string, source: Record<string, unknown>): MessageFilter | undefined {
  const {direction, chats, ignoreForwarded, includeSaved} = source;
  if (direction === undefined && chats === undefined && ignoreForwarded === undefined && includeSaved === undefined) return undefined;
  if (direction !== undefined && direction !== "incoming" && direction !== "outgoing") {
    throw new Error(`Invalid ${label} direction`);
  }
  let frozenChats: readonly ChatType[] | undefined;
  if (chats !== undefined) {
    if (!Array.isArray(chats) || !chats.length ||
        chats.some(chat => typeof chat !== "string" || !CHAT_TYPES.includes(chat as ChatType))) {
      throw new Error(`Invalid ${label} chat types`);
    }
    frozenChats = Object.freeze([...new Set(chats as ChatType[])]);
  }
  if (ignoreForwarded !== undefined && typeof ignoreForwarded !== "boolean") {
    throw new Error(`Invalid ${label} forwarded policy`);
  }
  if (includeSaved !== undefined && typeof includeSaved !== "boolean") {
    throw new Error(`Invalid ${label} saved policy`);
  }
  return Object.freeze({
    ...(direction !== undefined ? {direction: direction as MessageDirection} : {}),
    ...(frozenChats ? {chats: frozenChats} : {}),
    ...(ignoreForwarded !== undefined ? {ignoreForwarded} : {}),
    ...(includeSaved !== undefined ? {includeSaved} : {}),
  });
}

const STRUCTURED_COMMAND_KEYS = [
  "args", "alternates", "arguments", "examples", "subcommands", "defaultSubcommand", "subcommandsCaseSensitive",
  "help", "direction", "chats", "ignoreForwarded", "includeSaved", "authorize",
] as const;
const STRUCTURED_LISTENER_KEYS = ["direction", "chats", "ignoreForwarded", "includeSaved"] as const;

/**
 * Detect declarations that only a version-2 host understands. Used by the
 * plugin API gate so an older host rejects them instead of ignoring them.
 */
export function usesStructuredMetadata(definition: {commands?: unknown; listeners?: unknown}): boolean {
  const {commands, listeners} = definition;
  if (commands && typeof commands === "object") {
    for (const value of Object.values(commands)) {
      if (value && typeof value === "object" &&
          STRUCTURED_COMMAND_KEYS.some(key => (value as Record<string, unknown>)[key] !== undefined)) return true;
    }
  }
  if (Array.isArray(listeners)) {
    for (const listener of listeners) {
      if (listener && typeof listener === "object" &&
          STRUCTURED_LISTENER_KEYS.some(key => (listener as Record<string, unknown>)[key] !== undefined)) return true;
    }
  }
  return false;
}

/**
 * Shared standard dispatch. Authorization always runs along the matched path
 * before any handler (root before child, child before its descendants). A node
 * that declares itself `public` exempts its own check; a public direct child
 * also exempts the root command authorization, while a deeper public node
 * never skips a higher ancestor's check.
 */
export async function dispatchCommand(
  definition: CommandDefinition,
  fallback: CommandDefinition["handle"],
  invocation: CommandInvocation,
  context: PluginContext,
): Promise<void> {
  const path: {name: string; sub: SubcommandDefinition}[] = [];
  let node: SubcommandTree = definition;
  let sensitive = definition.subcommandsCaseSensitive === true;
  let index = 0;
  while (node.subcommands) {
    const token = invocation.args[index];
    const match = resolveSubcommandName(node, token, sensitive)
      ?? (token === undefined && node.defaultSubcommand ? node.defaultSubcommand : undefined);
    if (!match) break;
    const sub = node.subcommands[match] as SubcommandDefinition;
    path.push({name: match, sub});
    index += 1;
    node = sub;
    sensitive = sub.subcommandsCaseSensitive ?? sensitive;
  }
  const first = path[0];
  if (definition.authorize && !(first?.sub.public)) {
    if (await definition.authorize(invocation, context) === false) return;
  }
  for (const {sub} of path) {
    if (sub.public) continue;
    if (sub.authorize && await sub.authorize(invocation, context) === false) return;
  }
  const leaf = path[path.length - 1];
  const dispatchInvocation = Object.freeze({
    ...invocation,
    args: Object.freeze([...invocation.args.slice(index)]),
    ...(leaf ? {subcommand: leaf.name, subcommands: Object.freeze(path.map(entry => entry.name))} : {}),
  });
  if (leaf) {
    await leaf.sub.handle(dispatchInvocation, context);
    return;
  }
  await fallback(dispatchInvocation, context);
}

const expandPrefix = (value: string, prefix: string): string => value.split("{prefix}").join(prefix);

function argumentLine(argument: CommandArgument): string {
  const suffix = argument.required ? "（必填）" : "";
  const description = argument.description ? ` — ${argument.description}` : "";
  return `• ${code(argument.name)}${text(suffix)}${description}`;
}

function variantLines(invocation: string, fallbackDescription: string, variants: readonly SubcommandVariant[], prefix: string): string[] {
  const entries = variants.length ? variants : [{args: "", description: fallbackDescription}];
  return entries.map(variant => {
    const usage = code(`${invocation}${variant.args ? ` ${variant.args}` : ""}`);
    return `• ${usage} — ${expandPrefix(variant.description || fallbackDescription, prefix)}`;
  });
}

function exampleLines(invocation: string, examples: readonly CommandExample[] | undefined, prefix: string): string[] {
  return (examples ?? []).map(example =>
    `示例：${code(`${invocation}${example.args ? ` ${example.args}` : ""}`)}${example.description ? ` — ${expandPrefix(example.description, prefix)}` : ""}`);
}

function helpBlocks(sections: readonly HelpSection[] | undefined, prefix: string): string[] {
  return (sections ?? []).map(section => {
    const body = expandPrefix(section.body, prefix);
    return section.heading ? `${bold(section.heading)}\n${body}` : body;
  });
}

/**
 * Render every declared field of one node (usage variants, aliases, examples,
 * arguments, notes, long help). Shared by focused nodes and by child entries so
 * the two paths can never drift.
 */
function renderDeclaredFields(
  node: SubcommandHelpSource,
  invocation: string,
  exampleInvocation: string,
  prefix: string,
): string[] {
  const escaped = text(prefix);
  const variants: SubcommandVariant[] = [];
  if (node.args !== undefined) variants.push({args: node.args, description: node.description});
  variants.push(...(node.alternates ?? []));
  const bullets = variantLines(invocation, node.description, variants, escaped);
  if (node.aliases?.length) {
    bullets[0] += `（简写：${node.aliases.map(alias => code(`${exampleInvocation} ${alias}`)).join("、")}）`;
  }
  const lines = [...bullets];
  lines.push(...exampleLines(exampleInvocation, node.examples, escaped));
  for (const argument of node.arguments ?? []) lines.push(argumentLine(argument));
  for (const note of node.notes ?? []) lines.push(expandPrefix(note, escaped));
  lines.push(...helpBlocks(node.help, escaped));
  return lines;
}

/**
 * Render one subcommand and, recursively, its whole declared subtree. Examples
 * are declared relative to the node's parent path (matching TPM/alias, whose
 * example args already contain the subcommand name or alias), so the same
 * example renders identically at the root and when the node is focused.
 */
function renderSubcommandEntry(name: string, parentPath: readonly string[], subName: string, sub: SubcommandHelpSource, prefix: string): string[] {
  const parentInvocation = `${prefix}${name}${parentPath.length ? ` ${parentPath.join(" ")}` : ""}`;
  const invocation = `${parentInvocation} ${subName}`;
  return [
    ...renderDeclaredFields(sub, invocation, parentInvocation, prefix),
    ...renderChildren(name, [...parentPath, subName], sub, prefix),
  ];
}

/** Render every direct child of a node, grouped by its declared headings. */
function renderChildren(name: string, parentPath: readonly string[], node: CommandHelpSource | SubcommandHelpSource, prefix: string): string[] {
  const blocks: string[] = [];
  const groups = new Map<string, [string, SubcommandHelpSource][]>();
  const ungrouped: [string, SubcommandHelpSource][] = [];
  for (const [subName, sub] of Object.entries(node.subcommands ?? {})) {
    if (sub.group) groups.set(sub.group, [...(groups.get(sub.group) ?? []), [subName, sub]]);
    else ungrouped.push([subName, sub]);
  }
  for (const [heading, entries] of groups) {
    const lines = [bold(heading).toString()];
    for (const [subName, sub] of entries) lines.push(...renderSubcommandEntry(name, parentPath, subName, sub, prefix));
    blocks.push(lines.join("\n"));
  }
  if (ungrouped.length) {
    const lines: string[] = [];
    for (const [subName, sub] of ungrouped) lines.push(...renderSubcommandEntry(name, parentPath, subName, sub, prefix));
    blocks.push(lines.join("\n"));
  }
  return blocks;
}

function renderNode(name: string, path: readonly string[], node: CommandHelpSource | SubcommandHelpSource, prefixText: string): string[] {
  const invocation = `${prefixText}${name}${path.length ? ` ${path.join(" ")}` : ""}`;
  // The parent path owns example and alias expansion because their args include the node name/alias.
  const exampleInvocation = `${prefixText}${name}${path.length > 1 ? ` ${path.slice(0, -1).join(" ")}` : ""}`;
  const blocks: string[] = [...renderDeclaredFields(node, invocation, exampleInvocation, prefixText)];
  blocks.push(...renderChildren(name, path, node, prefixText));
  return blocks.filter(block => block.length > 0);
}

/** Build the bounded detailed help shared by command routing and the help center. */
export function renderCommandHelp(
  name: string,
  source: CommandHelpSource,
  options: CommandHelpOptions,
): string {
  const path = options.path ?? [];
  let node: CommandHelpSource | SubcommandHelpSource = source;
  for (const step of path) {
    const next = node.subcommands?.[step];
    if (!next) throw new Error(`Unknown help path: ${[...path].join(" ")}`);
    node = next;
  }
  const prefixText = options.prefix;
  const prefixEscaped = text(options.prefix);
  const blocks: string[] = [];
  const defaultTitle = path.length ? bold(`${name} ${path.join(" ")}`) : bold(name);
  blocks.push(options.title ?? defaultTitle);
  const description = options.description ?? node.description;
  if (description) blocks.push(expandPrefix(description, prefixEscaped));
  if (options.intro) blocks.push(expandPrefix(options.intro, prefixEscaped));
  blocks.push(...renderNode(name, path, node, prefixText));
  for (const line of options.footer ?? []) blocks.push(expandPrefix(line, prefixEscaped));
  return blocks.filter(block => block.length > 0).join("\n");
}

/** True when a command carries enough metadata to render its own detailed help. */
export function hasStructuredHelp(source: CommandHelpSource): boolean {
  return source.args !== undefined || source.arguments !== undefined || source.examples !== undefined ||
    source.help !== undefined || source.subcommands !== undefined || source.alternates !== undefined;
}
