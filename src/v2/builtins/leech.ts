import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type CommandInvocation, type PluginContext} from "../sdk";
import {renderCommandHelp} from "../commands";

export default function createLeech() {
  const help = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    await ctx.telegram.edit(invocation.message, buildHelp(invocation.prefix), {parseMode: "html"});
  };

  const leechCommand: CommandDefinition = {
    description: "查看归档状态和数据库信息",
    defaultSubcommand: "help",
    subcommands: {
      session: {
        description: "检查 Telegram 会话是否正常",
        args: "",
        examples: [{args: "session"}],
        async handle(invocation, ctx) {
          const me = await ctx.telegram.withClient(client => client.getMe());
          await ctx.telegram.edit(invocation.message, `<b>Telegram 会话正常</b>\n账号：<code>${String((me as {id?: unknown})?.id ?? "unknown")}</code>`, {parseMode: "html"});
        },
      },
      stats: {
        description: "统计归档数据库各表行数",
        args: "",
        examples: [{args: "stats"}],
        async handle(invocation, ctx) {
          const result = await ctx.storage.sqlite("leech.sqlite").read(connection => {
            const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{name: string}>;
            return tables.map(table => {
              const name = table.name.replace(/"/g, "\"\"");
              const row = connection.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as {count: number};
              return `${table.name}: ${row.count}`;
            });
          });
          await ctx.telegram.edit(invocation.message, `<b>Leech 统计</b>\n${result.join("\n") || "暂无数据"}`, {parseMode: "html"});
        },
      },
      db: {
        description: "查看归档数据库文件位置",
        args: "",
        examples: [{args: "db"}],
        async handle(invocation, ctx) {
          ctx.storage.sqlite("leech.sqlite");
          await ctx.telegram.edit(invocation.message, "Leech 数据库已启用：<code>assets/leech.sqlite</code>", {parseMode: "html"});
        },
      },
      help: {aliases: ["h"], description: "查看本说明", args: "", examples: [{args: "help"}], handle: help},
    },
    help: [
      {
        heading: "说明",
        body: "• 历史抓取功能正在迁移中；当前提供会话检查、数据库位置与表统计。\n" +
          "• 数据库位于 <code>assets/leech.sqlite</code>。",
      },
    ],
    async handle(invocation, ctx) {
      await ctx.telegram.edit(invocation.message, "未知子命令，请使用 .leech help");
    },
  };

  const buildHelp = (prefix: string): string => renderCommandHelp("leech", leechCommand, {prefix});

  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "leech", description: "历史消息归档与抓取工具",
    commands: {leech: leechCommand},
  });
}
