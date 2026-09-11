import {bold} from "../ui/text";
import {brandText} from "../branding";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type CommandInvocation, type PluginContext} from "../sdk";
import {randomUUID} from "node:crypto";
import {mkdir, open, readFile, rename, unlink, writeFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import path from "node:path";
import {isOwnerOrGroupSendAs} from "../permissions";
import type {ProcessError} from "../processes";
import {renderCommandHelp} from "../commands";

const htmlOptions = {parseMode: "html" as const, linkPreview: false} as const;

type Receipt = {ownerId: string; chatId: string; messageId: number; requestedAt: number; bootId: string;
  requestId?: string};
type UpdateState = {pending: Receipt | null};
type UpdateResult = {status: "success" | "failed"; reason?: string | null; requestId?: string;
  previousVersion?: string; currentVersion?: string; previousRevision?: string; currentRevision?: string};
interface UpdateRuntimeOptions {pollIntervalMs?: number; resultTimeoutMs?: number; startupGraceMs?: number; now?: () => number;}
type ServiceStatusRow = {key: string; value: string};
type ServiceStatusField = "LoadState" | "ActiveState" | "UnitFileState" | "SubState" | "CanStart" | "FragmentPath" | "Result";
export interface ChangelogRelease {readonly version: string; readonly entries: readonly string[];}

const VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const REVISION_TOKEN = /^[0-9a-f]{7,64}$/i;
const CHANGELOG_REF = "https://github.com/MiCat-S/Mi-Box/blob/main/CHANGELOG.md";
const UPDATE_NOTES_HTML_BUDGET = 2400;

/** Select releases in changelog order, from the installed target back to but excluding the previous version. */
export function selectChangelogReleases(
  markdown: string,
  previousVersion: string | undefined,
  currentVersion: string | undefined,
): readonly ChangelogRelease[] {
  if (!currentVersion || previousVersion === currentVersion) return [];
  const releases: {version: string; entries: string[]}[] = [];
  let release: {version: string; entries: string[]} | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+\[([^\]\r\n]+)\](?:\s|$)/.exec(line);
    if (heading) {
      release = {version: heading[1].trim(), entries: []};
      releases.push(release);
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(line);
    if (release && bullet) release.entries.push(bullet[1].trim());
  }
  const currentIndex = releases.findIndex(item => item.version === currentVersion);
  if (currentIndex < 0) return [];
  const previousIndex = previousVersion === undefined
    ? -1
    : releases.findIndex(item => item.version === previousVersion);
  const end = previousIndex > currentIndex ? previousIndex : currentIndex + 1;
  return releases.slice(currentIndex, end).map(item => Object.freeze({
    version: item.version,
    entries: Object.freeze([...item.entries]),
  }));
}
const statusFields: readonly ServiceStatusField[] = [
  "LoadState",
  "ActiveState",
  "UnitFileState",
  "SubState",
  "CanStart",
  "FragmentPath",
  "Result",
];

