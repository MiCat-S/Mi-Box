import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type PluginContext} from "../sdk";

function target(value: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value) || value.length > 253) throw new Error("无效的目标");
  return value;
}
async function probe(ctx: PluginContext, host: string): Promise<string> {
  const started = Date.now();
  const response = await ctx.http.withResponse(`https://${host}`, {method: "HEAD"}, async response => response.status,
    {timeoutMs: 5000});
  return `${host}: HTTP ${response}，${Date.now() - started} ms`;
}

const pingCommand: CommandDefinition = {
  description: "测试 Telegram 或目标地址延迟",
  helpArgs: ["help", "h"],
  args: "[域名]",
  arguments: [{name: "域名", description: "可选；省略时测试 Telegram 延迟，填写时对 https://域名 发起 HEAD 请求"}],
  examples: [
    {args: "", description: "测试 Telegram API 延迟与消息编辑耗时"},
    {args: "example.com", description: "测试目标地址的 HTTPS 延迟"},
  ],
  help: [
    {
      heading: "结果说明",
      body: "• 省略域名：先调用 Telegram 客户端，再测量消息编辑耗时，显示 Pong! 与两项毫秒数。\n" +
        "• 填写域名：对 <code>https://域名</code> 发起一次 5 秒超时的 HEAD 请求，显示 HTTP 状态与毫秒数。\n" +
        "• 域名只允许字母、数字、点、下划线、冒号和连字符，最长 253 字符。",
    },
    {
      heading: "常见提示",
      body: "• “Telegram 延迟测试失败”：检查账号连接状态。\n" +
        "• “网络测试失败或目标不可达”：检查域名、网络与目标服务。",
    },
  ],
  async handle(invocation, ctx) {
    const value = invocation.args[0];
    if (value === "help" || value === "h") {
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}ping 测 Telegram 延迟；${invocation.prefix}ping 域名 测 HTTPS（直连）`); return;
    }
    if (!value) {
      try {
        const started = performance.now();
        await ctx.telegram.withClient(client => client.getMe());
        const apiMs = performance.now() - started;
        const editing = performance.now();
        await ctx.telegram.edit(invocation.message, "Pong!");
        await ctx.telegram.edit(invocation.message, `Pong!\nTelegram API: ${apiMs.toFixed(0)} ms\n消息编辑: ${(performance.now() - editing).toFixed(0)} ms`);
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "Telegram 延迟测试失败");
      }
      return;
    }
    try { await ctx.telegram.edit(invocation.message, `<code>${await probe(ctx, target(value))}</code>`, {parseMode: "html"}); }
    catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "网络测试失败或目标不可达"); }
  },
};

export default function createPing() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "ping", description: "网络连通性与延迟测试",
    commands: {ping: pingCommand},
  });
}
