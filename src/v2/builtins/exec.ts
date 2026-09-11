import {bold} from "../ui/text";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";
import {existsSync} from "node:fs";
import path from "node:path";
import {isOwnerOrGroupSendAs} from "../permissions";
import {renderCommandHelp} from "../commands";

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
        "• 单次执行限时 15 秒；输出收集上限 12000 字节，消息展示前 3500 字符。\n" +
        "• 命令作用于主程序所在主机，结果发到当前对话。",
    },
    {
      heading: "常见提示：",
      body: "• “找不到该系统命令”：检查名称，或指定已安装程序的绝对路径。\n" +
        "• “执行失败、超时或输出过大”：检查程序参数，并缩小命令输出范围。",
    },
  ],
  async handle(invocation, ctx) {
    const [file, ...args] = invocation.args;
    if (!isOwnerOrGroupSendAs(invocation.message, ownerId)) {
      await ctx.telegram.edit(invocation.message, "没有执行系统命令的权限");
      return;
    }
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
    try {
      const result = await ctx.processes.run(executable, args, {timeoutMs: 15000, maxOutputBytes: 12000});
      const output = `${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}`.trim() || "(无输出)";
      await ctx.telegram.edit(invocation.message, `<pre>${escape(output.slice(0, 3500))}</pre>`, {parseMode: "html"});
    } catch {
      if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "命令执行失败、超时或输出过大");
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
