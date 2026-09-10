import {text} from "../ui/text";
import {definePlugin} from "../sdk";
import {existsSync} from "node:fs";
import path from "node:path";
import {isOwnerOrGroupSendAs} from "../permissions";

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderHelp(prefix: string): string {
  const p = text(prefix);
  return `🖥️ <b>系统命令执行</b>

以主程序的运行身份执行一个系统程序，并返回标准输出和错误输出。

<b>格式：</b>
<code>${p}exec 程序 [参数...]</code>
程序可填写绝对路径，或 /usr/bin、/bin、/usr/sbin、/sbin 中的名称。

<b>示例：</b>
• <code>${p}exec uptime</code> — 查看运行时间和负载
• <code>${p}exec df -h</code> — 查看磁盘空间
• <code>${p}exec /usr/bin/uname -a</code> — 查看系统信息

<b>执行规则：</b>
• 由账号本人操作，支持本账号在群内以频道身份发出的新命令。
• 参数直接传给程序。Shell 的管道、重定向、通配符和变量展开语法不会自动解释。
• 程序路径最多 160 字符，允许字母、数字、下划线、点、斜杠、冒号和连字符。
• 单次执行限时 15 秒；输出收集上限 12000 字节，消息展示前 3500 字符。
• 命令作用于主程序所在主机，结果发到当前对话。

<b>常见提示：</b>
• “找不到该系统命令”：检查名称，或指定已安装程序的绝对路径。
• “执行失败、超时或输出过大”：检查程序参数，并缩小命令输出范围。

<code>${p}exec</code>、<code>${p}exec help</code> 或 <code>${p}help exec</code> 查看本说明。`;
}

export default function createExec() {
  return definePlugin({apiVersion: 1, id: "exec", renderHelp, description: "受控执行系统命令",
    commands: {exec: {helpArgs: ["help", "h"], helpOnEmpty: true, description: "执行一个非 shell 系统命令", async handle(invocation, ctx) {
      const [file, ...args] = invocation.args;
      if (!isOwnerOrGroupSendAs(invocation.message, process.env.TB_OWNER_ID)) {
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
    }}},
  });
}
