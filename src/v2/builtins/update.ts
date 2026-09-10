import {bold} from "../ui/text";
import {brandText} from "../branding";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type CommandInvocation, type PluginContext} from "../sdk";
import {randomUUID} from "node:crypto";
import {readFile, unlink} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import path from "node:path";
import {isOwnerOrGroupSendAs} from "../permissions";
import type {ProcessError} from "../processes";
import {renderCommandHelp} from "../commands";

const htmlOptions = {parseMode: "html" as const, linkPreview: false} as const;

type Receipt = {ownerId: string; chatId: string; messageId: number; requestedAt: number; bootId: string};
type UpdateState = {pending: Receipt | null};
type UpdateResult = {status: "success" | "failed"; reason?: string | null};
type ServiceStatusRow = {key: string; value: string};
type ServiceStatusField = "LoadState" | "ActiveState" | "UnitFileState" | "SubState" | "CanStart" | "FragmentPath" | "Result";
const statusFields: readonly ServiceStatusField[] = [
  "LoadState",
  "ActiveState",
  "UnitFileState",
  "SubState",
  "CanStart",
  "FragmentPath",
  "Result",
];

export default function createUpdate(root = process.cwd(), ownerId?: string) {
  const bootId = randomUUID();
  let context: PluginContext | undefined;
  let submitted = false;
  const updateService = "mibot-update.service";
  const store = (ctx: PluginContext) => ctx.storage.json<UpdateState>("update-receipt.json", {pending: null});
  const resultFile = path.join(root, "temp", "update-result.json");
  const clear = (ctx: PluginContext, receipt: Receipt) => store(ctx).update(state =>
    state.pending?.bootId === receipt.bootId && state.pending.requestedAt === receipt.requestedAt
      ? {pending: null} : state);
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
  const reportFailure = async (ctx: PluginContext, receipt: Receipt, text: string): Promise<void> => {
    await ctx.telegram.edit({id: receipt.messageId, chatId: receipt.chatId, text: "", outgoing: true}, text, htmlOptions);
    await clear(ctx, receipt);
    try { await unlink(resultFile); } catch {}
  };
  const watchResult = (ctx: PluginContext, receipt: Receipt): void => {
    void ctx.tasks.run("update:result", async signal => {
      let pending = true;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        signal.throwIfAborted();
        try {
          const result = JSON.parse(await readFile(resultFile, "utf8")) as Partial<UpdateResult>;
      if (result.status === "failed") {
            const detail = formatUpdateResult(result);
            await reportFailure(ctx, receipt,
              brandText(`<b>MiBot 更新失败</b>\n更新任务未完成，服务保持当前版本。请稍后重试或查看服务器日志。${detail ? `\n原因：${escapeHtml(detail)}` : ""}`));
            return;
          }
          if (result.status === "success") { pending = false; await ctx.telegram.edit({id: receipt.messageId, chatId: receipt.chatId, text: "", outgoing: true},
            brandText("<b>MiBot 更新提交成功</b>\n更新服务已接收任务，服务重建中，请稍候执行 <code>.update</code> 查看结果。"), htmlOptions);
            return; }
        } catch {}
        await delay(1000, undefined, {signal});
      }
      if (pending && !signal.aborted) {
        pending = false;
        await reportFailure(ctx, receipt,
          brandText("<b>MiBot 更新失败</b>\n更新任务已提交但未返回结果，请稍候查看日志：\n<code>systemctl status mibot-update.service --no-pager</code>\n<code>journalctl -u mibot-update.service -n 80 --no-pager</code>\n任务可在稍后执行 <code>.update</code> 重试检查。"));
      }
    });
  };

  const authorizeOwner = async (invocation: CommandInvocation, ctx: PluginContext): Promise<boolean> => {
    if (isOwnerOrGroupSendAs(invocation.message, ownerId)) return true;
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
    const result = await ctx.processes.run("/usr/bin/git", ["-C", root, "fetch", "origin", "main"], {timeoutMs: 30000, maxOutputBytes: 4000});
    await ctx.telegram.edit(invocation.message,
      `<b>更新检查完成</b>\n<pre>${escapeHtml(result.stdout.toString("utf8").slice(0, 3000))}</pre>`, htmlOptions);
  };

  const runUpdate = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    if (!await rootCheck(invocation, ctx)) return;
    const receipt: Receipt = {ownerId: ownerId ?? "", chatId: invocation.message.chatId,
      messageId: invocation.message.id, requestedAt: Date.now(), bootId};
    const {pending} = await store(ctx).read();
    if (pending) {
      await ctx.telegram.edit(invocation.message,
        brandText("<b>MiBot 更新</b>\n已有更新任务进行中，请稍后查看结果或稍后重试。"), htmlOptions);
      return;
    }
    await ctx.telegram.edit(invocation.message, brandText("<b>MiBot 更新</b>\n正在更新主程序、检查依赖并重建运行时…"), htmlOptions);
    await store(ctx).update(() => ({pending: receipt}));
    try {
      const statusRows = await readServiceStatusRows(ctx);
      const status = statusRows.map(({key, value}) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join("<br>");
      const hint = serviceStatusHint(statusRows);
      if (hint) {
        submitted = false;
        await reportFailure(ctx, receipt,
          brandText(`<b>MiBot 更新失败</b>\n${hint}\n`) +
          `服务检查结果：${status}\n\n请先执行：<code>bash scripts/install-service.sh</code> 或确认服务文件是否存在。\n` +
          escapeHtml(processOwnerHint()));
        return;
      }
      if (statusRows.some(({key, value}) => key === "ActiveState" && value === "failed")) {
        await ctx.processes.run("/usr/bin/systemctl", ["reset-failed", updateService], {timeoutMs: 5000, maxOutputBytes: 2000});
      }
      await ctx.processes.run("/usr/bin/systemctl", ["daemon-reload"], {timeoutMs: 5000, maxOutputBytes: 2000});
      await ctx.processes.run("/usr/bin/systemctl", ["start", "--no-block", updateService],
        {timeoutMs: 5000, maxOutputBytes: 2000});
      const startupRows = await readServiceStatusRows(ctx, ["LoadState", "ActiveState", "Result", "SubState", "FragmentPath"]);
      const startupHint = serviceStartupFailureHint(startupRows);
      if (startupHint) {
        submitted = false;
        const failureStatus = startupRows.map(({key, value}) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join("<br>");
        await reportFailure(ctx, receipt,
          brandText(`<b>MiBot 更新失败</b>\n${startupHint}\n`) +
          `服务检查结果：${failureStatus}\n\n请查看服务日志：\n<code>journalctl -u ${updateService} -n 80 --no-pager</code>`);
        return;
      }
      submitted = true;
    } catch (error) {
      submitted = false;
      const logs = await readServiceLog(ctx);
      const status = await readServiceStatus(ctx);
      await reportFailure(ctx, receipt,
        brandText(`<b>MiBot 更新失败</b>\n启动更新任务失败：${escapeHtml(summarizeProcessError(error))}\n\n服务状态：${status}\n\n请检查服务文件与权限：\n<code>systemctl status ${updateService} --no-pager</code>\n<code>journalctl -u ${updateService} -n 80 --no-pager</code>\n<code>systemctl show ${updateService}</code>\n`) +
        `${escapeHtml(processOwnerHint())}${logs}`);
      return;
    }
    watchResult(ctx, receipt);
  };

  const updateCommand: CommandDefinition = {
    description: "查看版本与自动更新状态",
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
    if (!ctx || submitted) return;
    try {
      const {pending} = await store(ctx).read();
      if (!pending || pending.bootId === bootId) return;
      const age = Date.now() - pending.requestedAt;
      if (pending.ownerId !== ownerId || !/^-?[0-9]+$/.test(pending.chatId) ||
          !Number.isSafeInteger(pending.messageId) || pending.messageId <= 0 ||
          !Number.isFinite(age) || age < 0 || age > 10 * 60_000) {
        await clear(ctx, pending);
        return;
      }
      let status: "success" | "failed" | undefined;
      let reason: string | null = null;
      try {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          try {
            const result = JSON.parse(await readFile(resultFile, "utf8")) as Partial<UpdateResult>;
            if (result.status === "success" || result.status === "failed") {
              status = result.status;
              reason = typeof result.reason === "string" ? result.reason.trim() : null;
              break;
            }
          } catch {}
          await delay(1000);
        }
      } catch {}
      if (!status) {
        if (age > 1 * 60_000) {
          await ctx.telegram.edit({id: pending.messageId, chatId: pending.chatId, text: "", outgoing: true},
            brandText("<b>MiBot 更新</b>\n更新服务已启动但未产生日志结果，请检查：\n<code>systemctl status mibot-update.service --no-pager</code>\n<code>journalctl -u mibot-update.service -n 80 --no-pager</code>\n稍后可重试 <code>.update</code>。"), htmlOptions);
          await clear(ctx, pending);
          try { await unlink(resultFile); } catch {}
        }
        return;
      }
      if (status === "success" || status === "failed") {
        await ctx.telegram.edit({id: pending.messageId, chatId: pending.chatId, text: "", outgoing: true},
          status === "success"
            ? brandText("<b>MiBot 更新成功</b>\n主程序更新完成，服务已重启。")
            : brandText(`<b>MiBot 更新失败</b>\n服务保持当前版本。请查看 <code>.update check</code> 或服务器日志。${reason ? `\n原因：${escapeHtml(reason)}` : ""}`),
          htmlOptions);
        await clear(ctx, pending);
        try { await unlink(resultFile); } catch {}
      }
    } catch {
      if (!ctx.signal.aborted) ctx.log.error("update.receipt_failed");
    }
  }});
}
