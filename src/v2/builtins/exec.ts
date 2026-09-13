import {bold, text} from "../ui/text";
import {deliverPages, deliveryErrorCategory, interruptedNotice, PAGE_LABEL_RESERVE, pageLabel,
  renderDocument, section} from "../ui/document";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";
import {existsSync} from "node:fs";
import path from "node:path";
import {isOwnerOrGroupSendAs} from "../permissions";
import {renderCommandHelp} from "../commands";
import {ProcessError} from "../processes";

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function legacyArguments(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const char of command) {
    if ((char === "'" || char === '"') && quote === undefined) quote = char;
    else if (char === quote) quote = undefined;
    else if (char === " " && quote === undefined) {
      if (current) tokens.push(current);
      current = "";
    } else current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function rawText(message: {text: string; raw?: unknown}): string {
  const raw = message.raw;
  return raw && typeof raw === "object" && typeof (raw as {message?: unknown}).message === "string"
    ? (raw as {message: string}).message : message.text;
}

function commandText(invocation: {message: {text: string; raw?: unknown}; prefix: string; command: string}): string {
  const canonicalBody = invocation.message.text.slice(invocation.prefix.length).trimStart();
  const canonical = canonicalBody.slice(invocation.command.length).trimStart();
  const originalBody = rawText(invocation.message).slice(invocation.prefix.length).trimStart();
  for (let index = 0; index < originalBody.length; index++) {
    if (index > 0 && !/\s/u.test(originalBody[index - 1])) continue;
    const suffix = originalBody.slice(index).trimStart();
    const normalized = suffix.replace(/\s+/gu, " ").trim();
    if (!normalized || canonical !== normalized && !canonical.endsWith(` ${normalized}`)) continue;
    const injected = canonical.slice(0, canonical.length - normalized.length).trimEnd();
    return injected ? `${injected} ${suffix}` : suffix;
  }
  return canonical;
}

function capturedOutput(error: unknown): {stdout: string; stderr: string; exitCode: number | null; code?: string} {
  if (!(error instanceof ProcessError)) return {stdout: "", stderr: "", exitCode: null};
  return {
    stdout: error.stdout.toString("utf8"),
    stderr: error.stderr.toString("utf8"),
    exitCode: error.exitCode,
    code: error.code,
  };
}

function boundedSource(source: string, budget = 2_000): string {
  let result = "";
  for (const character of source) {
    const escaped = escape(character);
    if (result.length + escaped.length > budget) return result + "…";
    result += escaped;
  }
  return result;
}

async function resultPages(
  title: string, source: string, stdout: string, stderr: string, exitCode?: number | null,
): Promise<readonly string[]> {
  const sections = [section("输出：", [text(stdout || "(无输出)")])];
  if (stderr) sections.push(section("错误：", [text(stderr)]));
  const pages = await renderDocument({
    title,
    subtitle: `命令：${source}${exitCode === null || exitCode === undefined ? "" : `\n退出码：${exitCode}`}`,
    sections,
  }, PAGE_LABEL_RESERVE);
  return pages.map((page, index) => page + pageLabel(index, pages.length));
}

function command(ownerId?: string): CommandDefinition {
  return {
  description: "执行一个非 shell 系统命令",
  helpArgs: ["help", "h"],
  helpOnEmpty: true,
  args: "程序 [参数...]",
  arguments: [
    {name: "程序", required: true, description: "绝对路径，或 /usr/bin、/bin、/usr/sbin、/sbin 中的名称"},
    {name: "参数...", description: "直接传给程序的参数；不经过 shell 解释"},
  ],
  examples: [
    {args: "uptime", description: "查看运行时间和负载"},
    {args: "df -h", description: "查看磁盘空间"},
    {args: "/usr/bin/uname -a", description: "查看系统信息"},
  ],
  help: [
    {
      heading: "执行规则：",
      body: "• 由账号本人操作，支持本账号在群内以频道身份发出的新命令。\n" +
        "• 参数直接传给程序。Shell 的管道、重定向、通配符和变量展开语法不会自动解释。\n" +
        "• 程序路径最多 160 字符，允许字母、数字、下划线、点、斜杠、冒号和连字符。\n" +
        "• 单次执行限时 15 秒；输出收集上限 12000 字节，完整结果按 3500 字符的消息上限分页展示。\n" +
        "• 命令作用于主程序所在主机，结果发到当前对话。",
    },
    {
      heading: "常见提示：",
      body: "• “找不到该系统命令”：检查名称，或指定已安装程序的绝对路径。\n" +
        "• “执行失败、超时或输出过大”：检查程序参数，并缩小命令输出范围。",
    },
  ],
  async handle(invocation, ctx) {
    if (!isOwnerOrGroupSendAs(invocation.message, ownerId)) {
      await ctx.telegram.edit(invocation.message, "没有执行系统命令的权限");
      return;
    }
    const source = commandText(invocation);
    const [file, ...args] = legacyArguments(source);
    if (!file) {
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}exec 命令 参数...`);
      return;
    }
    if (!/^[A-Za-z0-9_./:-]+$/.test(file) || file.length > 160) {
      await ctx.telegram.edit(invocation.message, "命令路径包含不允许的字符");
      return;
    }
    const executable = path.isAbsolute(file) ? file :
      ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(dir => path.join(dir, file)).find(existsSync);
    if (!executable) {
      await ctx.telegram.edit(invocation.message, "找不到该系统命令");
      return;
    }
    const started = Date.now();
    const progress = (seconds: number) =>
      `✅ 已开始执行命令…\n命令：<code>${boundedSource(source)}</code>\n状态：运行中 ${seconds}s`;
    await ctx.telegram.edit(invocation.message, progress(0), {parseMode: "html"});
    let stopped = false;
    let statusUpdate: Promise<void> | undefined;
    const interval = setInterval(() => {
      if (stopped || statusUpdate) return;
      statusUpdate = ctx.telegram.edit(invocation.message,
        progress(Math.round((Date.now() - started) / 1_000)), {parseMode: "html"})
        .catch(() => undefined)
        .finally(() => { statusUpdate = undefined; });
    }, 2_000);
    const stopProgress = ctx.tasks.add("exec:status-interval", async () => {
      stopped = true;
      clearInterval(interval);
      await statusUpdate;
    });
    let stdout = "";
    let stderr = "";
    let exitCode: number | null | undefined;
    let resultTitle: string;
    try {
      const result = await ctx.processes.run(executable, args, {timeoutMs: 15000, maxOutputBytes: 12000});
      stdout = result.stdout.toString("utf8");
      stderr = result.stderr.toString("utf8");
      resultTitle = `✅ 执行完成（${((Date.now() - started) / 1_000).toFixed(2)}s）`;
    } catch (error) {
      await stopProgress();
      if (ctx.signal.aborted) return;
      const output = capturedOutput(error);
      stdout = output.stdout;
      stderr = output.stderr;
      exitCode = output.exitCode;
      const reason = output.code === "TIMED_OUT" ? "执行超时"
        : output.code === "OUTPUT_LIMIT" ? "输出超过限制"
        : output.code === "SPAWN_FAILED" ? "程序无法启动"
        : "执行失败";
      resultTitle = `❌ ${reason}（${((Date.now() - started) / 1_000).toFixed(2)}s）`;
    }
    await stopProgress();
    const pages = await resultPages(resultTitle, source, stdout, stderr, exitCode);
    const delivery = await deliverPages(pages, ctx.signal, (page, index) => index === 0
      ? ctx.telegram.edit(invocation.message, page, {parseMode: "html"})
      : ctx.telegram.reply(invocation.message, page, {parseMode: "html"}));
    if (!delivery.interrupted) return;
    ctx.log.error("exec.result_delivery_interrupted", {
      published: delivery.published,
      total: delivery.total,
      kind: deliveryErrorCategory(delivery.error),
    });
    if (delivery.published === 0) throw delivery.error;
    try {
      await ctx.telegram.reply(invocation.message, interruptedNotice(delivery));
    } catch {
      if (!ctx.signal.aborted) ctx.log.error("exec.result_delivery_notice_failed");
    }
  },
  };
}

export default function createExec(ownerId = process.env.TB_OWNER_ID) {
  const execCommand = command(ownerId);
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "exec",
    description: "受控执行系统命令",
    renderHelp: prefix => renderCommandHelp("exec", execCommand, {
      prefix,
      title: bold("🖥️ 系统命令执行"),
      intro: "以主程序的运行身份执行一个系统程序，并返回标准输出和错误输出。\n\n格式：\n程序可填写绝对路径，或 /usr/bin、/bin、/usr/sbin、/sbin 中的名称。",
      footer: ["{prefix}exec、{prefix}exec help 或 {prefix}help exec 查看本说明。"],
    }),
    commands: {exec: execCommand},
  });
}
