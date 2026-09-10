import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";
import type {Api} from "teleproto";

const reCommand: CommandDefinition = {
  description: "回复消息后重复转发，可指定数量和次数",
  args: "[消息数] [复读次数]",
  arguments: [
    {name: "消息数", description: "从被回复消息开始向前的消息数量，1–20，默认 1"},
    {name: "复读次数", description: "转发轮数，1–10，默认 1"},
  ],
  examples: [
    {args: "", description: "回复一条消息后发送，转发该消息一次"},
    {args: "3 5", description: "转发最近 3 条消息共 5 轮"},
  ],
  help: [
    {
      heading: "用法",
      body: "先回复一条目标消息，再发送 <code>{prefix}re [消息数] [复读次数]</code>。\n" +
        "消息数按被回复消息的 ID 向前推断，最大 20；复读次数最大 10。",
    },
    {
      heading: "结果与限制",
      body: "• 转发到当前对话；命令消息会在完成后删除。\n" +
        "• 目标消息禁止转发或缺少输入来源时会提示“复读失败：目标消息可能禁止转发”。\n" +
        "• 未回复消息时提示先回复一条消息。",
    },
  ],
  async handle(invocation, ctx) {
    const reply = await ctx.telegram.getReply(invocation.message);
    const raw = reply?.raw as Api.Message | undefined;
    const count = Math.min(Math.max(Number(invocation.args[0]) || 1, 1), 20);
    const repeat = Math.min(Math.max(Number(invocation.args[1]) || 1, 1), 10);
    if (!raw || !reply) {
      await ctx.telegram.edit(invocation.message, "请回复一条消息使用 .re [消息数] [复读次数]");
      return;
    }
    try {
      await ctx.telegram.withClient(async client => {
        const source = await raw.getInputChat();
        const target = await (invocation.message.raw as Api.Message).getInputChat();
        if (!target) throw new Error("target unavailable");
        const ids = Array.from({length: count}, (_, index) => reply.id - count + index + 1).filter(id => id > 0);
        for (let index = 0; index < repeat; index++) {
          await client.forwardMessages(target!, {messages: ids, fromPeer: source!});
        }
        const command = invocation.message.raw as {delete?: () => Promise<unknown>};
        if (typeof command.delete === "function") await command.delete();
      });
    } catch {
      if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "复读失败：目标消息可能禁止转发");
    }
  },
};

export default function createRe() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "re", description: "复读回复的消息",
    commands: {re: reCommand},
  });
}
