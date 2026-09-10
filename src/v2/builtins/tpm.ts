import path from "node:path";
import {getBotName} from "../branding";
import {definePlugin, STRUCTURED_PLUGIN_API_VERSION, type CommandDefinition, type CommandInvocation, type PluginContext} from "../sdk";
import type {PluginHost} from "../host";
import type {PluginReleases} from "../releases";
import {isOwnerOrGroupSendAs} from "../permissions";
import {bold, code, command, concat, link, text, type Html} from "../ui/text";
import {PAGE_LABEL_RESERVE, pageLabel, renderDocument, richText, section} from "../ui/document";
import {renderFeedback} from "../ui/feedback";
import {isPluginId, resolvePluginId} from "../plugin-id";
import {renderCommandHelp, type HelpSection} from "../commands";

const htmlOptions = {parseMode: "html", linkPreview: false} as const;
type Candidate = {id: string; revision?: string; error?: string; ids?: string[]};

function descriptionFor(descriptions: Readonly<Record<string, string>>, id: string): string {
  return Object.hasOwn(descriptions, id) && typeof descriptions[id] === "string" ? descriptions[id] : "";
}

function errorCode(error: unknown): string {
  const allowed = new Set(["STATE", "CONFLICT", "STOP", "ACTIVATE", "RESTORE", "SPAWN_FAILED",
    "EXIT_FAILED", "TIMED_OUT", "OUTPUT_LIMIT", "IO_FAILED", "CONTROL_FAILED", "CLOSED", "ABORTED",
    "FORMAT", "BOUNDARY", "LIMIT", "INTEGRITY", "IO", "BUSY", "LOAD", "FACTORY", "IDENTITY", "RELEASED"]);
  const value = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof value === "string" && allowed.has(value) ? value : "UNKNOWN";
}

async function compactList(ids: readonly string[]): Promise<readonly Html[]> {
  const sorted = [...new Set(ids)].sort();
  if (!sorted.length) return [text("没有匹配结果")];
  const width = Math.min(12, Math.max(...sorted.map(id => id.length)));
  const blocks: Html[] = [];
  let body = "", rows = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const cells = [sorted[index]];
    while (cells[0].length <= width && cells.length < 3 &&
        sorted[index + 1] !== undefined && sorted[index + 1].length <= width) {
      cells.push(sorted[++index]);
    }
    const row = code(cells.map((id, column) => column < cells.length - 1 ? id.padEnd(width) : id).join("  "));
    // Keep each expandable block within the renderer's HTML and entity budgets.
    if (body && (body.length + row.length + 1 > 2400 || rows === 60)) {
      blocks.push(...await richText(`<blockquote expandable>${body}</blockquote>`));
      body = ""; rows = 0;
    }
    body += `${body ? "\n" : ""}${row}`;
    rows += 1;
  }
  if (body) blocks.push(...await richText(`<blockquote expandable>${body}</blockquote>`));
  return blocks;
}

async function listView(
  ids: readonly string[],
  title: string,
  prefix: string,
  hint: string,
  query?: string,
  descriptions?: Readonly<Record<string, string>>,
): Promise<readonly string[]> {
  const sorted = [...new Set(ids)].sort();
  const entries = descriptions && sorted.length
    ? (await Promise.all(sorted.map(id => richText(concat(code(id), text(` — ${descriptionFor(descriptions, id) || "暂无描述"}`)))))).flat()
    : await compactList(sorted);
  const output = await renderDocument({
    title: `${getBotName()} 插件管理`,
    subtitle: `${title}${query !== undefined ? ` · 搜索：${query || "全部"}` : ""} · ${sorted.length} 个`,
    sections: [section(undefined, entries)],
    footer: [
      text(hint),
      concat(text("用法："), command(prefix, "tpm", title === "已安装扩展" ? "search [关键词]" : "install 插件名")),
    ],
  }, PAGE_LABEL_RESERVE);
  return output.map((page, index) => page + pageLabel(index, output.length));
}

