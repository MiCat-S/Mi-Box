import type {LogLevel as NativeLogLevel} from "teleproto/extensions/Logger";
import {LogLevel, type RuntimeLogger} from "../logging";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type PluginContext, type PluginDefinition} from "../sdk";

const names: Readonly<Record<string, LogLevel>> = Object.freeze({
  debug: LogLevel.DEBUG, info: LogLevel.INFO, warning: LogLevel.WARNING, warn: LogLevel.WARNING,
  error: LogLevel.ERROR, err: LogLevel.ERROR, silent: LogLevel.SILENT, off: LogLevel.SILENT,
});
type LevelController = Pick<RuntimeLogger, "initialize" | "getLevelName" | "getProtocolLevel" | "setLevel">;

export function createLogLevel(logger: LevelController): PluginDefinition {
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
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "loglevel", description: "日志等级设置工具：debug、info、warning、error、silent",
    async setup(context) {
      await context.tasks.run("loglevel:initialize", signal => logger.initialize(signal));
    },
    commands: {loglevel: loglevelCommand},
  });
}
