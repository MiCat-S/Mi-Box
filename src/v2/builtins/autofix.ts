import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";

const output = (value: {stdout: Buffer; stderr: Buffer}): string =>
  `${value.stdout.toString("utf8")}${value.stderr.toString("utf8")}`.trim().slice(0, 1200);

export default function createAutofix(root = process.cwd()) {
  const autofixCommand: CommandDefinition = {
    description: "只读检查可修复项目",
    args: "",
    arguments: [],
    examples: [{args: "", description: "在当前主机执行只读诊断"}],
    help: [
      {
        heading: "检查内容",
        body: "• Git：主程序目录的 <code>git status --short --branch</code>。\n" +
          "• 服务：<code>systemctl is-active telebox-v2.service</code>。\n输出最多展示前 1200 字符。",
      },
      {
        heading: "运行条件",
        body: "• 主机需要提供 /usr/bin/git 和 /usr/bin/systemctl；任一执行失败时整体显示“Autofix 诊断失败”，不会执行任何修复。\n" +
          "• 本命令为只读诊断，不会修改代码、配置或服务。",
      },
      {
        heading: "常见提示",
        body: "• 诊断失败时命令不会执行任何修复；请检查服务器上的 Git 仓库与服务状态。",
      },
    ],
    async handle(invocation, ctx) {
      try {
        const [git, service] = await Promise.all([
          ctx.processes.run("/usr/bin/git", ["-C", root, "status", "--short", "--branch"], {timeoutMs: 5000, maxOutputBytes: 3000}),
          ctx.processes.run("/usr/bin/systemctl", ["is-active", "telebox-v2.service"], {timeoutMs: 5000, maxOutputBytes: 1000}),
        ]);
        await ctx.telegram.edit(invocation.message,
          `<b>Autofix 诊断</b>\n\nGit：<pre>${output(git) || "无输出"}</pre>\n服务：<code>${output(service) || "未知"}</code>\n\n当前为只读诊断，未执行修复。`,
          {parseMode: "html"});
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "Autofix 诊断失败，未执行任何修改");
      }
    },
  };
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "autofix",
    description: "诊断 Mi Box 服务、代码和插件状态",
    commands: {autofix: autofixCommand},
  });
}