const tpmHelpSections: readonly HelpSection[] = Object.freeze([
  {
    heading: "📝 参数与操作说明",
    body: "• 单项操作每次填写一个插件名；全部操作使用小写 all。[关键词] 表示可选参数，输入时省略方括号。\n" +
      "• 插件名为 1–64 位字母、数字、下划线或连字符，以字母或数字开头；可直接复制搜索结果中的名称。\n" +
      "• 名称优先精确匹配，其次忽略大小写匹配。例如 git_pr 可匹配 git_PR，配置仍使用声明名称。出现大小写冲突时，复制提示中的完整名称执行单项操作。\n" +
      "• 安装、更新、卸载及仓库搜索由账号本人操作；支持本账号在群内以频道身份发出的新命令。\n" +
      "• 同时只运行一个插件管理任务。批量操作逐项执行，单个插件失败后继续处理其余插件，最后汇总成功、跳过和失败项。\n" +
      "• 批量下载或构建整体失败时，请检查仓库连接后重试；个别插件失败时，可按结果中的名称单独重试。长列表会分多条消息显示。",
  },
  {
    heading: "💡 常见提示",
    body: "• 未找到插件：先用 <code>{prefix}tpm search 关键词</code> 核对名称；卸载前用 " +
      "<code>{prefix}tpm list</code> 查看已安装列表。\n" +
      "• 默认模块：随应用一起维护，使用应用更新功能获取新版。\n" +
      "• 任务正在执行：等待当前操作结束，再提交下一条管理命令。\n" +
      "• 操作失败：根据提示中的失败阶段、错误码和下一步建议排查；批量结果会列出失败插件。",
  },
]);