export default function createUpdate(root = process.cwd(), ownerId?: string, options: UpdateRuntimeOptions = {}) {
  const bootId = randomUUID();
  let context: PluginContext | undefined;
  let recoveryStarted = false;
  let stateOperation: Promise<void> = Promise.resolve();
  const updateService = "mibot-update.service";
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const resultTimeoutMs = options.resultTimeoutMs ?? 10 * 60_000;
  const startupGraceMs = options.startupGraceMs ?? 5000;
  // Legacy 0.7.1 results have no request ID, so use their file time to reject pre-existing output.
  const legacyResultClockToleranceMs = 1000;
  const now = options.now ?? Date.now;
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = stateOperation.then(operation, operation);
    stateOperation = result.then(() => undefined, () => undefined);
    return result;
  };
  const store = (ctx: PluginContext) => ctx.storage.json<UpdateState>("update-receipt.json", {pending: null});
  const resultFile = path.join(root, "temp", "update-result.json");
  const requestFile = path.join(root, "temp", "update-request.json");
  const sameReceipt = (current: Receipt | null, expected: Receipt): boolean => !!current &&
    (expected.requestId !== undefined
      ? current.requestId === expected.requestId
      : current.requestId === undefined && current.bootId === expected.bootId && current.requestedAt === expected.requestedAt);
  const clear = (ctx: PluginContext, receipt: Receipt) => store(ctx).update(state =>
    sameReceipt(state.pending, receipt) ? {pending: null} : state);
  const readServiceStatusRows = async (ctx: PluginContext, fields = statusFields): Promise<ServiceStatusRow[]> => {
    const rows: ServiceStatusRow[] = [];
    for (const field of fields) {
      try {
        const value = await ctx.processes.run("/usr/bin/systemctl",
          ["show", "--value", `-p`, field, updateService],
          {timeoutMs: 1500, maxOutputBytes: 600});
        const text = value.stdout.toString("utf8").trim() || "unknown";
        rows.push({key: field, value: text});
      } catch {
        rows.push({key: field, value: "unavailable"});
      }
    }
    return rows;
  };
  const readServiceStatus = async (ctx: PluginContext): Promise<string> =>
    (await readServiceStatusRows(ctx)).map(({key, value}) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join("<br>");
  const parseServiceStatusMap = (statusRows: readonly ServiceStatusRow[]): Record<string, string> =>
    Object.fromEntries(statusRows.map(item => [item.key, item.value]));
  const serviceStatusHint = (statusRows: readonly ServiceStatusRow[]): string => {
    const statusMap = parseServiceStatusMap(statusRows);
    if (statusMap.CanStart === "no") {
      return "更新服务当前不可启动（CanStart=no），通常表示当前运行上下文没有 systemd 管理权限。";
    }
    if (statusMap.LoadState !== "loaded") {
      return "更新服务未正确加载，请先执行 <code>bash scripts/install-service.sh</code> 安装/修复系统服务。";
    }
    if (statusMap.FragmentPath === "unavailable" || !statusMap.FragmentPath) {
      return "未检测到更新服务文件路径，请检查 `/etc/systemd/system/mibot-update.service` 是否存在。";
    }
    if (statusMap.ActiveState === "unavailable" || statusMap.ActiveState === "unknown") {
      return "无法确认更新服务是否正在执行，请检查 systemd 状态后重试。";
    }
    return "";
  };
  const serviceStartupFailureHint = (statusRows: readonly ServiceStatusRow[]): string => {
    const statusMap = parseServiceStatusMap(statusRows);
    if (statusMap.ActiveState === "failed") return "更新服务已启动后立即进入失败状态。";
    if (statusMap.ActiveState === "inactive" && statusMap.Result && !["", "success", "done", "skipped"].includes(statusMap.Result)) {
      return `更新服务启动后立即退出（Result=${escapeHtml(statusMap.Result)}）。`;
    }
    return "";
  };
  const summarizeProcessError = (error: unknown): string => {
    if (error instanceof Error && (error as ProcessError).code) {
      const processError = error as ProcessError;
      const output = Buffer.concat([processError.stdout || Buffer.alloc(0), processError.stderr || Buffer.alloc(0)])
        .toString("utf8").trim();
      const tail = output ? `\n${output.slice(0, 1200)}` : "";
      return `${processError.message}${tail ? `\n${tail}` : ""}`;
    }
    return "请查看服务日志并检查权限与安装状态。";
  };
  const escapeHtml = (value: string): string => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const validVersion = (value: unknown): string | undefined =>
    typeof value === "string" && VERSION_TOKEN.test(value) ? value : undefined;
  const validRevision = (value: unknown): string | undefined =>
    typeof value === "string" && REVISION_TOKEN.test(value) ? value : undefined;
  const versionFromJson = (content: string): string | undefined => {
    try { return validVersion((JSON.parse(content) as {version?: unknown}).version); }
    catch { return undefined; }
  };
  const readInstalledVersion = async (): Promise<string | undefined> => {
    try { return versionFromJson(await readFile(path.join(root, "package.json"), "utf8")); }
    catch { return undefined; }
  };
  const gitText = async (ctx: PluginContext, args: readonly string[], maxOutputBytes = 4096): Promise<string> => {
    const result = await ctx.processes.run("/usr/bin/git", ["-C", root, ...args], {timeoutMs: 30_000, maxOutputBytes});
    return result.stdout.toString("utf8").trim();
  };
  const versionAt = async (ctx: PluginContext, revision: string): Promise<string | undefined> => {
    try { return versionFromJson(await gitText(ctx, ["show", `${revision}:package.json`])); }
    catch { return undefined; }
  };
  const renderReleaseNotes = (releases: readonly ChangelogRelease[]): string => {
    if (!releases.some(release => release.entries.length)) return "";
    const footer = `<a href="${CHANGELOG_REF}">查看完整更新记录</a>`;
    const lines = ["<b>更新内容</b>"];
    let omitted = false;
    outer: for (const release of releases) {
      if (!release.entries.length) continue;
      const heading = `<b>${escapeHtml(release.version)}</b>`;
      if ([...lines, heading, footer].join("\n").length > UPDATE_NOTES_HTML_BUDGET) {
        omitted = true;
        break;
      }
      lines.push(heading);
      for (const entry of release.entries) {
        const characters = [...entry];
        const shortened = characters.length > 300 ? `${characters.slice(0, 300).join("")}…` : entry;
        const bullet = `• ${escapeHtml(shortened)}`;
        if ([...lines, bullet, footer].join("\n").length > UPDATE_NOTES_HTML_BUDGET) {
          omitted = true;
          break outer;
        }
        lines.push(bullet);
      }
    }
    if (omitted && [...lines, "• …", footer].join("\n").length <= UPDATE_NOTES_HTML_BUDGET) lines.push("• …");
    lines.push(footer);
    return lines.join("\n");
  };
  const successfulUpdateDetails = async (ctx: PluginContext, result: Partial<UpdateResult>): Promise<string> => {
    const currentVersion = validVersion(result.currentVersion) ?? await readInstalledVersion();
    const previousVersion = validVersion(result.previousVersion) ?? await versionAt(ctx, "ORIG_HEAD");
    const previousRevision = validRevision(result.previousRevision);
    const currentRevision = validRevision(result.currentRevision);
    if (previousRevision && currentRevision && previousRevision === currentRevision) {
      return `当前已是最新版本，本次没有代码变更。${currentVersion
        ? `\n版本：<code>${escapeHtml(currentVersion)}</code>` : ""}`;
    }

    const lines: string[] = [];
    if (previousVersion && currentVersion && previousVersion !== currentVersion) {
      lines.push(`版本：<code>${escapeHtml(previousVersion)}</code> → <code>${escapeHtml(currentVersion)}</code>`);
    } else if (currentVersion) {
      lines.push(`版本：<code>${escapeHtml(currentVersion)}</code>`);
    }
    if (previousRevision && currentRevision && previousRevision !== currentRevision &&
        (!previousVersion || !currentVersion || previousVersion === currentVersion)) {
      lines.push(`提交：<code>${previousRevision.slice(0, 12)}</code> → <code>${currentRevision.slice(0, 12)}</code>`);
    }
    let notes = "";
    if (currentVersion && previousVersion !== currentVersion) {
      try {
        const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
        notes = renderReleaseNotes(selectChangelogReleases(changelog, previousVersion, currentVersion));
      } catch {}
    }
    if (notes) lines.push(notes);
    return lines.join("\n\n");
  };
  const processOwnerHint = (): string => {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : NaN;
      if (Number.isNaN(uid)) return "运行环境未提供当前用户标识。";
      return uid === 0 ? "当前运行在 root 用户。"
        : `当前运行用户 UID=${uid}，通常需要 root 或有 systemd 管理权限才可启动更新服务。`;
    } catch {
      return "未能读取运行时用户信息。";
    }
  };
  const formatUpdateResult = (result: Partial<UpdateResult>): string | null => {
    if (result.status !== "failed") return null;
    const reason = typeof result.reason === "string" ? result.reason.trim() : "";
    if (reason) return reason;
    return "更新服务返回失败但未附带详情";
  };
  const readServiceLog = async (ctx: PluginContext): Promise<string> => {
    try {
      const logResult = await ctx.processes.run("/usr/bin/journalctl", ["-u", updateService, "-n", "80", "--no-pager"], {
        timeoutMs: 4000,
        maxOutputBytes: 4000,
      });
      const text = logResult.stdout.toString("utf8").trim();
      return text ? `\n<pre>${escapeHtml(text)}</pre>` : "";
    } catch {
      return "";
    }
  };
  const validReceipt = (receipt: Receipt): boolean => {
    const age = now() - receipt.requestedAt;
    return receipt.ownerId === ownerId && /^-?[0-9]+$/.test(receipt.chatId) &&
      Number.isSafeInteger(receipt.messageId) && receipt.messageId > 0 && Number.isFinite(age) && age >= 0 &&
      (receipt.requestId === undefined || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(receipt.requestId));
  };
  const resultMatches = (receipt: Receipt, result: Partial<UpdateResult>, modifiedAt: number): boolean =>
    receipt.requestId === undefined
      ? result.requestId === undefined && modifiedAt >= receipt.requestedAt - legacyResultClockToleranceMs
      : result.requestId === receipt.requestId;
  const readMatchingResult = async (receipt: Receipt): Promise<Partial<UpdateResult> | undefined> => {
    try {
      const handle = await open(resultFile, "r");
      try {
        const metadata = await handle.stat();
        const result = JSON.parse(await handle.readFile("utf8")) as Partial<UpdateResult>;
        if ((result.status === "success" || result.status === "failed") && resultMatches(receipt, result, metadata.mtimeMs)) return result;
      } finally {
        await handle.close();
      }
    } catch {}
  };
  const editReceipt = (ctx: PluginContext, receipt: Receipt, text: string) =>
    ctx.telegram.edit({id: receipt.messageId, chatId: receipt.chatId, text: "", outgoing: true}, text, htmlOptions);
  const finalizeReceipt = async (ctx: PluginContext, receipt: Receipt, text: string): Promise<boolean> => {
    if (!sameReceipt((await store(ctx).read()).pending, receipt)) return false;
    try {
      await editReceipt(ctx, receipt, text);
    } catch {
      if (!ctx.signal.aborted) ctx.log.error("update.receipt_notification_failed");
    } finally {
      await clear(ctx, receipt);
    }
    return true;
  };
  const missingResultText = () => brandText(
    "<b>MiBot 更新失败</b>\n更新任务已结束但未返回对应结果，请查看日志：\n" +
    "<code>systemctl status mibot-update.service --no-pager</code>\n" +
    "<code>journalctl -u mibot-update.service -n 80 --no-pager</code>\n稍后可重新执行 <code>.update</code>。",
  );
  const unknownResultText = () => brandText(
    "<b>MiBot 更新</b>\n更新任务未返回对应结果，且无法确认更新服务状态。已释放本次回执；请先检查：\n" +
    "<code>systemctl status mibot-update.service --no-pager</code>\n" +
    "<code>journalctl -u mibot-update.service -n 80 --no-pager</code>",
  );
  const finalText = async (ctx: PluginContext, result: Partial<UpdateResult>): Promise<string> => {
    if (result.status === "success") {
      const details = await successfulUpdateDetails(ctx, result);
      return brandText("<b>MiBot 更新成功</b>\n主程序更新完成，服务已重启。") + (details ? `\n\n${details}` : "");
    }
    const detail = formatUpdateResult(result);
    return brandText(`<b>MiBot 更新失败</b>\n更新未完成，请查看 <code>.update check</code> 或服务器日志。${
      detail ? `\n原因：${escapeHtml(detail)}` : ""}`);
  };
  const serviceState = async (ctx: PluginContext): Promise<string> => {
    const [row] = await readServiceStatusRows(ctx, ["ActiveState"]);
    return row?.value ?? "unavailable";
  };
  const serviceBusy = (state: string): boolean => ["active", "activating", "reloading", "deactivating"].includes(state);
  const serviceEnded = (state: string): boolean => ["inactive", "failed"].includes(state);

  const observeReceipt = async (ctx: PluginContext, receipt: Receipt, mode: "current" | "recovery", signal: AbortSignal): Promise<void> => {
    const startedAt = now();
    const deadline = receipt.requestedAt + resultTimeoutMs;
    while (true) {
      signal.throwIfAborted();
      const owned = await exclusive(async () => sameReceipt((await store(ctx).read()).pending, receipt));
      if (!owned) return;
      const result = await readMatchingResult(receipt);
      if (result?.status === "failed") {
        const text = await finalText(ctx, result);
        await exclusive(() => finalizeReceipt(ctx, receipt, text));
        return;
      }
      if (result?.status === "success") {
        if (mode === "recovery") {
          const text = await finalText(ctx, result);
          await exclusive(() => finalizeReceipt(ctx, receipt, text));
        }
        else {
          // Success is written after mibot.service restarts; the next boot owns final notification and clearing.
          try {
            await editReceipt(ctx, receipt, brandText(
              "<b>MiBot 更新提交成功</b>\n更新服务已接收任务，服务重建中，请稍候执行 <code>.update</code> 查看结果。"));
          } catch {
            if (!ctx.signal.aborted) ctx.log.error("update.receipt_notification_failed");
          }
        }
        return;
      }
      const active = await serviceState(ctx);
      if (serviceEnded(active) && (mode === "recovery" || now() - startedAt >= startupGraceMs)) {
        await exclusive(() => finalizeReceipt(ctx, receipt, missingResultText()));
        return;
      }
      if (!serviceBusy(active) && now() >= deadline) {
        await exclusive(() => finalizeReceipt(ctx, receipt, unknownResultText()));
        return;
      }
      await delay(pollIntervalMs, undefined, {signal});
    }
  };
  const startObserver = (ctx: PluginContext, receipt: Receipt, mode: "current" | "recovery"): void => {
    const watching = ctx.tasks.run(mode === "current" ? "update:result" : "update:recovery",
      signal => observeReceipt(ctx, receipt, mode, signal));
    void watching.catch(() => { if (!ctx.signal.aborted) ctx.log.error("update.receipt_failed"); });
  };
  const startRecovery = (ctx: PluginContext): void => {
    const watching = ctx.tasks.run("update:recovery", async signal => {
      const pending = await exclusive(async () => (await store(ctx).read()).pending);
      if (!pending || pending.bootId === bootId) return;
      if (!validReceipt(pending)) {
        await exclusive(async () => { await clear(ctx, pending); });
        return;
      }
      await observeReceipt(ctx, pending, "recovery", signal);
    });
    void watching.catch(() => { if (!ctx.signal.aborted) ctx.log.error("update.receipt_failed"); });
  };
  const writeRequest = async (receipt: Receipt): Promise<void> => {
    await mkdir(path.dirname(requestFile), {recursive: true});
    const temporary = `${requestFile}.${receipt.requestId}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({requestId: receipt.requestId}), {encoding: "utf8", mode: 0o600});
      await rename(temporary, requestFile);
    } catch (error) {
      try { await unlink(temporary); } catch {}
      throw error;
    }
  };

  const authorizeOwner = async (invocation: CommandInvocation, ctx: PluginContext): Promise<boolean> => {
    if (!invocation.message.forwarded && isOwnerOrGroupSendAs(invocation.message, ownerId)) return true;
    await ctx.telegram.edit(invocation.message, brandText("只有账号所有者可以更新 MiBot", false));
    return false;
  };

  const showVersion = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    let version = "未知";
    try { version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version ?? version; } catch {}
    await ctx.telegram.edit(invocation.message, `<b>更新状态</b>\n当前版本：<code>${escapeHtml(String(version))}</code>`, htmlOptions);
  };

  const autoSwitch = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const store = ctx.storage.json<{enabled: boolean}>("config.json", {enabled: false});
    const action = invocation.args[0]?.toLowerCase();
    if (action === "on" || action === "off") {
      await store.update(value => ({...value, enabled: action === "on"}));
    }
    const current = await store.read();
    await ctx.telegram.edit(invocation.message,
      `自动更新：<b>${current.enabled ? "开启" : "关闭"}</b>\n当前仅保存开关状态，不会在后台自动执行`, htmlOptions);
  };

  const rootCheck = async (invocation: CommandInvocation, ctx: PluginContext): Promise<boolean> => {
    const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (runningAsRoot) return true;
    await ctx.telegram.edit(invocation.message,
      brandText(`<b>MiBot 更新失败</b>\n当前进程 UID=${escapeHtml(String(typeof process.getuid === "function" ? process.getuid() : "unknown"))}，`) +
      brandText("无法直接发起 systemd 服务更新。请让 MiBot 服务以 root 运行后再试（安装脚本会处理 service）。"), htmlOptions);
    return false;
  };

  const checkUpdate = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    if (!await rootCheck(invocation, ctx)) return;
    try {
      await gitText(ctx, ["fetch", "origin", "main"]);
      const counts = await gitText(ctx, ["rev-list", "--left-right", "--count", "HEAD...refs/remotes/origin/main"], 256);
      const match = /^(\d+)\s+(\d+)$/.exec(counts);
      if (!match) throw new Error("Unexpected Git comparison output");
      const ahead = Number(match[1]);
      const behind = Number(match[2]);
      const currentVersion = await readInstalledVersion();
      if (ahead > 0) {
        const state = behind > 0
          ? `本地与远端分支已分叉（本地 ${ahead} 个、远端 ${behind} 个提交）。`
          : `本地分支包含 ${ahead} 个尚未推送的提交。`;
        await ctx.telegram.edit(invocation.message,
          `<b>更新检查完成</b>\n${state}\n当前无法执行快速更新，请先整理部署分支。`, htmlOptions);
        return;
      }
      if (behind === 0) {
        await ctx.telegram.edit(invocation.message,
          `<b>更新检查完成</b>\n当前版本：<code>${escapeHtml(currentVersion ?? "未知")}</code>\n状态：当前已是最新版本。`,
        htmlOptions);
        return;
      }
      const remoteVersion = await versionAt(ctx, "refs/remotes/origin/main");
      let notes = "";
      if (remoteVersion && currentVersion !== remoteVersion) {
        try {
          const changelog = await gitText(ctx, ["show", "refs/remotes/origin/main:CHANGELOG.md"], 256 * 1024);
          notes = renderReleaseNotes(selectChangelogReleases(changelog, currentVersion, remoteVersion));
        } catch {}
      }
      const version = currentVersion && remoteVersion && currentVersion !== remoteVersion
        ? `可更新：<code>${escapeHtml(currentVersion)}</code> → <code>${escapeHtml(remoteVersion)}</code>`
        : `远端有 ${behind} 个待更新提交${currentVersion ? `；当前版本：<code>${escapeHtml(currentVersion)}</code>` : ""}`;
      await ctx.telegram.edit(invocation.message,
        `<b>发现主程序更新</b>\n${version}\n待更新提交：${behind}${notes ? `\n\n${notes}` : ""}`, htmlOptions);
    } catch (error) {
      ctx.log.error("update.check_failed", {kind: error instanceof Error ? error.name : "unknown"});
      await ctx.telegram.edit(invocation.message,
        brandText("<b>MiBot 更新检查失败</b>\n无法读取远端版本信息，请确认网络和 Git 仓库状态后重试。"), htmlOptions);
    }
  };

  const runUpdate = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    if (!await rootCheck(invocation, ctx)) return;
    await exclusive(async () => {
    ctx.signal.throwIfAborted();
    const receipt: Receipt = {ownerId: ownerId ?? "", chatId: invocation.message.chatId,
      messageId: invocation.message.id, requestedAt: now(), bootId, requestId: randomUUID()};
    const statusRows = await readServiceStatusRows(ctx);
    const status = statusRows.map(({key, value}) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join("<br>");
    const hint = serviceStatusHint(statusRows);
    if (hint) {
      await ctx.telegram.edit(invocation.message,
        brandText(`<b>MiBot 更新失败</b>\n${hint}\n`) +
        `服务检查结果：${status}\n\n请先执行：<code>bash scripts/install-service.sh</code> 或确认服务文件是否存在。\n` +
        escapeHtml(processOwnerHint()), htmlOptions);
      return;
    }
    const activeState = parseServiceStatusMap(statusRows).ActiveState ?? "unavailable";
    if (serviceBusy(activeState)) {
      await ctx.telegram.edit(invocation.message,
        brandText("<b>MiBot 更新</b>\n已有更新任务进行中，请稍后查看结果或稍后重试。"), htmlOptions);
      return;
    }
    if (!serviceEnded(activeState)) {
      await ctx.telegram.edit(invocation.message,
        brandText("<b>MiBot 更新</b>\n无法确认更新服务已结束，请检查 systemd 状态后重试。"), htmlOptions);
      return;
    }
    const existing = (await store(ctx).read()).pending;
    if (existing && validReceipt(existing)) {
      const result = await readMatchingResult(existing);
      if (result) await finalizeReceipt(ctx, existing, await finalText(ctx, result));
      else if (serviceEnded(activeState)) await finalizeReceipt(ctx, existing, missingResultText());
    } else if (existing) {
      await clear(ctx, existing);
    }
    let acquired = false;
    await store(ctx).update(state => {
      if (state.pending) return state;
      acquired = true;
      return {pending: receipt};
    });
    if (!acquired) {
      await ctx.telegram.edit(invocation.message,
        brandText("<b>MiBot 更新</b>\n已有更新任务进行中，请稍后查看结果或稍后重试。"), htmlOptions);
      return;
    }
    try {
      await ctx.telegram.edit(invocation.message,
        brandText("<b>MiBot 更新</b>\n正在更新主程序、检查依赖并重建运行时…"), htmlOptions);
      await writeRequest(receipt);
      if (statusRows.some(({key, value}) => key === "ActiveState" && value === "failed")) {
        await ctx.processes.run("/usr/bin/systemctl", ["reset-failed", updateService], {timeoutMs: 5000, maxOutputBytes: 2000});
      }
      await ctx.processes.run("/usr/bin/systemctl", ["daemon-reload"], {timeoutMs: 5000, maxOutputBytes: 2000});
      await ctx.processes.run("/usr/bin/systemctl", ["start", "--no-block", updateService],
        {timeoutMs: 5000, maxOutputBytes: 2000});
      const startupRows = await readServiceStatusRows(ctx, ["LoadState", "ActiveState", "Result", "SubState", "FragmentPath"]);
      const startupHint = serviceStartupFailureHint(startupRows);
      if (startupHint) {
        const failureStatus = startupRows.map(({key, value}) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join("<br>");
        await finalizeReceipt(ctx, receipt,
          brandText(`<b>MiBot 更新失败</b>\n${startupHint}\n`) +
          `服务检查结果：${failureStatus}\n\n请查看服务日志：\n<code>journalctl -u ${updateService} -n 80 --no-pager</code>`);
        return;
      }
    } catch (error) {
      const logs = await readServiceLog(ctx);
      const status = await readServiceStatus(ctx);
      await finalizeReceipt(ctx, receipt,
        brandText(`<b>MiBot 更新失败</b>\n启动更新任务失败：${escapeHtml(summarizeProcessError(error))}\n\n服务状态：${status}\n\n请检查服务文件与权限：\n<code>systemctl status ${updateService} --no-pager</code>\n<code>journalctl -u ${updateService} -n 80 --no-pager</code>\n<code>systemctl show ${updateService}</code>\n`) +
        `${escapeHtml(processOwnerHint())}${logs}`);
      return;
    }
    startObserver(ctx, receipt, "current");
    });
  };

  const updateCommand: CommandDefinition = {
    description: "查看版本与自动更新状态",
    direction: "outgoing",
    includeSaved: true,
    ignoreForwarded: true,
    helpArgs: ["help", "h"],
    defaultSubcommand: "run",
    subcommands: {
      ver: {
        aliases: ["version"], group: "命令：",
        description: "查看当前版本",
        args: "",
        examples: [{args: "ver"}],
        handle: showVersion,
      },
      auto: {
        group: "命令：",
        description: "查看或保存自动更新开关；当前版本的后台行为仅为保存配置",
        args: "[on|off]",
        arguments: [{name: "on|off", description: "省略时只查看；填写 on/off 时保存开关状态"}],
        examples: [{args: "auto"}, {args: "auto on"}, {args: "auto off"}],
        handle: autoSwitch,
      },
      check: {
        group: "命令：",
        description: "获取 origin/main 的最新 Git 信息，当前运行版本保持不变",
        args: "",
        authorize: authorizeOwner,
        examples: [{args: "check"}],
        handle: checkUpdate,
      },
      run: {
        aliases: ["now"], group: "命令：",
        description: "立即启动主程序更新",
        args: "",
        authorize: authorizeOwner,
        examples: [{args: "run"}, {args: ""}],
        handle: runUpdate,
      },
    },
    help: [
      {
        heading: "使用示例：",
        body: "1. <code>{prefix}update ver</code> 查看版本\n2. <code>{prefix}update check</code> 获取远端更新信息\n3. <code>{prefix}update run</code> 启动更新，等待完成回执",
      },
      {
        heading: "运行条件与结果：",
        body: "• 检查和执行更新由账号本人操作，支持本账号在群内以频道身份发出的新命令。\n" +
          "• 需要 Linux、systemd、root 身份运行的主程序，以及已安装的更新服务。\n" +
          "• 更新任务会检查依赖并重建运行时，成功后重启服务；短暂断开连接属于重启过程。\n" +
          "• 同时只能执行一个更新任务；遇到“已有更新任务”时等待回执。\n" +
          "• 自动更新开关目前不会触发后台更新；手动更新使用 run。",
      },
      {
        heading: "常见问题：",
        body: "• 权限或服务检查失败：按回执中的服务名、日志命令排查。\n" +
          "• 仅查看当前版本时可使用 <code>{prefix}version</code>。\n" +
          "• 扩展插件通过 <code>{prefix}tpm update 插件名</code> 或 <code>{prefix}tpm update all</code> 更新。\n" +
          "• <code>{prefix}update help</code> / <code>{prefix}help update</code> 查看本说明。",
      },
    ],
    async handle(invocation, ctx) {
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}update ver|check|run|auto`);
    },
  };

  const definition = definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "update",
    description: "检查并更新程序",
    renderHelp: prefix => renderCommandHelp("update", updateCommand, {
      prefix,
      title: bold("🔄 程序更新"),
      intro: "检查版本、拉取远端信息，或启动主程序更新服务。",
      footer: [],
    }),
    setup(ctx) { context = ctx; },
    cleanup() { context = undefined; },
    commands: {update: updateCommand},
  });
  return Object.freeze({...definition, async notifyReady(): Promise<void> {
    const ctx = context;
    if (!ctx || recoveryStarted) return;
    recoveryStarted = true;
    startRecovery(ctx);
  }});
}
