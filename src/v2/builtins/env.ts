import {bold} from "../ui/text";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";
import {renderCommandHelp} from "../commands";

const visible = new Set(["NODE_ENV", "TB_PREFIX"]);

/**
 * The runtime resolves the deployment `.env` into an explicit environment
 * snapshot instead of mutating process.env, so this command must read that same
 * snapshot; process.env alone never contains the file's values.
 */
function command(environment: NodeJS.ProcessEnv): CommandDefinition {
  return {
  description: "查看运行环境",
  helpArgs: ["help", "h"],
  args: "[变量名]",
  arguments: [{name: "变量名", description: "可选；名称区分大小写，只接受下方可查询项目"}],
  examples: [{args: "TB_PREFIX"}, {args: "NODE_ENV"}, {args: "", description: "省略变量名时列出全部可显示配置"}],
  help: [
    {
      heading: "可查询项目：",
      body: "• NODE_ENV：运行环境标识\n" +
        "• TB_PREFIX：环境中的命令前缀配置",
    },
    {
      heading: "结果说明：",
      body: "• 取值来自启动时的进程环境与部署目录的 <code>.env</code>，进程环境优先。\n" +
        "• “未设置”表示两者都没有该变量。\n" +
        "• “无可显示配置”表示变量名不在上述查询范围。\n" +
        "• 这里展示环境值；查看当前生效的命令前缀使用 <code>{prefix}prefix</code>。\n" +
        "• 本命令用于查询。前缀修改使用 <code>{prefix}help prefix</code> 中的命令。",
    },
  ],
  async handle(invocation, ctx) {
    const name = invocation.args[0];
    const rows = [...visible].filter(key => !name || key === name).map(key => `${key}=${environment[key] ?? "未设置"}`);
    await ctx.telegram.edit(invocation.message, `<code>${rows.join("\n") || "无可显示配置"}</code>`, {parseMode: "html"});
  },
  };
}

export default function createEnv(environment: NodeJS.ProcessEnv = process.env) {
  const envCommand = command(environment);
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "env",
    description: "查看安全的运行环境配置",
    renderHelp: prefix => renderCommandHelp("env", envCommand, {
      prefix,
      title: bold("⚙️ 运行环境查询"),
      intro: "查看当前进程允许公开显示的环境配置。\n\n使用：",
      footer: ["{prefix}env help / {prefix}help env 查看本说明。"],
    }),
    commands: {env: envCommand},
  });
}
