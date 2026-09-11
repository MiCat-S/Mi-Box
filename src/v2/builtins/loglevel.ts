import type {LogLevel as NativeLogLevel} from "teleproto/extensions/Logger";
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {Api} from "teleproto";
import {LogLevel, type RuntimeLogger} from "../logging";
import {isOwnerOrGroupSendAs} from "../permissions";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type PluginContext, type PluginDefinition} from "../sdk";

const names: Readonly<Record<string, LogLevel>> = Object.freeze({
  debug: LogLevel.DEBUG, info: LogLevel.INFO, warning: LogLevel.WARNING, warn: LogLevel.WARNING,
  error: LogLevel.ERROR, err: LogLevel.ERROR, silent: LogLevel.SILENT, off: LogLevel.SILENT,
});
type LevelController = Pick<RuntimeLogger, "initialize" | "getLevelName" | "getProtocolLevel" | "setLevel">;

/** Fixed helper and unit so the command never builds shell text from user input. */
const JOURNALCTL = "/usr/bin/journalctl";
const JOURNAL_SERVICE = "mibot.service";
const DEFAULT_LINES = 100;
const MAX_LINES = 500;
const READ_TIMEOUT_MS = 10_000;
const READ_OUTPUT_BYTES = 1_048_576;
const INVALID_LINES = `❌ 行数需为 1–${MAX_LINES} 的整数`;

