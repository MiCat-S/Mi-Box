import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type CommandInvocation, type PluginContext} from "../sdk";
import {isOwner} from "../permissions";

interface SureConfig extends Record<string, unknown> {users: string[]; chats: string[]; messages: Record<string, string>;}
const defaults: SureConfig = {users: [], chats: [], messages: {}};

export default function createSure() {
  const idUsage = (prefix: string): string => `用法：${prefix}sure user|chat add|del ID`;
  const genericUsage = (prefix: string): string => `用法：${prefix}sure user|chat|msg add|del ...`;

  const authorize = async (invocation: CommandInvocation, ctx: PluginContext): Promise<boolean> => {
    if (isOwner(invocation.message)) return true;
    await ctx.telegram.edit(invocation.message, "只有 owner 可以管理 sure 白名单");
    return false;
  };

  const change = (scope: "user" | "chat") => (action: "add" | "del") =>
    async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
      const value = invocation.args[0];
      if (!value || !/^[0-9]+$/.test(value)) {
        await ctx.telegram.edit(invocation.message, idUsage(invocation.prefix));
        return;
      }
      await ctx.storage.json<SureConfig>("config.json", defaults).update(current => {
        const key = scope === "user" ? "users" : "chats";
        const values = new Set(current[key]);
        if (action === "add") values.add(value); else values.delete(value);
        return {...current, [key]: [...values]};
      });
      await ctx.telegram.edit(invocation.message, `sure ${scope} 已${action === "add" ? "添加" : "删除"}：<code>${value}</code>`, {parseMode: "html"});
    };

  const addMessage = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    // Legacy behavior stores only the first whitespace-delimited token and requires a non-empty value.
    const value = invocation.args[0];
    if (!value) {
      await ctx.telegram.edit(invocation.message, genericUsage(invocation.prefix));
      return;
    }
    await ctx.storage.json<SureConfig>("config.json", defaults).update(current => ({...current, messages: {...current.messages, [value]: value}}));
    await ctx.telegram.edit(invocation.message, "sure 消息规则已添加");
  };

  const list = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const current = await ctx.storage.json<SureConfig>("config.json", defaults).read();
    await ctx.telegram.edit(invocation.message,
      `<b>sure 白名单</b>\n用户：${current.users.length}\n对话：${current.chats.length}\n消息规则：${Object.keys(current.messages).length}`, {parseMode: "html"});
  };

  const idPair = (scope: "user" | "chat") => ({
    add: {
      description: `添加${scope === "user" ? "代发用户" : "允许代发的对话"}记录`,
      args: "ID",
      arguments: [{name: "ID", required: true, description: "纯数字 Telegram ID"}],
      examples: [{args: "add 123456789"}],
      handle: change(scope)("add"),
    },
    del: {
      description: `删除${scope === "user" ? "代发用户" : "允许代发的对话"}记录`,
      args: "ID",
      arguments: [{name: "ID", required: true, description: "纯数字 Telegram ID"}],
      examples: [{args: "del 123456789"}],
      handle: change(scope)("del"),
    },
  });

  const idFallback = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    await ctx.telegram.edit(invocation.message, idUsage(invocation.prefix));
  };
  const genericFallback = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    await ctx.telegram.edit(invocation.message, genericUsage(invocation.prefix));
  };

  const sureCommand: CommandDefinition = {
    description: "维护代发用户、对话和消息白名单",
    authorize,
    // Legacy parsing compared scope and action case-sensitively.
    subcommandsCaseSensitive: true,
    subcommands: {
      user: {description: "维护代发用户白名单", subcommands: idPair("user"), args: "", handle: idFallback},
      chat: {description: "维护允许代发的对话白名单", subcommands: idPair("chat"), args: "", handle: idFallback},
      msg: {description: "维护消息规则", subcommands: {
        add: {
          description: "添加规则：命中相同词时代发该词",
          args: "词",
          arguments: [{name: "词", required: true, description: "只取第一个词作为匹配键"}],
          examples: [{args: "add hello"}],
          handle: addMessage,
        },
      }, args: "", handle: genericFallback},
      ls: {aliases: ["list"], description: "查看白名单统计", args: "", examples: [{args: "ls"}], handle: list},
    },
    async handle(invocation, ctx) {
      await ctx.telegram.edit(invocation.message, genericUsage(invocation.prefix));
    },
  };

  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "sure",
    description: "管理 bot 代发消息的白名单规则",
    commands: {sure: sureCommand},
    listeners: [{direction: "incoming", async handle(message, ctx) {
      if (!message.senderId || !message.text.trim()) return;
      const store = ctx.storage.json<SureConfig>("config.json", defaults);
      const current = await store.read();
      if (!current.users.includes(message.senderId) ||
          (current.chats.length > 0 && !current.chats.includes(message.chatId))) return;
      const replacement = current.messages[message.text] ?? current.messages[`_command:${message.text.split(/\s+/, 1)[0]}`];
      if (!replacement || replacement.startsWith("_command:")) return;
      await ctx.telegram.withClient(async client => {
        const raw = message.raw as {peerId?: unknown} | undefined;
        if (raw?.peerId) await client.sendMessage(raw.peerId as never, {message: replacement});
      });
    }}],
  });
}