export default function createTpm(host: PluginHost, releases: PluginReleases, root: string, ownerId: string) {
  let busy = false;
  const repository = async (ctx: PluginContext, action: string, ...ids: string[]) => {
    const result = await ctx.processes.run(process.execPath, [path.join(root, "scripts/plugin-repository.cjs"), action, ...ids],
      {timeoutMs: ["build-all", "build-selected"].includes(action) ? 180000 : 30000, maxOutputBytes: 65536});
    return JSON.parse(result.stdout.toString("utf8")) as {ids?: string[]; collisions?: string[][]; descriptions?: Record<string, string>; descriptionsAvailable?: boolean; id?: string; revision?: string; error?: string; candidates?: Candidate[]};
  };

  const authorizeOwner = async (invocation: CommandInvocation, ctx: PluginContext): Promise<boolean> => {
    if (isOwnerOrGroupSendAs(invocation.message, ownerId)) return true;
    await ctx.telegram.edit(invocation.message, "只有账号所有者可以管理插件");
    return false;
  };

  const exclusive = async (
    ctx: PluginContext,
    invocation: CommandInvocation,
    operation: (stage: (value: string) => void) => Promise<void>,
  ): Promise<void> => {
    if (busy) {
      await ctx.telegram.edit(invocation.message, "插件管理任务正在执行，请稍后再试");
      return;
    }
    busy = true;
    let stage = "repository";
    try {
      await operation(value => { stage = value; });
    } catch (error) {
      const failure = errorCode(error);
      ctx.log.error("tpm.operation_failed", {stage, code: failure});
      if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, renderFeedback({
        state: "error",
        title: "插件操作失败",
        diagnostic: {
          stage,
          code: failure,
          label: ({repository: "仓库访问", unload: "卸载", activate: "加载"} as Record<string, string>)[stage],
        },
        nextStep: stage === "repository"
          ? "在服务器运行 node scripts/plugin-repository.cjs search 检查仓库访问"
          : "请稍后重试或查看服务器日志",
      }), htmlOptions);
    } finally {
      busy = false;
    }
  };

  const sendPages = async (ctx: PluginContext, invocation: CommandInvocation, output: readonly string[]): Promise<void> => {
    for (const [index, page] of output.entries()) {
      ctx.signal.throwIfAborted();
      if (!index) await ctx.telegram.edit(invocation.message, page, htmlOptions);
      else await ctx.telegram.reply(invocation.message, page, htmlOptions);
    }
  };

  const installedList = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const ids = releases.snapshot().generations.filter(item => item.state === "active").map(item => item.id);
    const output = await listView(ids, "已安装扩展", invocation.prefix, "默认模块不计入扩展列表", undefined);
    await sendPages(ctx, invocation, output);
  };

  const searchRepository = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    await exclusive(ctx, invocation, async () => {
      await ctx.telegram.edit(invocation.message, renderFeedback({state: "working", title: "正在读取 V2 插件仓库…"}), htmlOptions);
      const {ids, collisions, descriptions = {}, descriptionsAvailable} = await repository(ctx, "search");
      const query = invocation.args.join(" ").trim().toLowerCase();
      const matches = (ids ?? []).filter(name => isPluginId(name) &&
        (name.toLowerCase().includes(query) || descriptionFor(descriptions, name).toLowerCase().includes(query)) && !["ai", "gt"].includes(name));
      const conflictGroups = (collisions ?? []).filter(group => Array.isArray(group) && group.length > 1);
      const hint = conflictGroups.length
        ? `仓库结果仅包含允许安装的 V2 扩展；仓库存在大小写冲突组：${conflictGroups.map(group => group.join(" / ")).join("；")}（批量构建会跳过整组，精确单项仍可安装）`
        : "仓库结果仅包含允许安装的 V2 扩展";
      const output = await listView(matches, "可安装扩展", invocation.prefix,
        hint + (descriptionsAvailable === false ? "；描述索引不可用，当前仅按名称搜索" : ""), query, descriptions);
      await sendPages(ctx, invocation, output);
    });
  };

  const mutate = async (invocation: CommandInvocation, ctx: PluginContext, action: "install" | "update" | "remove"): Promise<void> => {
    const id = invocation.args[0]!;
    await exclusive(ctx, invocation, async stage => {
      if (!id || !isPluginId(id) || invocation.args.length !== 1) {
        await ctx.telegram.edit(invocation.message, "请提供一个有效的插件名");
        return;
      }
      if (id === "all") {
        const updating = action === "update";
        const removing = action === "remove";
        const verb = removing ? "卸载" : updating ? "更新" : "安装";
        const targets = [...new Set(releases.snapshot().generations.map(item => item.id))].sort();
        if ((updating || removing) && !targets.length) {
          await ctx.telegram.edit(invocation.message, "没有已安装的扩展插件", htmlOptions); return;
        }
        await ctx.telegram.edit(invocation.message,
          renderFeedback({state: "working", title: removing ? "正在卸载全部已安装扩展…" : updating ? "正在下载并构建已安装扩展…" : "正在下载并构建全部可安装扩展…"}), htmlOptions);
        const excluded = new Set(host.listPlugins().map(plugin => plugin.id).filter(isPluginId));
        const result = removing ? {ids: targets, candidates: targets.map(id => ({id}) as Candidate)}
          : updating ? await repository(ctx, "build-selected", ...targets)
          : await repository(ctx, "build-all", ...excluded);
        if (!Array.isArray(result.ids) || !Array.isArray(result.candidates) ||
            result.ids.some(value => typeof value !== "string" || !isPluginId(value)) ||
            result.candidates.some(value => !value || typeof value.id !== "string" || !isPluginId(value.id))) {
          throw new Error("Invalid candidates");
        }
        if (updating && (result.candidates.length !== targets.length ||
            new Set(result.candidates.map(item => item.id)).size !== targets.length ||
            result.candidates.some(item => !targets.includes(item.id)))) throw new Error("Invalid update candidates");
        stage(removing ? "unload" : "activate");
        const installedIds: string[] = [];
        const skipped = new Set(updating || removing ? [] : result.ids.filter(value => excluded.has(value)));
        const failed: {id: string; code: string}[] = [];
        for (const [index, candidate] of result.candidates.entries()) {
          ctx.signal.throwIfAborted();
          if (!updating && !removing && host.pluginState(candidate.id)) {skipped.add(candidate.id); continue;}
          let failure: string | undefined;
          if (!removing && (candidate.error || !candidate.revision)) {
            failure = candidate.error === "AMBIGUOUS" ? "AMBIGUOUS"
              : candidate.error === "NOT_FOUND" || candidate.error === "NOT_AVAILABLE" ? "NOT_AVAILABLE" : "BUILD";
          }
          else {
            try {
              if (removing) await releases.remove(candidate.id);
              else await releases.activate(candidate.id, candidate.revision!);
              installedIds.push(candidate.id);
            }
            catch (error) {ctx.signal.throwIfAborted(); failure = errorCode(error);}
          }
          if (failure) {
            failed.push({id: candidate.id, code: failure});
            ctx.log.error("tpm.batch_failed", {id: candidate.id, code: failure});
          }
          if ((index + 1) % 10 === 0) await ctx.telegram.edit(invocation.message, renderFeedback({
            state: "working", title: `正在${verb}扩展 ${index + 1}/${result.candidates.length}`,
            detail: `成功 ${installedIds.length} · 失败 ${failed.length}`,
          }), htmlOptions);
        }
        // Only groups actually blocked in this batch are reported as blocked;
        // repository collisions that did not block anything stay a warning.
        const groupKey = (group: readonly string[]): string => group.join("\u0000");
        const blockedGroups = [...new Map((result.candidates ?? [])
          .filter(item => item.error === "AMBIGUOUS" && Array.isArray(item.ids) && item.ids.length > 1)
          .map(item => [groupKey(item.ids!), item.ids!])).values()];
        const repoGroups = (result.collisions ?? []).filter(group => Array.isArray(group) && group.length > 1);
        const collisionNotice = blockedGroups.length
          ? `本次已阻止大小写冲突组：${blockedGroups.map(group => group.join(" / ")).join("；")}`
          : repoGroups.length
            ? `仓库存在大小写冲突组：${repoGroups.map(group => group.join(" / ")).join("；")}（精确单项仍可安装）`
            : undefined;
        const output = await renderDocument({
          title: `${getBotName()} 插件批量${verb}完成`,
          subtitle: `成功 ${installedIds.length} · 跳过 ${skipped.size} · 失败 ${failed.length}`,
          sections: [
            ...(failed.length ? [section(`${verb}失败`, failed.map(item => concat(code(item.id), text(` · ${item.code}`))))] : []),
            ...(installedIds.length ? [section(`已${verb} · ${installedIds.length}`, await compactList(installedIds))] : []),
            ...(skipped.size ? [section(`已安装或默认模块 · ${skipped.size}`, await compactList([...skipped]))] : []),
          ],
          footer: [...(removing ? [text("插件配置数据已保留")] : []),
            ...(collisionNotice ? [text(collisionNotice)] : []),
            concat(text("查看已安装扩展："), command(invocation.prefix, "tpm", "list"))],
        }, PAGE_LABEL_RESERVE);
        for (const [index, page] of output.entries()) {
          ctx.signal.throwIfAborted();
          const labelled = page + pageLabel(index, output.length);
          if (!index) await ctx.telegram.edit(invocation.message, labelled, htmlOptions);
          else await ctx.telegram.reply(invocation.message, labelled, htmlOptions);
        }
        return;
      }
      const installedIds = releases.snapshot().generations.map(item => item.id);
      const defaultIds = host.listPlugins().map(plugin => plugin.id);
      // Resolve default modules locally before touching the repository so a
      // builtin such as help never triggers a network build attempt.
      const defaultFor = (input: string): string | undefined => {
        if (host.pluginState(input)) return input;
        const matches = defaultIds.filter(name => name.toLowerCase() === input.toLowerCase());
        return matches.length === 1 ? matches[0] : undefined;
      };
      const localDefault = defaultFor(id);
      if (localDefault && !installedIds.includes(localDefault)) {
        await ctx.telegram.edit(invocation.message, "默认模块由程序管理，不通过 TPM 替换或卸载"); return;
      }
      if (action === "remove") {
        const resolved = resolvePluginId(id, installedIds);
        if ("error" in resolved) {
          await ctx.telegram.edit(invocation.message, resolved.error === "AMBIGUOUS"
            ? `插件名 ${id} 存在大小写冲突：${resolved.ids.join("、")}；请使用完整名称`
            : `未安装扩展 ${id}`);
          return;
        }
        const canonical = resolved.id;
        stage("unload");
        await releases.remove(canonical);
        await ctx.telegram.edit(invocation.message, renderFeedback({
          state: "success", title: "卸载完成", detail: `${canonical} · 配置数据已保留`,
        }), htmlOptions);
      } else {
        await ctx.telegram.edit(invocation.message,
          renderFeedback({state: "working", title: `正在下载并构建 ${id}…`}), htmlOptions);
        const candidate = await repository(ctx, "build", id);
        if (candidate.error === "AMBIGUOUS") {
          await ctx.telegram.edit(invocation.message,
            `插件名 ${id} 存在大小写冲突：${(candidate.ids ?? []).join("、")}；请使用完整名称`); return;
        }
        if (candidate.error === "NOT_FOUND") {
          await ctx.telegram.edit(invocation.message, `插件 ${id} 不存在或不可用`); return;
        }
        const canonical = candidate.id;
        if (!canonical || !isPluginId(canonical) || !candidate.revision) throw new Error("Invalid candidate");
        const installed = installedIds.includes(canonical);
        if (host.pluginState(canonical) && !installed) {
          await ctx.telegram.edit(invocation.message, "默认模块由程序管理，不通过 TPM 替换或卸载"); return;
        }
        stage("activate");
        await releases.activate(canonical, candidate.revision);
        await ctx.telegram.edit(invocation.message, renderFeedback({
          state: "success", title: `${installed ? "更新" : "安装"}完成`, detail: `${canonical} · 已加载`,
        }), htmlOptions);
      }
    });
  };

  const tpmHelpOptions = (prefix: string) => ({
    prefix,
    title: bold(`📦 ${getBotName()} 插件管理器（TPM）`),
    intro: "搜索、安装、更新和卸载扩展插件，完成后即可使用。",
    footer: [`插件来源：${link("https://github.com/MiCat-S/Mi-Box-Plugins", "Mi-Box-Plugins")} 的 main 分支。`],
  });
  const buildHelp = (prefix: string): string => renderCommandHelp("tpm", tpmCommand, tpmHelpOptions(prefix));

  const tpmCommand: CommandDefinition = {
    description: "管理插件仓库中的 V2 扩展",
    helpOnEmpty: true,
    helpArgs: ["help", "h"],
    ignoreEdited: true,
    defaultSubcommand: "list",
    authorize: authorizeOwner,
    subcommands: {
      help: {
        group: "🔍 查看插件与帮助", args: "", public: true,
        description: "查看完整帮助；直接发送 tpm，或使用 h、--help 也可查看。",
        handle: async (invocation, ctx) => { await ctx.telegram.edit(invocation.message, buildHelp(invocation.prefix), htmlOptions); },
      },
      search: {
        group: "🔍 查看插件与帮助", aliases: ["s"], args: "[关键词]",
        description: "按插件名称或描述搜索，忽略大小写；省略关键词显示全部可安装插件及描述。索引不可用时仍可按名称查找。",
        handle: searchRepository,
      },
      list: {
        group: "🔍 查看插件与帮助", aliases: ["ls"], args: "", public: true,
        description: "查看当前已加载的扩展插件。默认模块由程序管理，单独随应用更新。",
        notes: ["• <code>{prefix}help 插件名</code> — 查看某个已加载插件的说明与命令，例如 <code>{prefix}help nezha</code>。"],
        handle: installedList,
      },
      install: {
        group: "⬇️ 安装插件", aliases: ["i"], args: "插件名",
        alternates: [{args: "all", description: "安装仓库中全部可用扩展，跳过已加载插件和默认模块。"}],
        description: "安装并加载指定扩展。对已安装的插件再次执行会更新它。",
        examples: [{args: "i nezha", description: "安装后用 <code>{prefix}help nezha</code> 查看配置和使用方法。"}],
        handle: (invocation, ctx) => mutate(invocation, ctx, "install"),
      },
      update: {
        group: "🔄 更新插件", args: "插件名",
        alternates: [{args: "all", description: "更新全部已安装扩展；需要补装仓库中的其他插件时，使用 install all。"}],
        description: "获取并加载指定扩展的最新版本；目标尚未安装时会安装该扩展。",
        examples: [{args: "update nezha", description: "更新后继续使用原有配置。"}],
        handle: (invocation, ctx) => mutate(invocation, ctx, "update"),
      },
      remove: {
        group: "🗑️ 卸载插件", aliases: ["rm"], args: "插件名",
        alternates: [{args: "all", description: "卸载全部已安装扩展，保留各插件配置数据；默认模块继续由程序管理。"}],
        description: "卸载指定扩展，保留插件配置数据。",
        examples: [{args: "rm nezha", description: "重新安装后可继续使用保留的配置。"}],
        handle: (invocation, ctx) => mutate(invocation, ctx, "remove"),
      },
    },
    help: tpmHelpSections,
    handle: async (invocation, ctx) => {
      await ctx.telegram.edit(invocation.message,
        `${invocation.prefix}tpm search [关键词]\n${invocation.prefix}tpm install|remove|update 插件名\n${invocation.prefix}tpm install|update|remove all\n${invocation.prefix}tpm list`);
    },
  };

  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "tpm",
    description: "安装、卸载和更新 V2 扩展插件",
    renderHelp: prefix => buildHelp(prefix),
    commands: {tpm: tpmCommand},
  });
}