export function createLogLevel(logger: LevelController, selfId?: string): PluginDefinition {
  const tails = new WeakMap<PluginContext, Promise<void>>();
  const loglevelCommand: CommandDefinition = {
    description: "查看或设置日志等级",
    args: "[等级]",
    arguments: [{name: "等级", description: "debug、info、warning（warn）、error（err）、silent（off）；省略时查看当前等级"}],
    examples: [{args: "debug"}, {args: "warning"}, {args: "silent"}, {args: "", description: "查看当前日志等级"}],
    help: [
      {
        heading: "可用等级",
        body: "<code>debug</code>、<code>info</code>、<code>warning</code>/<code>warn</code>、" +
          "<code>error</code>/<code>err</code>、<code>silent</code>/<code>off</code>。\n" +
          "名称不区分大小写；未知输入会提示无效且不保存。",
      },
      {
        heading: "行为",
        body: "• 设置会持久保存到日志配置，并在成功后同步 Telegram 客户端日志等级。\n" +
          "• 保存或同步失败时给出固定提示，不暴露配置路径或异常内容。\n" +
          "• 不同对话的设置按提交顺序串行执行，不会互相超越。",
      },
    ],
    async handle({message, args}, context) {
        const previous = tails.get(context) ?? Promise.resolve();
        // Keep persistence, publication and protocol synchronization in one order across chats.
        const result = previous.then(async () => {
          context.signal.throwIfAborted();
          if (!args.length) {
            await context.telegram.edit(message, `📋 <b>当前日志等级：</b> <code>${logger.getLevelName()}</code>`, {parseMode: "html"});
            return;
          }
          const input = args[0].toLowerCase();
          if (!Object.hasOwn(names, input)) {
            await context.telegram.edit(message, "❌ <b>无效的日志等级</b>\n\n" +
              "💡 可用等级：<code>debug</code>, <code>info</code>, <code>warning</code>, <code>error</code>, <code>silent</code>", {parseMode: "html"});
            return;
          }
          try {
            await context.tasks.run("loglevel:persist", signal => logger.setLevel(names[input], signal));
          } catch {
            context.signal.throwIfAborted();
            context.log.error("loglevel.persistence_failed");
            await context.telegram.edit(message, "❌ 日志等级保存失败，请检查日志配置文件");
            return;
          }
          context.signal.throwIfAborted();
          let synchronized = false;
          try {
            await context.telegram.withClient(async (client, signal) => {
              signal.throwIfAborted();
              client.setLogLevel(logger.getProtocolLevel() as NativeLogLevel);
              signal.throwIfAborted();
            });
            synchronized = true;
          } catch {
            context.signal.throwIfAborted();
            context.log.error("loglevel.protocol_sync_failed");
          }
          await context.telegram.edit(message,
            `✅ <b>日志等级已设置为：</b> <code>${logger.getLevelName()}</code>\n` +
            (synchronized ? "🔄 Telegram 客户端日志等级已同步更新" : "⚠️ Telegram 客户端日志等级同步失败"), {parseMode: "html"});
        });
        tails.set(context, result.then(() => undefined, () => undefined));
        await result;
      },
  };
  const logCommand: CommandDefinition = {
    description: "查看最近运行日志并发送到收藏夹",
    helpArgs: ["help", "h"],
    // Forwarding must not turn an owned outgoing private message into a log read.
    ignoreForwarded: true,
    args: "[行数]",
    arguments: [{name: "行数", description: `1–${MAX_LINES}，默认 ${DEFAULT_LINES}`}],
    examples: [
      {args: "", description: `查看最近 ${DEFAULT_LINES} 行日志`},
      {args: "200", description: "查看最近 200 行日志"},
    ],
    help: [
      {
        heading: "行为",
        body: `• 通过 <code>${JOURNALCTL}</code> 读取 <code>${JOURNAL_SERVICE}</code> 的最近日志。\n` +
          `• 结果保存为 <code>mibot.log</code>，只发送到本账号收藏夹；命令所在对话只显示发送结果。\n` +
          `• 行数限制 1–${MAX_LINES}，默认 ${DEFAULT_LINES}；其他输入会被拒绝。`,
      },
      {
        heading: "运行条件",
        body: "• 仅账号本人或本账号在群内以频道身份发出的新命令可用。\n" +
          "• 主机需要提供 /usr/bin/journalctl 与可用的 systemd 日志；读取限时、输出受限。\n" +
          "• 读取或发送失败时给出固定提示，不会把日志内容、路径或异常信息回显到命令聊天。",
      },
    ],
    async handle({message, args}, context) {
      context.signal.throwIfAborted();
      if (!isOwnerOrGroupSendAs(message, selfId)) {
        context.log.error("log.permission_denied");
        await context.telegram.edit(message, "没有查看日志的权限");
        return;
      }
      let lines = DEFAULT_LINES;
      if (args.length > 1 || (args.length === 1 && !/^[0-9]+$/.test(args[0]))) {
        await context.telegram.edit(message, INVALID_LINES);
        return;
      }
      if (args.length === 1) {
        const requested = Number(args[0]);
        if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_LINES) {
          await context.telegram.edit(message, INVALID_LINES);
          return;
        }
        lines = requested;
      }
      await context.files.withTemp(async (temp, signal) => {
        const output = path.join(temp, "mibot.log");
        let stdout: Buffer;
        try {
          const result = await context.processes.run(JOURNALCTL,
            ["-u", JOURNAL_SERVICE, "-n", String(lines), "--no-pager"],
            {timeoutMs: READ_TIMEOUT_MS, maxOutputBytes: READ_OUTPUT_BYTES});
          signal.throwIfAborted();
          stdout = result.stdout;
        } catch (error) {
          if (signal.aborted) throw error;
          // stderr, argv and native exception text stay out of the command chat.
          context.log.error("log.read_failed");
          await context.telegram.edit(message, "❌ 读取日志失败，请稍后重试");
          return;
        }
        if (!stdout.length) {
          context.log.info("log.empty");
          await context.telegram.edit(message, "📭 暂无可用日志");
          return;
        }
        try {
          await writeFile(output, stdout);
          signal.throwIfAborted();
        } catch (error) {
          if (signal.aborted) throw error;
          context.log.error("log.write_failed");
          await context.telegram.edit(message, "❌ 日志准备失败，请稍后重试");
          return;
        }
        try {
          await context.telegram.withClient(async client => {
            // Saved Messages is the only permitted destination for raw logs.
            await client.sendFile(new Api.InputPeerSelf(), {file: output, caption: "MiBot 运行日志"});
          });
          signal.throwIfAborted();
        } catch (error) {
          if (signal.aborted) throw error;
          context.log.error("log.send_failed");
          await context.telegram.edit(message, "❌ 日志发送失败，请稍后重试");
          return;
        }
        await context.telegram.edit(message, "✅ 日志已发送到收藏夹");
      });
    },
  };
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "loglevel",
    description: "日志工具：设置日志等级，查看最近运行日志",
    resources: {processes: {
      concurrency: 1, queueCapacity: 1, timeoutMs: READ_TIMEOUT_MS, maxOutputBytes: READ_OUTPUT_BYTES,
    }},
    async setup(context) {
      await context.tasks.run("loglevel:initialize", signal => logger.initialize(signal));
    },
    commands: {loglevel: loglevelCommand, log: logCommand},
  });
}
