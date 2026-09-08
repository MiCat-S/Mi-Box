import path from "node:path";
import {getBotName} from "../branding";
import {definePlugin, type PluginContext} from "../sdk";
import type {PluginHost} from "../host";
import type {PluginReleases} from "../releases";
import {isOwnerOrGroupSendAs} from "../permissions";
import {code, command, concat, text, type Html} from "../ui/text";
import {renderDocument, section} from "../ui/document";
import {renderFeedback} from "../ui/feedback";

const PAGE_SIZE = 24;
const htmlOptions = {parseMode: "html", linkPreview: false} as const;
type Candidate = {id: string; revision?: string; error?: string};
const validId = (id: string) => /^[a-z][a-z0-9_-]{0,63}$/.test(id);

function errorCode(error: unknown): string {
  const allowed = new Set(["STATE", "CONFLICT", "STOP", "ACTIVATE", "RESTORE", "SPAWN_FAILED",
    "EXIT_FAILED", "TIMED_OUT", "OUTPUT_LIMIT", "IO_FAILED", "CONTROL_FAILED", "CLOSED", "ABORTED",
    "FORMAT", "BOUNDARY", "LIMIT", "INTEGRITY", "IO", "BUSY", "LOAD", "FACTORY", "IDENTITY", "RELEASED"]);
  const value = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof value === "string" && allowed.has(value) ? value : "UNKNOWN";
}

async function listView(
  ids: readonly string[],
  title: string,
  prefix: string,
  hint: string,
  query?: string,
): Promise<readonly string[]> {
  const sorted = [...new Set(ids)].sort();
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pages: Html[][] = [];
  for (let page = 0; page < pageCount; page += 1) {
    const values = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    pages.push(values.length ? values.map(id => concat(text("• "), code(id))) : [text("没有匹配结果")]);
  }
  const output = (await Promise.all(pages.map(lines => renderDocument({
    title: `${getBotName()} 插件管理`,
    subtitle: `${title}${query !== undefined ? ` · 搜索：${query || "全部"}` : ""} · ${sorted.length} 个`,
    sections: [section(undefined, lines)],
    footer: [
      text(hint),
      concat(text("用法："), command(prefix, "tpm", title === "已安装扩展" ? "search [关键词]" : "install 插件名")),
    ],
  })))).flat();
  // The renderer caps HTML at 3500 units, leaving room below Telegram's
  // 4096-unit limit for the physical page number without another split.
  return output.map((page, index) => `${page}\n${index + 1}/${output.length} 页`);
}

