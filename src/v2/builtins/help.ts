import {isOwnerOrGroupSendAs} from "../permissions";
import {getBotName, setBotName} from "../branding";
import type {PluginHost} from "../host";
import {definePlugin, STRUCTURED_PLUGIN_API_VERSION, type CommandDefinition, type CommandInvocation, type PluginContext, type PluginDefinition} from "../sdk";
import {code, command, concat, link, text, type Html} from "../ui/text";
import {renderDocument, richText, section, type DocumentOptions, type Section} from "../ui/document";
import {hasStructuredHelp, renderCommandHelp, resolveSubcommandName} from "../commands";

type HelpHost = Pick<PluginHost, "listCommands" | "listPlugins" | "configuration">;
type PluginInfo = ReturnType<HelpHost["listPlugins"]>[number];
type CatalogCommand = ReturnType<HelpHost["listCommands"]>[number];

const pluginIcons: Readonly<Record<string, string>> = {
  ai: "🤖", da: "🛡️", dc: "🌐", dme: "🗑️", gt: "🌍", ids: "🪪",
  ip: "📍", rate: "💱", sum: "📝", yvlu: "🖼️",
  memory: "🧠", ping: "🏓", status: "📊", env: "⚙️", alias: "🔗",
  prefix: "📌", privacy: "🔒", loglevel: "🔊", help: "❔",
};

function aliasesFor(commandName: string, aliases: Readonly<Record<string, string>>): string[] {
  return Object.entries(aliases)
    .filter(([, expansion]) => expansion.trim().split(/\s+/)[0]?.toLowerCase() === commandName.toLowerCase())
    .map(([alias]) => alias)
    .sort();
}

function commandLine(commandName: string, prefix: string, aliases: Readonly<Record<string, string>>): Html {
  const names = aliasesFor(commandName, aliases);
  if (!names.length) return command(prefix, commandName);
  const aliasesHtml: Html[] = [];
  names.forEach((name, index) => {
    if (index) aliasesHtml.push(text("、"));
    aliasesHtml.push(command(prefix, name));
  });
  return concat(command(prefix, commandName), text("（别名："), ...aliasesHtml, text("）"));
}

function resolve(
  query: string,
  plugins: PluginInfo[],
  prefixes: readonly string[],
  aliases: Readonly<Record<string, string>>,
): {plugin: PluginInfo; usage?: string; command?: string; path?: string[]} | undefined {
  const prefix = [...prefixes].sort((a, b) => b.length - a.length).find(candidate => query.startsWith(candidate));
  if (prefix) query = query.slice(prefix.length);
  const parts = query.trim().split(/\s+/).filter(Boolean);
  let alias: string | undefined;
  let aliasLength = 0;
  for (let length = parts.length; length > 0; length -= 1) {
    const candidate = parts.slice(0, length).join(" ");
    // Match host parsing: longer aliases win, but real commands own single tokens.
    if (length === 1 && plugins.some(plugin => plugin.commands.some(entry => entry.name === candidate))) continue;
    if (Object.hasOwn(aliases, candidate) && aliases[candidate]) {
      alias = candidate;
      aliasLength = length;
      break;
    }
  }
  const tokens = alias ? [...aliases[alias].trim().split(/\s+/), ...parts.slice(aliasLength)] : parts;
  const commandName = (tokens[0] ?? "").toLowerCase();
  const owner = plugins.find(plugin => plugin.commands.some(entry => entry.name.toLowerCase() === commandName));
  if (owner) {
    const entry = owner.commands.find(candidate => candidate.name.toLowerCase() === commandName)!;
    const path: string[] = [];
    let node = entry;
    let sensitive = entry.subcommandsCaseSensitive === true;
    for (const token of tokens.slice(1)) {
      const match = resolveSubcommandName(node, token, sensitive);
      if (!match || !node.subcommands) break;
      path.push(match);
      node = node.subcommands[match] as typeof entry;
      sensitive = node.subcommandsCaseSensitive ?? sensitive;
    }
    return {plugin: owner, usage: alias ?? entry.name, command: entry.name, ...(path.length ? {path} : {})};
  }
  if (alias) return undefined;
  const plugin = plugins.find(entry => entry.id.toLowerCase() === query.toLowerCase());
  return plugin && {plugin, usage: plugin.commands[0]?.name, command: plugin.commands[0]?.name};
}

interface OverviewInput {
  readonly configuration: ReturnType<HelpHost["configuration"]>;
  readonly commands: readonly CatalogCommand[];
  readonly plugins: readonly PluginInfo[];
}

