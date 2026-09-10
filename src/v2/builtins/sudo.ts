import {bold} from "../ui/text";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type CommandInvocation, type PluginContext} from "../sdk";
import {isOwnerOrGroupSendAs} from "../permissions";
import {renderCommandHelp} from "../commands";

interface SudoConfig extends Record<string, unknown> {users: string[];}
const defaults: SudoConfig = {users: []};

export default function createSudo() {
  const authorize = async (invocation: CommandInvocation, ctx: PluginContext): Promise<boolean> => {
    if (isOwnerOrGroupSendAs(invocation.message, process.env.TB_OWNER_ID)) return true;
    await ctx.telegram.edit(invocation.message, "只有 owner 可以管理 sudo 白名单");
    return false;
  };

  const change = (action: "add" | "del") => async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const target = invocation.args[0];
    if (!target || !/^[0-9]+$/.test(target)) {
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}sudo ${action} 用户 ID`);
      return;
    }
    const store = ctx.storage.json<SudoConfig>("config.json", defaults);
    await store.update(value => {
      const users = new Set(value.users);
      if (action === "add") users.add(target); else users.delete(target);
      return {...value, users: [...users]};
    });
    await ctx.telegram.edit(invocation.message, `sudo 用户已${action === "add" ? "添加" : "删除"}：<code>${target}</code>`, {parseMode: "html"});
  };

  const list = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const value = await ctx.storage.json<SudoConfig>("config.json", defaults).read();
    await ctx.telegram.edit(invocation.message, `<b>sudo 用户</b>\n${value.users.map(user => `<code>${user}</code>`).join("\n") || "暂无授权用户"}`, {parseMode: "html"});
  };

  const sudoCommand: CommandDefinition = {
    description: "添加、删除或查看授权用户",
    helpArgs: ["help", "h"],
    helpOnEmpty: true,
    authorize,
    subcommands: {
      add: {
        group: "命令：",
        description: "添加用户记录；重复添加保留一条记录",
        args: "用户ID",
        arguments: [{name: "用户ID", required: true, description: "纯数字 Telegram 用户 ID"}],
        examples: [{args: "add 123456789"}],
        handle: change("add"),
      },
      del: {
        group: "命令：",
        description: "删除用户记录",
        args: "用户ID",
        arguments: [{name: "用户ID", required: true, description: "纯数字 Telegram 用户 ID"}],
        examples: [{args: "del 123456789"}],
        handle: change("del"),
      },
      list: {aliases: ["ls"], group: "命令：", description: "查看全部记录", args: "", examples: [{args: "list"}], handle: list},
    },
    help: [
      {
        heading: "参数与权限：",
        body: "• 用户 ID 为纯数字；请填 Telegram 用户 ID，例如 123456789。\n" +
          "• 管理白名单由账号本人操作，支持本账号在群内以频道身份发出的新命令。\n" +
          "• 记录会持久保存，重启后继续使用。",
      },
      {
        heading: "常见提示：",
        body: "• “只有 owner 可以管理”：请使用账号本人身份执行。\n" +
          "• 显示用法：检查 add/del 后是否填写纯数字 ID。",
      },
    ],
    async handle(invocation, ctx) {
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}sudo add|del|ls 用户 ID`);
    },
  };

  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "sudo",
    description: "管理可使用高级命令的用户白名单",
    renderHelp: prefix => renderCommandHelp("sudo", sudoCommand, {
      prefix,
      title: bold("🔐 高级命令用户白名单"),
      intro: "维护 sudo 用户记录。各功能的实际访问权限仍以该功能自身的权限检查为准；标为“仅账号本人”的操作由本人执行。",
      footer: ["{prefix}sudo、{prefix}sudo help 或 {prefix}help sudo 查看本说明。"],
    }),
    commands: {sudo: sudoCommand},
  });
}
