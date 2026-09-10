import {bold} from "../ui/text";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";
import {renderCommandHelp} from "../commands";

const agentCommand: CommandDefinition = {
  description: "向 AI 提问，可回复消息提供上下文",
  helpArgs: ["help", "h"],
  helpOnEmpty: true,
  args: "你的问题",
  arguments: [
    {name: "你的问题", required: true, description: "要发送给 AI 服务的文字"},
    {name: "引用消息", description: "回复一条文字消息时，引用文字会与问题一并发送"},
  ],
  examples: [
    {args: "用三句话解释 DNS", description: "直接向 AI 提问"},
    {args: "翻译为中文", description: "回复一段文字后发送 <code>{prefix}agent 翻译为中文</code>。"},
  ],
  help: [
    {
      heading: "首次配置：",
      body: "需要先安装并配置提供聊天服务的 AI 插件。使用 <code>{prefix}help ai</code> 查看 AI 连接与模型配置方法。\n本命令使用 AI 服务当前生效的聊天配置。",
    },
    {
      heading: "上下文与结果：",
      body: "• 每次请求由本次问题和引用消息的文字组成；本命令自身不保存多轮历史。\n" +
        "• 引用图片等媒体时，本命令只读取消息中的文字部分。\n" +
        "• 提问和引用文字会发送到已配置的 AI 服务，回答显示在当前对话。",
    },
    {
      heading: "常见提示：",
      body: "• “AI 服务当前不可用”：检查 AI 插件是否已加载。\n" +
        "• “AI 请求失败”或“AI 未返回内容”：检查 AI 连接、模型配置及服务状态。",
    },
  ],
  async handle(invocation, ctx) {
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
  },
};

export default function createAgent() {
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "agent",
    description: "调用已加载的 AI 服务进行对话",
    renderHelp: prefix => renderCommandHelp("agent", agentCommand, {
      prefix,
      title: bold("🤖 AI 提问"),
      intro: "通过已加载的 AI 服务进行文字对话，可附带回复消息中的文字。\n\n使用：",
      footer: ["{prefix}agent、{prefix}agent help 或 {prefix}help agent 查看本说明。"],
    }),
    commands: {agent: agentCommand},
  });
}
