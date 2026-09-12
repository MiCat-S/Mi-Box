import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {Api} from "teleproto";
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
type Candidate = {id: string; revision?: string; error?: string; ids?: readonly string[]};
export interface TpmSuccessfulUpdateTrigger {
  readonly id: string;
  readonly source: "manual" | "automatic";
}
type AutoFailure = {id: string; code: string};
type AutoBatch = {
  trigger: TpmSuccessfulUpdateTrigger;
  createdAt: number;
  startedAt?: number;
  targets?: string[];
  updated: string[];
  unchanged: string[];
  failed: AutoFailure[];
  inFlight?: {id: string; revision: string};
};
type AutoResult = {
  triggerId: string;
  source: TpmSuccessfulUpdateTrigger["source"];
  startedAt: number;
  completedAt: number;
  targets: number;
  updated: string[];
  unchanged: string[];
  failed: AutoFailure[];
  failure?: {stage: "repository"; code: string};
};
type AutoNotification = {id: string; triggerId: string; text: string};
interface TpmAutoState extends Record<string, unknown> {
  schemaVersion: 1;
  enabled: boolean;
  pending: AutoBatch[];
  processedTriggerIds: string[];
  notifications: AutoNotification[];
  lastResult?: AutoResult;
}

const defaultAutoState: TpmAutoState = {
  schemaVersion: 1,
  enabled: false,
  pending: [],
  processedTriggerIds: [],
  notifications: [],
};
const revisionPattern = /^[a-f0-9]{64}$/;

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
    body: "• 安装、更新、卸载可填写多个插件名，以空格或换行分隔；重复名称只处理一次。全部操作使用小写 all，不能与插件名混用。[关键词] 表示可选参数，输入时省略方括号。\n" +
      "• 插件名为 1–64 位字母、数字、下划线或连字符，以字母或数字开头；可直接复制搜索结果中的名称。\n" +
      "• 名称优先精确匹配，其次忽略大小写匹配。例如 git_pr 可匹配 git_PR，配置仍使用声明名称。出现大小写冲突时，复制提示中的完整名称执行单项操作。\n" +
      "• 安装、更新、卸载及仓库搜索由账号本人操作；支持本账号在群内以频道身份发出的新命令。\n" +
      "• <code>{prefix}tpm auto on</code> 独立控制插件跟随更新。启用后，主程序更新成功会检查当前已安装扩展；有更新或失败时将结果发送到 Saved Messages。\n" +
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
  let context: PluginContext | undefined;
  let recoveryStarted = false;
  let busy: "manual" | "automatic" | undefined;
  let autoTask: Promise<void> | undefined;
  let notificationOperation: Promise<void> = Promise.resolve();
  const autoStore = (ctx: PluginContext) => ctx.storage.json<TpmAutoState>("auto-update.json", defaultAutoState);
  const pendingOf = (state: TpmAutoState): AutoBatch[] => Array.isArray(state.pending) ? state.pending : [];
  const processedOf = (state: TpmAutoState): string[] => Array.isArray(state.processedTriggerIds)
    ? state.processedTriggerIds.filter(value => typeof value === "string") : [];
  const notificationsOf = (state: TpmAutoState): AutoNotification[] => Array.isArray(state.notifications)
    ? state.notifications.filter(item => !!item && typeof item.id === "string" &&
      typeof item.triggerId === "string" && typeof item.text === "string") : [];
  const patchBatch = async (ctx: PluginContext, triggerId: string,
    mutate: (batch: AutoBatch) => AutoBatch): Promise<void> => {
    await autoStore(ctx).update(current => ({...current, schemaVersion: 1,
      pending: pendingOf(current).map(batch => batch.trigger.id === triggerId ? mutate(batch) : batch),
      processedTriggerIds: processedOf(current), notifications: notificationsOf(current),
      enabled: current.enabled === true,
    }));
  };
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
    busy = "manual";
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
      busy = undefined;
    }
  };

  const waitForManualOperation = async (signal: AbortSignal): Promise<void> => {
    while (busy === "manual") await delay(25, undefined, {signal});
    signal.throwIfAborted();
  };

  const autoFailureCode = (candidate: Candidate): string => candidate.error === "AMBIGUOUS" ? "AMBIGUOUS"
    : candidate.error === "NOT_FOUND" || candidate.error === "NOT_AVAILABLE" ? "NOT_AVAILABLE" : "BUILD";
  const clearInFlight = (batch: AutoBatch): AutoBatch => {
    const {inFlight: _inFlight, ...rest} = batch;
    return rest;
  };

  const validateAutoCandidates = (targets: readonly string[], result: {
    ids?: string[]; candidates?: Candidate[];
  }): Candidate[] => {
    if (!Array.isArray(result.ids) || !Array.isArray(result.candidates) ||
        result.ids.some(value => typeof value !== "string" || !isPluginId(value)) ||
        result.candidates.length !== targets.length ||
        new Set(result.candidates.map(item => item?.id)).size !== targets.length ||
        result.candidates.some(item => !item || typeof item.id !== "string" || !targets.includes(item.id) ||
          !isPluginId(item.id) || item.revision !== undefined && !revisionPattern.test(item.revision))) {
      throw Object.assign(new Error("Invalid automatic update candidates"), {code: "FORMAT"});
    }
    return result.candidates;
  };

  const renderAutoNotifications = async (result: AutoResult): Promise<readonly string[]> => {
    const failures: Html[] = result.failed.map(item => concat(code(item.id), text(` · ${item.code}`)));
    if (result.failure) failures.unshift(text(`仓库构建 · ${result.failure.code}`));
    const output = await renderDocument({
      title: `${getBotName()} 插件跟随更新完成`,
      subtitle: `已更新 ${result.updated.length} · 保持最新 ${result.unchanged.length} · 失败 ${failures.length}`,
      sections: [
        ...(failures.length ? [section("更新失败", failures)] : []),
        ...(result.updated.length ? [section(`已更新 · ${result.updated.length}`, await compactList(result.updated))] : []),
      ],
      footer: [text(`已检查 ${result.targets} 个已安装扩展`)],
    }, PAGE_LABEL_RESERVE);
    return output.map((page, index) => page + pageLabel(index, output.length));
  };

  const deliverNotificationsNow = async (ctx: PluginContext): Promise<void> => {
    while (true) {
      ctx.signal.throwIfAborted();
      const notification = notificationsOf(await autoStore(ctx).read())[0];
      if (!notification) return;
      try {
        await ctx.telegram.withClient(async client => {
          await client.sendMessage(new Api.InputPeerSelf(), {
            message: notification.text, parseMode: "html", linkPreview: false, silent: true,
          });
        });
      } catch {
        if (!ctx.signal.aborted) ctx.log.error("tpm.auto_notification_failed");
        return;
      }
      await autoStore(ctx).update(current => ({...current, schemaVersion: 1,
        enabled: current.enabled === true, pending: pendingOf(current), processedTriggerIds: processedOf(current),
        notifications: notificationsOf(current).filter(item => item.id !== notification.id),
      }));
    }
  };

  const deliverNotifications = (ctx: PluginContext): Promise<void> => {
    const delivery = notificationOperation.then(() => deliverNotificationsNow(ctx));
    notificationOperation = delivery.catch(() => undefined);
    return delivery;
  };

  const completeAutoBatch = async (ctx: PluginContext, batch: AutoBatch,
    failure?: AutoResult["failure"]): Promise<void> => {
    const result: AutoResult = {
      triggerId: batch.trigger.id,
      source: batch.trigger.source,
      startedAt: batch.startedAt ?? batch.createdAt,
      completedAt: Date.now(),
      targets: batch.targets?.length ?? 0,
      updated: [...new Set(batch.updated)].sort(),
      unchanged: [...new Set(batch.unchanged)].sort(),
      failed: [...batch.failed].sort((a, b) => a.id.localeCompare(b.id)),
      ...(failure ? {failure} : {}),
    };
    const shouldNotify = result.updated.length > 0 || result.failed.length > 0 || !!result.failure;
    const pages = shouldNotify ? await renderAutoNotifications(result) : [];
    await autoStore(ctx).update(current => {
      const processed = [...processedOf(current).filter(id => id !== batch.trigger.id), batch.trigger.id].slice(-64);
      return {...current, schemaVersion: 1, enabled: current.enabled === true,
        pending: pendingOf(current).filter(item => item.trigger.id !== batch.trigger.id),
        processedTriggerIds: processed,
        notifications: shouldNotify
          ? [...notificationsOf(current).filter(item => item.triggerId !== batch.trigger.id),
            ...pages.map((text, index) => ({id: `${batch.trigger.id}:${index}`, triggerId: batch.trigger.id, text}))]
          : notificationsOf(current),
        lastResult: result,
      };
    });
    await deliverNotifications(ctx);
  };

  const runAutoBatch = async (ctx: PluginContext, initial: AutoBatch, signal: AbortSignal): Promise<void> => {
    await waitForManualOperation(signal);
    if (busy) throw new Error("Automatic TPM operation collided with another task");
    busy = "automatic";
    try {
      let batch = pendingOf(await autoStore(ctx).read()).find(item => item.trigger.id === initial.trigger.id);
      if (!batch) return;
      if (!batch.targets) {
        const targets = [...new Set(releases.snapshot().generations
          .filter(item => item.state === "active").map(item => item.id))].sort();
        await patchBatch(ctx, batch.trigger.id, current => ({...current, startedAt: Date.now(), targets}));
        batch = pendingOf(await autoStore(ctx).read()).find(item => item.trigger.id === initial.trigger.id);
        if (!batch) return;
      }
      const targets = batch.targets ?? [];
      if (!targets.length) {
        await completeAutoBatch(ctx, batch);
        return;
      }
      let candidates: Candidate[];
      try {
        candidates = validateAutoCandidates(targets, await repository(ctx, "build-selected", ...targets));
      } catch (error) {
        signal.throwIfAborted();
        batch = pendingOf(await autoStore(ctx).read()).find(item => item.trigger.id === initial.trigger.id) ?? batch;
        await completeAutoBatch(ctx, batch, {stage: "repository", code: errorCode(error)});
        return;
      }
      batch = pendingOf(await autoStore(ctx).read()).find(item => item.trigger.id === initial.trigger.id);
      if (!batch) return;
      if (batch.inFlight) {
        const candidate = candidates.find(item => item.id === batch!.inFlight!.id);
        const current = releases.snapshot().generations.find(item => item.id === batch!.inFlight!.id && item.state === "active");
        const completed = candidate?.revision === batch.inFlight.revision && current?.revision === batch.inFlight.revision;
        await patchBatch(ctx, batch.trigger.id, value => ({...clearInFlight(value),
          ...(completed ? {updated: [...value.updated, value.inFlight!.id]} : {}),
        }));
      }
      for (const candidate of candidates) {
        signal.throwIfAborted();
        batch = pendingOf(await autoStore(ctx).read()).find(item => item.trigger.id === initial.trigger.id);
        if (!batch) return;
        if ([...batch.updated, ...batch.unchanged, ...batch.failed.map(item => item.id)].includes(candidate.id)) continue;
        const current = releases.snapshot().generations.find(item => item.id === candidate.id && item.state === "active");
        if (batch.inFlight?.id === candidate.id && batch.inFlight.revision === candidate.revision &&
            current?.revision === candidate.revision) {
          await patchBatch(ctx, batch.trigger.id, value => ({
            ...clearInFlight(value), updated: [...value.updated, candidate.id],
          }));
          continue;
        }
        if (candidate.error || !candidate.revision) {
          await patchBatch(ctx, batch.trigger.id, value => ({
            ...clearInFlight(value), failed: [...value.failed, {id: candidate.id, code: autoFailureCode(candidate)}],
          }));
          continue;
        }
        if (current?.revision === candidate.revision) {
          await patchBatch(ctx, batch.trigger.id, value => ({
            ...clearInFlight(value), unchanged: [...value.unchanged, candidate.id],
          }));
          continue;
        }
        await patchBatch(ctx, batch.trigger.id, value => ({...value,
          inFlight: {id: candidate.id, revision: candidate.revision!},
        }));
        try {
          await releases.activate(candidate.id, candidate.revision);
          await patchBatch(ctx, batch.trigger.id, value => ({
            ...clearInFlight(value), updated: [...value.updated, candidate.id],
          }));
        } catch (error) {
          signal.throwIfAborted();
          const failure = errorCode(error);
          ctx.log.error("tpm.auto_batch_failed", {id: candidate.id, code: failure});
          await patchBatch(ctx, batch.trigger.id, value => ({
            ...clearInFlight(value), failed: [...value.failed, {id: candidate.id, code: failure}],
          }));
        }
      }
      batch = pendingOf(await autoStore(ctx).read()).find(item => item.trigger.id === initial.trigger.id);
      if (batch) await completeAutoBatch(ctx, batch);
    } finally {
      busy = undefined;
    }
  };

  const processAutoQueue = async (ctx: PluginContext, signal: AbortSignal): Promise<void> => {
    await deliverNotifications(ctx);
    while (true) {
      signal.throwIfAborted();
      const batch = pendingOf(await autoStore(ctx).read())[0];
      if (!batch) return;
      await runAutoBatch(ctx, batch, signal);
    }
  };

  const ensureAutoTask = (ctx: PluginContext): void => {
    if (autoTask || ctx.signal.aborted) return;
    const task = ctx.tasks.run("tpm:auto-update", signal => processAutoQueue(ctx, signal));
    autoTask = task;
    void task.catch(() => {
      if (!ctx.signal.aborted) ctx.log.error("tpm.auto_update_failed");
    }).finally(async () => {
      autoTask = undefined;
      if (ctx.signal.aborted) return;
      try {
        if (pendingOf(await autoStore(ctx).read()).length) ensureAutoTask(ctx);
      } catch {
        if (!ctx.signal.aborted) ctx.log.error("tpm.auto_recovery_failed");
      }
    });
  };

  const followSuccessfulUpdate = async (trigger: TpmSuccessfulUpdateTrigger): Promise<void> => {
    const ctx = context;
    if (!ctx || !trigger || !["manual", "automatic"].includes(trigger.source) ||
        typeof trigger.id !== "string" || !trigger.id || trigger.id.length > 256 || trigger.id.includes("\0")) return;
    let accepted = false;
    await autoStore(ctx).update(current => {
      const pending = pendingOf(current);
      const processed = processedOf(current);
      const duplicate = processed.includes(trigger.id) || pending.some(batch => batch.trigger.id === trigger.id);
      if (current.enabled !== true || duplicate) return {...current, schemaVersion: 1,
        enabled: current.enabled === true, pending, processedTriggerIds: processed, notifications: notificationsOf(current)};
      accepted = true;
      return {...current, schemaVersion: 1, enabled: true, processedTriggerIds: processed,
        notifications: notificationsOf(current), pending: [...pending, {
          trigger: {...trigger}, createdAt: Date.now(), updated: [], unchanged: [], failed: [],
        }]};
    });
    if (accepted) ensureAutoTask(ctx);
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
      const installed = new Set(releases.snapshot().generations.map(item => item.id));
      const builtins = new Set(host.listPlugins().map(plugin => plugin.id).filter(id => !installed.has(id)));
      const matches = (ids ?? []).filter(name => isPluginId(name) &&
        (name.toLowerCase().includes(query) || descriptionFor(descriptions, name).toLowerCase().includes(query)) && !builtins.has(name));
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
    const requested = [...new Set(invocation.args)];
    const id = requested[0]!;
    await exclusive(ctx, invocation, async stage => {
      if (!requested.length || requested.some(value => !isPluginId(value)) || requested.includes("all") && requested.length > 1) {
        await ctx.telegram.edit(invocation.message, "请提供有效的插件名，多个名字用空格或换行分隔；all 必须单独使用");
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
      if (id === "all" || requested.length > 1) {
        const all = id === "all";
        const updating = action === "update";
        const removing = action === "remove";
        const verb = removing ? "卸载" : updating ? "更新" : "安装";
        const defaults = new Set<string>();
        const targets = all ? [...new Set(installedIds)].sort() : requested.filter(value => {
          const local = defaultFor(value);
          if (local && !installedIds.includes(local)) {defaults.add(local); return false;}
          return true;
        });
        if (all && (updating || removing) && !targets.length) {
          await ctx.telegram.edit(invocation.message, "没有已安装的扩展插件", htmlOptions); return;
        }
        await ctx.telegram.edit(invocation.message,
          renderFeedback({state: "working", title: !all ? `正在${removing ? "卸载" : "下载并构建"}所选扩展…` : removing ? "正在卸载全部已安装扩展…" : updating ? "正在下载并构建已安装扩展…" : "正在下载并构建全部可安装扩展…"}), htmlOptions);
        const excluded = new Set(host.listPlugins().map(plugin => plugin.id).filter(isPluginId));
        const result = removing ? {ids: installedIds, candidates: [...new Map(targets.map(value => {
          const resolved = resolvePluginId(value, installedIds);
          const candidate: Candidate = "error" in resolved ? {id: value, ...resolved} : {id: resolved.id};
          return [candidate.id, candidate] as const;
        })).values()]}
          : !all && !targets.length ? {ids: [], candidates: []}
          : updating || !all ? await repository(ctx, "build-selected", ...targets)
          : await repository(ctx, "build-all", ...excluded);
        if (!Array.isArray(result.ids) || !Array.isArray(result.candidates) ||
            result.ids.some(value => typeof value !== "string" || !isPluginId(value)) ||
            result.candidates.some(value => !value || typeof value.id !== "string" || !isPluginId(value.id))) {
          throw new Error("Invalid candidates");
        }
        if (all && updating && (result.candidates.length !== targets.length ||
            new Set(result.candidates.map(item => item.id)).size !== targets.length ||
            result.candidates.some(item => !targets.includes(item.id)))) throw new Error("Invalid update candidates");
        if (!all) {
          const expected = new Set(targets.map(value => {
            const resolved = resolvePluginId(value, result.ids!);
            return "error" in resolved ? value : resolved.id;
          }));
          if (result.candidates.length !== expected.size || new Set(result.candidates.map(item => item.id)).size !== expected.size ||
              result.candidates.some(item => !expected.has(item.id))) throw new Error("Invalid selected candidates");
        }
        stage(removing ? "unload" : "activate");
        const completedIds: string[] = [];
        const skipped = new Set(all && !updating && !removing ? result.ids.filter(value => excluded.has(value)) : defaults);
        const failed: {id: string; code: string}[] = [];
        for (const [index, candidate] of result.candidates.entries()) {
          ctx.signal.throwIfAborted();
          if (all && !updating && !removing && host.pluginState(candidate.id)) {skipped.add(candidate.id); continue;}
          let failure: string | undefined;
          if (candidate.error || !removing && !candidate.revision) {
            failure = candidate.error === "AMBIGUOUS" ? "AMBIGUOUS"
              : candidate.error === "NOT_FOUND" || candidate.error === "NOT_AVAILABLE" ? "NOT_AVAILABLE" : "BUILD";
          }
          else {
            try {
              if (removing) await releases.remove(candidate.id);
              else await releases.activate(candidate.id, candidate.revision!);
              completedIds.push(candidate.id);
            }
            catch (error) {ctx.signal.throwIfAborted(); failure = errorCode(error);}
          }
          if (failure) {
            failed.push({id: candidate.id, code: failure});
            ctx.log.error("tpm.batch_failed", {id: candidate.id, code: failure});
          }
          if ((index + 1) % 10 === 0) await ctx.telegram.edit(invocation.message, renderFeedback({
            state: "working", title: `正在${verb}扩展 ${index + 1}/${result.candidates.length}`,
            detail: `成功 ${completedIds.length} · 失败 ${failed.length}`,
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
          subtitle: `成功 ${completedIds.length} · 跳过 ${skipped.size} · 失败 ${failed.length}`,
          sections: [
            ...(failed.length ? [section(`${verb}失败`, failed.map(item => concat(code(item.id), text(` · ${item.code}`))))] : []),
            ...(completedIds.length ? [section(`已${verb} · ${completedIds.length}`, await compactList(completedIds))] : []),
            ...(skipped.size ? [section(`${all ? "已安装或默认模块" : "默认模块"} · ${skipped.size}`, await compactList([...skipped]))] : []),
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

  const formatAutoTime = (value: number): string => new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  const autoStatus = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const action = invocation.args[0]?.toLowerCase();
    if (invocation.args.length > 1 || action && action !== "on" && action !== "off") {
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}tpm auto [on|off]`);
      return;
    }
    if (action) {
      await autoStore(ctx).update(current => ({...current, schemaVersion: 1, enabled: action === "on",
        pending: pendingOf(current), processedTriggerIds: processedOf(current), notifications: notificationsOf(current),
      }));
    }
    const state = await autoStore(ctx).read();
    const last = state.lastResult;
    const result = last
      ? `已更新 ${last.updated.length} · 保持最新 ${last.unchanged.length} · 失败 ${last.failed.length + (last.failure ? 1 : 0)}`
      : "尚未运行";
    await ctx.telegram.edit(invocation.message,
      `<b>插件跟随更新：${state.enabled === true ? "开启" : "关闭"}</b>\n` +
      `待处理批次：${pendingOf(state).length}${busy === "automatic" ? "（正在执行）" : ""}\n` +
      `最近运行：${last ? formatAutoTime(last.completedAt) : "无"}\n最近结果：${result}`, htmlOptions);
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
        group: "⬇️ 安装插件", aliases: ["i"], args: "插件名 [插件名 ...]",
        alternates: [{args: "all", description: "安装仓库中全部可用扩展，跳过已加载插件和默认模块。"}],
        description: "安装并加载一个或多个指定扩展。对已安装的插件再次执行会更新它。",
        examples: [{args: "i nezha", description: "安装后用 <code>{prefix}help nezha</code> 查看配置和使用方法。"}, {args: "install aban acron aff", description: "一次安装多个插件，失败项单独列出。"}],
        handle: (invocation, ctx) => mutate(invocation, ctx, "install"),
      },
      update: {
        group: "🔄 更新插件", args: "插件名 [插件名 ...]",
        alternates: [{args: "all", description: "更新全部已安装扩展；需要补装仓库中的其他插件时，使用 install all。"}],
        description: "获取并加载一个或多个指定扩展的最新版本；目标尚未安装时会安装该扩展。",
        examples: [{args: "update nezha", description: "更新后继续使用原有配置。"}],
        handle: (invocation, ctx) => mutate(invocation, ctx, "update"),
      },
      auto: {
        group: "🔄 更新插件", args: "[on|off]",
        description: "查看或控制主程序更新成功后的插件跟随更新；仅处理当前已安装扩展。",
        arguments: [{name: "on|off", description: "省略时查看状态、最近运行时间和最近结果。"}],
        examples: [{args: "auto"}, {args: "auto on"}, {args: "auto off"}],
        handle: autoStatus,
      },
      remove: {
        group: "🗑️ 卸载插件", aliases: ["rm"], args: "插件名 [插件名 ...]",
        alternates: [{args: "all", description: "卸载全部已安装扩展，保留各插件配置数据；默认模块继续由程序管理。"}],
        description: "卸载一个或多个指定扩展，保留插件配置数据。",
        examples: [{args: "rm nezha", description: "重新安装后可继续使用保留的配置。"}],
        handle: (invocation, ctx) => mutate(invocation, ctx, "remove"),
      },
    },
    help: tpmHelpSections,
    handle: async (invocation, ctx) => {
      await ctx.telegram.edit(invocation.message,
        `${invocation.prefix}tpm search [关键词]\n${invocation.prefix}tpm install|remove|update 插件名 [插件名 ...]\n${invocation.prefix}tpm install|update|remove all\n${invocation.prefix}tpm auto [on|off]\n${invocation.prefix}tpm list`);
    },
  };

  const definition = definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "tpm",
    description: "安装、卸载和更新 V2 扩展插件",
    renderHelp: prefix => buildHelp(prefix),
    setup(ctx) { context = ctx; },
    cleanup() { context = undefined; },
    commands: {tpm: tpmCommand},
    jobs: {autoNotification: {
      cron: "* * * * *",
      description: "恢复 TPM 跟随更新任务并发送待处理结果",
      async handle(ctx) {
        ensureAutoTask(ctx);
        await deliverNotifications(ctx);
      },
    }},
  });
  return Object.freeze({...definition, followSuccessfulUpdate, async notifyReady(): Promise<void> {
    const ctx = context;
    if (!ctx || recoveryStarted) return;
    recoveryStarted = true;
    ensureAutoTask(ctx);
  }});
}