export async function buildOverview(input: OverviewInput): Promise<DocumentOptions> {
  const {configuration, commands, plugins} = input;
  const prefix = configuration.prefixes[0] ?? ".";
  const aliases = configuration.aliases;
  const groups: ReadonlyArray<[string, ReadonlySet<string>]> = [
    ["⚡ 常用命令", new Set(["agent", "ai", "gt", "memory", "ping", "status", "sysinfo", "tpm", "update"])],
    ["🔧 系统工具", new Set(["alias", "autofix", "bf", "env", "exec", "help", "loglevel", "prefix", "privacy", "restart", "sudo", "version"])],
  ];
  const listed = new Set<string>();
  const sections: Section[] = [];
  const addCommands = (names: readonly string[]): Html[] => {
    const lines: Html[] = [];
    let row: Html[] = [];
    let commandCount = 0;
    let width = 0;
    const flush = (): void => {
      if (row.length) lines.push(concat(...row));
      row = [];
      commandCount = 0;
      width = 0;
    };
    for (const name of [...new Set(names)].sort()) {
      if (listed.has(name)) continue;
      listed.add(name);
      const aliasNames = aliasesFor(name, aliases);
      const line = commandLine(name, prefix, aliases);
      const length = prefix.length + name.length;
      if (aliasNames.length) {
        flush();
        lines.push(line);
        continue;
      }
      if (commandCount >= 4 || width + length + 2 > 36) flush();
      if (commandCount) row.push(text("  "));
      row.push(line);
      commandCount += 1;
      width += length + 2;
    }
    flush();
    return lines;
  };

  for (const [heading, ids] of groups) {
    const names = plugins
      .filter(plugin => ids.has(plugin.id.toLowerCase()))
      .flatMap(plugin => plugin.commands)
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
    const lines = addCommands(names);
    if (lines.length) sections.push(section(heading, lines));
  }
  const ungrouped = commands
    .filter(entry => !listed.has(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const extensionLines = addCommands(ungrouped);
  if (extensionLines.length) sections.push(section("🧩 扩展插件", extensionLines));
  if (!listed.size && !ungrouped.length) sections.push(section([text("暂无可用命令")]));
  const jobs = plugins.filter(plugin => !plugin.commands.length).map(plugin => code(plugin.id));
  if (jobs.length) sections.push(section("⏰ 定时模块", jobs));

  const footer: Html[] = [
    concat(text("💬 使用 "), command(prefix, "help", "<命令>"), text(" 查看命令详情")),
  ];
  if (commands.some(entry => entry.name === "tpm")) {
    footer.push(concat(text("📦 "), command(prefix, "tpm", "search"), text(" 浏览插件市场")));
  }
  footer.push(concat(
    link("https://github.com/MiCat-S/Mi-Box", "仓库"), text(" · "),
    link("https://github.com/MiCat-S/Mi-Box-Plugins", "插件"),
  ));
  return {
    title: `📋 ${getBotName()} 帮助中心`,
    subtitle: `${commands.length} 个命令 · ${plugins.length} 个模块 · 前缀 ${configuration.prefixes.join(" · ")}`,
    sections,
    footer,
  };
}

export async function buildPluginDetails(
  plugin: PluginInfo,
  prefix: string,
  aliases: Readonly<Record<string, string>>,
  usage?: string,
  commandName?: string,
  path?: readonly string[],
): Promise<DocumentOptions> {
  const focused = commandName ? plugin.commands.find(entry => entry.name === commandName) : undefined;
  let guide: readonly Html[] | undefined;
  if (focused && path?.length) guide = await richText(renderCommandHelp(focused.name, focused, {prefix, path}));
  else if (plugin.renderHelp) guide = await richText(plugin.renderHelp(prefix));

  const commandLines: Html[] = [];
  for (const entry of [...plugin.commands].sort((left, right) => left.name.localeCompare(right.name))) {
    commandLines.push(commandLine(entry.name, prefix, aliases));
    if (!plugin.renderHelp && hasStructuredHelp(entry)) {
      commandLines.push(...await richText(renderCommandHelp(entry.name, entry, {prefix, title: ""})));
    } else if (entry.description && entry.description !== plugin.description) {
      commandLines.push(...await richText(entry.description));
    }
  }
  if (!commandLines.length) commandLines.push(text("无可调用命令"));

  const sections: Section[] = [
    section("📖 功能说明", guide ?? await richText(plugin.description || "暂无描述信息")),
    section("⚙️ 可用命令", commandLines),
  ];
  if (usage && !guide) sections.push(section(undefined, [concat(text("💡 用法："), code(`${prefix}${usage} [参数]`))]));
  if (plugin.jobs.length) {
    const jobs: Html[] = [];
    for (const job of plugin.jobs) {
      jobs.push(concat(code(job.name), text(" "), code(`(${job.cron})`)));
      jobs.push(...await richText(job.description || "暂无描述信息"));
    }
    sections.push(section("⏰ 定时任务", jobs));
  }
  return {
    title: `${pluginIcons[plugin.id.toLowerCase()] ?? "🧩"} ${plugin.id}`,
    subtitle: plugin.commands.length ? `${plugin.commands.length} 个命令` : "定时模块",
    sections,
    footer: [concat(text("💬 "), command(prefix, "help"), text(" 返回帮助中心"))],
  };
}

export function createHelp(host: HelpHost, ownerId?: string): PluginDefinition {
  const name = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    context.signal.throwIfAborted();
    const value = invocation.args.join(" ").trim();
    if (!value) {
      await context.telegram.edit(invocation.message, `当前显示名：${getBotName()}\n设置：${invocation.prefix}help name 名称\n恢复：${invocation.prefix}help name reset`);
      return;
    }
    if (!isOwnerOrGroupSendAs(invocation.message, ownerId) || invocation.message.forwarded) {
      await context.telegram.edit(invocation.message, "只有账号本人可以设置显示名");
      return;
    }
    const next = value === "reset" ? "MiBot" : value;
    if (!next || [...next].length > 48 || /[\u0000-\u001f\u007f]/u.test(next)) {
      await context.telegram.edit(invocation.message, "名称须为 1–48 个字符，不能包含换行或控制字符");
      return;
    }
    await context.storage.json("branding.json", {name: "MiBot"}).update(state => ({...state, name: next}));
    setBotName(next);
    await context.telegram.edit(invocation.message, `显示名已设为：${getBotName()}`);
  };
  const handle = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    context.signal.throwIfAborted();
    let output: readonly string[];
    try {
      context.signal.throwIfAborted();
      const configuration = host.configuration();
      const commands = host.listCommands();
      const plugins = host.listPlugins();
      const query = invocation.args.join(" ").trim();
      if (!query) {
        output = await renderDocument(await buildOverview({configuration, commands, plugins}));
      } else {
        const target = resolve(query, [...plugins], configuration.prefixes, configuration.aliases);
        if (!target) {
          output = await renderDocument({
            title: `❌ 未找到`,
            sections: [section(undefined, [text(`未找到命令或模块：${query}`), concat(text("💬 "), command(invocation.prefix, "help"), text(" 查看所有可用命令"))])],
          });
        } else {
          output = await renderDocument(await buildPluginDetails(
            target.plugin,
            invocation.prefix,
            configuration.aliases,
            target.usage,
            target.command,
            target.path,
          ));
        }
      }
    } catch {
      context.signal.throwIfAborted();
      context.log.error("help.failed");
      output = ["帮助暂时不可用，请稍后重试。"];
    }
    for (const [index, page] of output.entries()) {
      context.signal.throwIfAborted();
      const options = {parseMode: "html" as const, linkPreview: false};
      if (index === 0) await context.telegram.edit(invocation.message, page, options);
      else await context.telegram.reply(invocation.message, page, options);
    }
  };
  const helpCommand: CommandDefinition = {
    description: "查看命令或模块帮助",
    args: "[命令或模块]",
    arguments: [{name: "命令或模块", description: "命令名、别名或插件 ID；省略时显示帮助中心"}],
    examples: [{args: "", description: "显示帮助中心"}, {args: "tpm install", description: "查看声明子命令路径的帮助"}, {args: "agent"}],
    // The display-name branch is a case-sensitive subcommand; other arguments stay a free-text query.
    subcommandsCaseSensitive: true,
    subcommands: {
      name: {
        description: "查看或设置机器人显示名",
        args: "[名称|reset]",
        arguments: [{name: "名称|reset", description: "省略时查看当前显示名；填写名称（1–48 字符）设置；填写 reset 恢复 MiBot"}],
        examples: [{args: "name"}, {args: "name MiBot"}, {args: "name reset"}],
        help: [
          {heading: "权限：", body: "查看当前显示名对所有人开放；设置仅限账号本人或本账号在群内以频道身份发出的新命令，转发消息不能设置。"},
        ],
        handle: name,
      },
    },
    help: [
      {
        heading: "用法",
        body: "• <code>{prefix}help</code> — 帮助中心\n" +
          "• <code>{prefix}help 命令或模块</code> — 命令或模块详情\n" +
          "• <code>{prefix}help 命令 子命令</code> — 声明子命令的详细帮助",
      },
      {
        heading: "显示名",
        body: "使用 <code>{prefix}help name 名称</code> 设置显示名，<code>{prefix}help name reset</code> 恢复默认。\n" +
          "仅账号本人或本账号在群内以频道身份发出的新命令可以修改；转发消息不能修改。名称 1–48 字符，不能包含换行或控制字符。",
      },
    ],
    handle,
  };
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "help",
    async setup(context) {
      const state = await context.storage.json("branding.json", {name: "MiBot"}).read();
      setBotName(state.name);
    },
    description: "查看帮助；使用 help name 名称 设置显示名，help name reset 恢复默认",
    commands: {
      help: helpCommand,
      h: helpCommand,
    },
  });
}
