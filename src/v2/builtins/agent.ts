import {text} from "../ui/text";
import {definePlugin} from "../sdk";

function renderHelp(prefix: string): string {
  const p = text(prefix);
  return `🤖 <b>AI 提问</b>

通过已加载的 AI 服务进行文字对话，可附带回复消息中的文字。

<b>使用：</b>
• <code>${p}agent 你的问题</code> — 直接提问
• 回复一条文字消息后发送 <code>${p}agent 总结这段内容</code> — 将引用文字与问题一并发送

<b>首次配置：</b>
需要先安装并配置提供聊天服务的 AI 插件。使用 <code>${p}help ai</code> 查看 AI 连接与模型配置方法。
本命令使用 AI 服务当前生效的聊天配置。

<b>示例：</b>
<code>${p}agent 用三句话解释 DNS</code>
回复一段文字后发送 <code>${p}agent 翻译为中文</code>。

<b>上下文与结果：</b>
• 每次请求由本次问题和引用消息的文字组成；本命令自身不保存多轮历史。
• 引用图片等媒体时，本命令只读取消息中的文字部分。
• 提问和引用文字会发送到已配置的 AI 服务，回答显示在当前对话。

<b>常见提示：</b>
• “AI 服务当前不可用”：检查 AI 插件是否已加载。
• “AI 请求失败”或“AI 未返回内容”：检查 AI 连接、模型配置及服务状态。

<code>${p}agent</code>、<code>${p}agent help</code> 或 <code>${p}help agent</code> 查看本说明。`;
}

export default function createAgent() {
  return definePlugin({apiVersion: 1, id: "agent", renderHelp, description: "调用已加载的 AI 服务进行对话",
    commands: {agent: {helpArgs: ["help", "h"], helpOnEmpty: true, description: "向 AI 提问，可回复消息提供上下文", async handle(invocation, ctx) {
      const prompt = invocation.args.join(" ").trim();
      if (!prompt) {
        await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}agent 你的问题\n也可以回复一条消息后提问`);
        return;
      }
      if (!ctx.services.available("ai", "chat")) {
        await ctx.telegram.edit(invocation.message, "AI 服务当前不可用");
        return;
      }
      const reply = await ctx.telegram.getReply(invocation.message);
      const context = reply?.text ? `\n\n引用消息：\n${reply.text}` : "";
      try {
        const result = await ctx.services.call<string>("ai", "chat", {text: prompt + context}, ctx.signal);
        await ctx.telegram.edit(invocation.message, result?.trim() || "AI 未返回内容");
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "AI 请求失败，请稍后重试");
      }
    }}},
  });
}
