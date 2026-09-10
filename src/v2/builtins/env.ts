import {text} from "../ui/text";
import {definePlugin} from "../sdk";

const visible = new Set(["NODE_ENV", "TB_PREFIX", "TB_CMD_IGNORE_EDITED", "TB_LISTENER_HANDLE_EDITED"]);
function renderHelp(prefix: string): string {
  const p = text(prefix);
  return `⚙️ <b>运行环境查询</b>

查看当前进程允许公开显示的环境配置。

<b>使用：</b>
• <code>${p}env</code> — 列出全部可显示配置
• <code>${p}env 变量名</code> — 查看指定变量，名称区分大小写

<b>可查询项目：</b>
• NODE_ENV：运行环境标识
• TB_PREFIX：环境中的命令前缀配置
• TB_CMD_IGNORE_EDITED：命令处理编辑消息的环境设置
• TB_LISTENER_HANDLE_EDITED：监听器处理编辑消息的环境设置

<b>示例：</b>
<code>${p}env TB_PREFIX</code>
<code>${p}env NODE_ENV</code>

<b>结果说明：</b>
• “未设置”表示当前进程没有该环境变量。
• “无可显示配置”表示变量名不在上述查询范围。
• 这里展示环境值；查看当前生效的命令前缀使用 <code>${p}prefix</code>。
• 本命令用于查询。前缀修改使用 <code>${p}help prefix</code> 中的命令。

<code>${p}env help</code> / <code>${p}help env</code> 查看本说明。`;
}

export default function createEnv() {
  return definePlugin({apiVersion: 1, id: "env", renderHelp, description: "查看安全的运行环境配置",
    commands: {env: {helpArgs: ["help", "h"], description: "查看运行环境", async handle(invocation, ctx) {
      const name = invocation.args[0];
      const rows = [...visible].filter(key => !name || key === name).map(key => `${key}=${process.env[key] ?? "未设置"}`);
      await ctx.telegram.edit(invocation.message, `<code>${rows.join("\n") || "无可显示配置"}</code>`, {parseMode: "html"});
    }}}
  });
}
