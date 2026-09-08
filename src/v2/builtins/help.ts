import {isOwnerOrGroupSendAs} from "../permissions";
import {getBotName, setBotName} from "../branding";
import type {PluginHost} from "../host";
import {definePlugin, type CommandInvocation, type PluginContext, type PluginDefinition} from "../sdk";
import {bold, code, command, concat, link, text, type Html} from "../ui/text";
import {renderDocument, richText, section, type DocumentOptions, type Section} from "../ui/document";

type HelpHost = Pick<PluginHost, "listCommands" | "listPlugins" | "configuration">;
type PluginInfo = ReturnType<HelpHost["listPlugins"]>[number];
type CatalogCommand = ReturnType<HelpHost["listCommands"]>[number];

const pluginIcons: Readonly<Record<string, string>> = {
  ai: "🤖", da: "🛡️", dc: "🌐", dme: "🗑️", gt: "🌍", ids: "🪪",
  ip: "📍", nodeseek: "🔎", rate: "💱", sum: "📝", yvlu: "🖼️",
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
): {plugin: PluginInfo; usage?: string} | undefined {
  const prefix = [...prefixes].sort((a, b) => b.length - a.length).find(candidate => query.startsWith(candidate));
  if (prefix) query = query.slice(prefix.length);
  const parts = query.trim().split(/\s+/).filter(Boolean);
  let alias: string | undefined;
  for (let length = parts.length; length > 0; length -= 1) {
    const candidate = parts.slice(0, length).join(" ");
    // Match host parsing: longer aliases win, but real commands own single tokens.
    if (length === 1 && plugins.some(plugin => plugin.commands.some(entry => entry.name === candidate))) continue;
    if (Object.hasOwn(aliases, candidate) && aliases[candidate]) {
      alias = candidate;
      break;
    }
  }
  const commandName = (alias ? aliases[alias] : query).trim().split(/\s+/)[0].toLowerCase();
  const owner = plugins.find(plugin => plugin.commands.some(entry => entry.name.toLowerCase() === commandName));
  if (owner) return {plugin: owner, usage: alias ?? owner.commands.find(entry => entry.name.toLowerCase() === commandName)!.name};
  if (alias) return undefined;
  const plugin = plugins.find(entry => entry.id.toLowerCase() === query.toLowerCase());
  return plugin && {plugin, usage: plugin.commands[0]?.name};
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
    ["常用命令", new Set(["agent", "ai", "gt", "memory", "ping", "status", "sysinfo", "tpm", "update"])],
    ["系统工具", new Set(["alias", "autofix", "bf", "env", "exec", "help", "loglevel", "prefix", "privacy", "restart", "sudo", "version"])],
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
  if (extensionLines.length) sections.push(section("扩展插件", extensionLines));
  if (!listed.size && !ungrouped.length) sections.push(section([text("暂无可用命令")]));
  const jobs = plugins.filter(plugin => !plugin.commands.length).map(plugin => code(plugin.id));
  if (jobs.length) sections.push(section("定时模块", jobs));

  const footer: Html[] = [
    concat(text("发送 "), command(prefix, "help", "<命令>"), text(" 查看详细说明")),
  ];
  if (commands.some(entry => entry.name === "tpm")) {
    footer.push(concat(command(prefix, "tpm", "search"), text(" 显示远程插件列表")));
  }
  footer.push(concat(
    link("https://github.com/MiCat-S/Mi-Box", `${getBotName()} 仓库`), text(" | "),
    link("https://github.com/MiCat-S/Mi-Box-Plugins", "插件仓库"),
  ));
  return {
    title: `${getBotName()} 控制台`,
    subtitle: `${commands.length} 个命令 · ${plugins.length} 个模块\n前缀 ${configuration.prefixes.map(value => value).join(" · ")}`,
    sections,
    footer,
  };
}

export async function buildPluginDetails(
  plugin: PluginInfo,
  prefix: string,
  aliases: Readonly<Record<string, string>>,
  usage?: string,
): Promise<DocumentOptions> {
  const commandLines: Html[] = [];
  for (const entry of [...plugin.commands].sort((left, right) => left.name.localeCompare(right.name))) {
    commandLines.push(commandLine(entry.name, prefix, aliases));
    if (entry.description && entry.description !== plugin.description) commandLines.push(...await richText(entry.description));
  }
  if (!commandLines.length) commandLines.push(text("无可调用命令"));

  const sections: Section[] = [
    section("功能说明", await richText(plugin.renderHelp?.(prefix) ?? (plugin.description || "暂无描述信息"))),
    section("可用命令", commandLines),
  ];
  if (usage) sections.push(section(undefined, [concat(bold("使用方法："), code(` ${prefix}${usage} [参数]`))]));
  if (plugin.jobs.length) {
    const jobs: Html[] = [];
    for (const job of plugin.jobs) {
      jobs.push(concat(code(job.name), text(" "), code(`(${job.cron})`)));
      jobs.push(...await richText(job.description || "暂无描述信息"));
    }
    sections.push(section("定时任务", jobs));
  }
  return {
    title: `${pluginIcons[plugin.id.toLowerCase()] ?? "🧩"} ${plugin.id} 帮助`,
    subtitle: `${plugin.commands.length} 个命令`,
    sections,
    footer: await richText(`使用 ${code(`${prefix}help`)} 查看所有命令`),
  };
}

export function createHelp(host: HelpHost, ownerId?: string): PluginDefinition {
  const handle = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    context.signal.throwIfAborted();
    if (invocation.args[0] === "name") {
      const value = invocation.args.slice(1).join(" ").trim();
      if (!value) {
        await context.telegram.edit(invocation.message, `当前显示名：${getBotName()}\n设置：${invocation.prefix}help name 名称\n恢复：${invocation.prefix}help name reset`);
        return;
      }
      if (!isOwnerOrGroupSendAs(invocation.message, ownerId) || invocation.message.forwarded) {
        await context.telegram.edit(invocation.message, "只有账号本人可以设置显示名");
        return;
      }
      const name = value === "reset" ? "MiBot" : value;
      if (!name || [...name].length > 48 || /[\u0000-\u001f\u007f]/u.test(name)) {
        await context.telegram.edit(invocation.message, "名称须为 1–48 个字符，不能包含换行或控制字符");
        return;
      }
      await context.storage.json("branding.json", {name: "MiBot"}).update(state => ({...state, name}));
      setBotName(name);
      await context.telegram.edit(invocation.message, `显示名已设为：${getBotName()}`);
      return;
    }

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
            title: `${getBotName()} 帮助`,
            sections: [section(undefined, [text(`未找到命令或模块 ${query}`), concat(text("使用 "), command(invocation.prefix, "help"), text(" 查看所有命令"))])],
          });
        } else {
          output = await renderDocument(await buildPluginDetails(
            target.plugin,
            invocation.prefix,
            configuration.aliases,
            target.usage,
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
  return definePlugin({
    apiVersion: 1,
    id: "help",
    async setup(context) {
      const state = await context.storage.json("branding.json", {name: "MiBot"}).read();
      setBotName(state.name);
    },
    description: "查看帮助；使用 help name 名称 设置显示名，help name reset 恢复默认",
    commands: {
      help: {description: "查看命令或模块帮助", handle},
      h: {description: "查看命令或模块帮助", handle},
    },
  });
}
