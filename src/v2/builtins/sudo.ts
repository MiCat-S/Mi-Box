import {text} from "../ui/text";
import {definePlugin} from "../sdk";
import {isOwnerOrGroupSendAs} from "../permissions";

interface SudoConfig extends Record<string, unknown> {users: string[];}
const defaults: SudoConfig = {users: []};

function renderHelp(prefix: string): string {
  const p = text(prefix);
  return `🔐 <b>高级命令用户白名单</b>

维护 sudo 用户记录。各功能的实际访问权限仍以该功能自身的权限检查为准；标为“仅账号本人”的操作由本人执行。

<b>命令：</b>
• <code>${p}sudo add 用户ID</code> — 添加用户记录；重复添加保留一条记录
• <code>${p}sudo del 用户ID</code> — 删除用户记录
• <code>${p}sudo list</code> — 查看全部记录；简写 <code>${p}sudo ls</code>

<b>参数与权限：</b>
• 用户 ID 为纯数字；请填 Telegram 用户 ID，例如 123456789。
• 管理白名单由账号本人操作，支持本账号在群内以频道身份发出的新命令。
• 记录会持久保存，重启后继续使用。

<b>示例：</b>
<code>${p}sudo add 123456789</code>
<code>${p}sudo list</code>
<code>${p}sudo del 123456789</code>

<b>常见提示：</b>
• “只有 owner 可以管理”：请使用账号本人身份执行。
• 显示用法：检查 add/del 后是否填写纯数字 ID。

<code>${p}sudo</code>、<code>${p}sudo help</code> 或 <code>${p}help sudo</code> 查看本说明。`;
}

export default function createSudo() {
  return definePlugin({apiVersion: 1, id: "sudo", renderHelp, description: "管理可使用高级命令的用户白名单",
    commands: {sudo: {helpArgs: ["help", "h"], helpOnEmpty: true, description: "添加、删除或查看授权用户", async handle(invocation, ctx) {
      if (!isOwnerOrGroupSendAs(invocation.message, process.env.TB_OWNER_ID)) {
        await ctx.telegram.edit(invocation.message, "只有 owner 可以管理 sudo 白名单");
        return;
      }
      const store = ctx.storage.json<SudoConfig>("config.json", defaults);
      const sub = invocation.args[0]?.toLowerCase();
      const target = invocation.args[1];
      if (sub === "add" || sub === "del") {
        if (!target || !/^[0-9]+$/.test(target)) {
          await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}sudo ${sub} 用户 ID`);
          return;
        }
        await store.update(value => {
          const users = new Set(value.users);
          if (sub === "add") users.add(target); else users.delete(target);
          return {...value, users: [...users]};
        });
        await ctx.telegram.edit(invocation.message, `sudo 用户已${sub === "add" ? "添加" : "删除"}：<code>${target}</code>`, {parseMode: "html"});
        return;
      }
      if (sub === "ls" || sub === "list") {
        const value = await store.read();
        await ctx.telegram.edit(invocation.message, `<b>sudo 用户</b>\n${value.users.map(user => `<code>${user}</code>`).join("\n") || "暂无授权用户"}`, {parseMode: "html"});
        return;
      }
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}sudo add|del|ls 用户 ID`);
    }}},
  });
}