export default function createTpm(host: PluginHost, releases: PluginReleases, root: string, ownerId: string) {
  let busy = false;
  const repository = async (ctx: PluginContext, action: string, ...ids: string[]) => {
    const result = await ctx.processes.run(process.execPath, [path.join(root, "scripts/plugin-repository.cjs"), action, ...ids],
      {timeoutMs: ["build-all", "build-selected"].includes(action) ? 180000 : 30000, maxOutputBytes: 65536});
    return JSON.parse(result.stdout.toString("utf8")) as {ids?: string[]; id?: string; revision?: string; candidates?: Candidate[]};
  };
  return definePlugin({apiVersion: 1, id: "tpm", description: "安装、卸载和更新 V2 扩展插件",
    renderHelp: prefix => concat(
      text("管理 V2 扩展插件\n"),
      command(prefix, "tpm", "search [关键词]"), text(" · 搜索扩展\n"),
      command(prefix, "tpm", "install 插件名"), text(" · 安装一个扩展\n"),
      command(prefix, "tpm", "install all"), text(" · 安装全部可用扩展，跳过已加载和默认模块\n"),
      command(prefix, "tpm", "list"), text(" · 查看已安装扩展\n"),
      command(prefix, "tpm", "update 插件名"), text(" · 更新扩展\n"),
      command(prefix, "tpm", "update all"), text(" · 更新全部已安装扩展\n"),
      command(prefix, "tpm", "remove all"), text(" · 卸载全部已安装扩展并保留配置\n"),
      command(prefix, "tpm", "remove 插件名"), text(" · 卸载扩展并保留配置\n批量操作会继续处理失败后的插件，并汇总结果。"),
    ),
    commands: {tpm: {description: "管理插件仓库中的 V2 扩展", ignoreEdited: true, async handle(invocation, ctx) {
      const [raw = "list", id] = invocation.args;
      const sub = raw.toLowerCase();
      if (sub === "list" || sub === "ls") {
        const ids = releases.snapshot().generations.filter(item => item.state === "active").map(item => item.id);
        const output = await listView(ids, "已安装扩展", invocation.prefix,
          "默认模块不计入扩展列表", undefined);
        for (const [index, page] of output.entries()) {
          ctx.signal.throwIfAborted();
          if (!index) await ctx.telegram.edit(invocation.message, page, htmlOptions);
          else await ctx.telegram.reply(invocation.message, page, htmlOptions);
        }
        return;
      }
      if (!isOwnerOrGroupSendAs(invocation.message, ownerId)) {
        await ctx.telegram.edit(invocation.message, "只有账号所有者可以管理插件"); return;
      }
      if (busy) {await ctx.telegram.edit(invocation.message, "插件管理任务正在执行，请稍后再试"); return;}
      if (!["search", "s", "install", "i", "remove", "rm", "update"].includes(sub)) {
        await ctx.telegram.edit(invocation.message, `${invocation.prefix}tpm search [关键词]\n${invocation.prefix}tpm install|remove|update 插件名\n${invocation.prefix}tpm install|update|remove all\n${invocation.prefix}tpm list`); return;
      }
      if (!["search", "s"].includes(sub) && (!id || !/^[a-z][a-z0-9_-]{0,63}$/.test(id) || invocation.args.length !== 2)) {
        await ctx.telegram.edit(invocation.message, "请提供一个有效的插件名"); return;
      }
      busy = true;
      let stage = "repository";
      try {
        if (sub === "search" || sub === "s") {
          await ctx.telegram.edit(invocation.message, renderFeedback({state: "working", title: "正在读取 V2 插件仓库…"}), htmlOptions);
          const {ids} = await repository(ctx, "search");
          const query = invocation.args.slice(1).join(" ").trim().toLowerCase();
          const matches = (ids ?? []).filter(name => /^[a-z][a-z0-9_-]{0,63}$/.test(name) &&
            name.includes(query) && !["ai", "gt"].includes(name));
          const output = await listView(matches, "可安装扩展", invocation.prefix,
            "仓库结果仅包含允许安装的 V2 扩展", query);
          for (const [index, page] of output.entries()) {
            ctx.signal.throwIfAborted();
            if (!index) await ctx.telegram.edit(invocation.message, page, htmlOptions);
            else await ctx.telegram.reply(invocation.message, page, htmlOptions);
          }
          return;
        }
        if (id === "all" && ["install", "i", "update", "remove", "rm"].includes(sub)) {
          const updating = sub === "update";
          const removing = sub === "remove" || sub === "rm";
          const verb = removing ? "卸载" : updating ? "更新" : "安装";
          const targets = [...new Set(releases.snapshot().generations.map(item => item.id))].sort();
          if ((updating || removing) && !targets.length) {
            await ctx.telegram.edit(invocation.message, "没有已安装的扩展插件", htmlOptions); return;
          }
          await ctx.telegram.edit(invocation.message,
            renderFeedback({state: "working", title: removing ? "正在卸载全部已安装扩展…" : updating ? "正在下载并构建已安装扩展…" : "正在下载并构建全部可安装扩展…"}), htmlOptions);
          const excluded = new Set(host.listPlugins().map(plugin => plugin.id).filter(validId));
          const result = removing ? {ids: targets, candidates: targets.map(id => ({id}) as Candidate)}
            : updating ? await repository(ctx, "build-selected", ...targets)
            : await repository(ctx, "build-all", ...excluded);
          if (!Array.isArray(result.ids) || !Array.isArray(result.candidates) ||
              result.ids.some(value => typeof value !== "string" || !validId(value)) ||
              result.candidates.some(value => !value || typeof value.id !== "string" || !validId(value.id))) {
            throw new Error("Invalid candidates");
          }
          if (updating && (result.candidates.length !== targets.length ||
              new Set(result.candidates.map(item => item.id)).size !== targets.length ||
              result.candidates.some(item => !targets.includes(item.id)))) throw new Error("Invalid update candidates");
          stage = removing ? "unload" : "activate";
          const installedIds: string[] = [];
          const skipped = new Set(updating || removing ? [] : result.ids.filter(value => excluded.has(value)));
          const failed: {id: string; code: string}[] = [];
          for (const [index, candidate] of result.candidates.entries()) {
            ctx.signal.throwIfAborted();
            if (!updating && !removing && host.pluginState(candidate.id)) {skipped.add(candidate.id); continue;}
            let failure: string | undefined;
            if (!removing && (candidate.error || !candidate.revision)) failure = candidate.error === "NOT_AVAILABLE" ? "NOT_AVAILABLE" : "BUILD";
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
          const output = await renderDocument({
            title: `${getBotName()} 插件批量${verb}完成`,
            subtitle: `成功 ${installedIds.length} · 跳过 ${skipped.size} · 失败 ${failed.length}`,
            sections: [
              section(`已${verb}`, installedIds.length ? installedIds.map(id => code(id)) : [text(`无${verb}成功的插件`)]),
              ...(skipped.size ? [section("已安装或默认模块", [...skipped].sort().map(id => code(id)))] : []),
              ...(failed.length ? [section(`${verb}失败`, failed.map(item => concat(code(item.id), text(` · ${item.code}`))))] : []),
            ],
            footer: [...(removing ? [text("插件配置数据已保留")] : []),
              concat(text("查看已安装扩展："), command(invocation.prefix, "tpm", "list"))],
          });
          for (const [index, page] of output.entries()) {
            ctx.signal.throwIfAborted();
            if (!index) await ctx.telegram.edit(invocation.message, page, htmlOptions);
            else await ctx.telegram.reply(invocation.message, page, htmlOptions);
          }
          return;
        }
        const installed = releases.snapshot().generations.some(item => item.id === id);
        if (host.pluginState(id) && !installed) {
          await ctx.telegram.edit(invocation.message, "默认模块由程序管理，不通过 TPM 替换或卸载"); return;
        }
        if (sub === "remove" || sub === "rm") {
          stage = "unload";
          await releases.remove(id);
          await ctx.telegram.edit(invocation.message, renderFeedback({
            state: "success", title: "卸载完成", detail: `${id} · 配置数据已保留`,
          }), htmlOptions);
        } else {
          await ctx.telegram.edit(invocation.message,
            renderFeedback({state: "working", title: `正在下载并构建 ${id}…`}), htmlOptions);
          const candidate = await repository(ctx, "build", id);
          if (candidate.id !== id || !candidate.revision) throw new Error("Invalid candidate");
          stage = "activate";
          await releases.activate(id, candidate.revision);
          await ctx.telegram.edit(invocation.message, renderFeedback({
            state: "success", title: `${installed ? "更新" : "安装"}完成`, detail: `${id} · 已加载`,
          }), htmlOptions);
        }
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
      } finally {busy = false;}
    }}},
  });
}
