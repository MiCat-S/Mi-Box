import {text} from "../ui/text";
import {definePlugin} from "../sdk";
import {getIpPrivacy, setIpPrivacy, type IpPrivacy} from "../ip-privacy";
import {isOwnerOrGroupSendAs} from "../permissions";

function renderHelp(prefix: string): string {
  const p = text(prefix);
  return `🔏 <b>IP 显示隐私</b>

设置主程序统一输出处理中的 IP 打码或隐藏规则，配置持久保存。

<b>命令：</b>
• <code>${p}privacy</code> — 查看当前设置
• <code>${p}privacy ip mask IPv4段数 [IPv6段数]</code> — 将地址末尾指定段数打码
• <code>${p}privacy ip hide</code> — 完全隐藏识别到的 IP 地址

<b>参数：</b>
• IPv4 段数：1–4 的整数
• IPv6 段数：1–8 的整数；省略时保留当前 IPv6 段数
• 从完全隐藏切回部分打码时，重新执行 mask 命令

<b>示例：</b>
• <code>${p}privacy ip mask 2 4</code> — IPv4 末尾 2 段、IPv6 末尾 4 段打码
• <code>${p}privacy ip mask 1</code> — IPv4 末尾 1 段打码，IPv6 使用原设置
• <code>${p}privacy ip hide</code> — 完全隐藏 IP

<b>权限与范围：</b>
• 修改设置由账号本人操作，支持本账号在群内以频道身份发出的新命令；转发的指令不能修改设置。
• 设置影响后续经过统一输出处理的消息，不会追溯编辑已经发出的历史消息。
• 此设置控制文字中的 IP 显示；图片、附件及绕过统一输出处理的内容需单独检查。

<b>常见提示：</b>
参数错误时，检查段数是否为上述范围内的整数，以及参数数量是否正确。

<code>${p}privacy help</code> / <code>${p}help privacy</code> 查看本说明。`;
}

export default function createPrivacy(ownerId: string) {
  let tail = Promise.resolve();
  return definePlugin({apiVersion: 1, id: "privacy", renderHelp, description: "IP显示隐私：privacy ip mask IPv4段数 [IPv6段数] 或 privacy ip hide",
    async setup(context) {
      const saved = await context.storage.json<IpPrivacy & Record<string, unknown>>("ip.json", {...getIpPrivacy()}).read();
      setIpPrivacy(saved);
    },
    commands: {privacy: {helpArgs: ["help", "h"], description: "设置所有输出的IP打码或隐藏", async handle(input, context) {
      const args = input.args;
      const usage = `${input.prefix}privacy ip mask 2 4\n${input.prefix}privacy ip hide`;
      if (!args.length) {
        const config = getIpPrivacy();
        await context.telegram.edit(input.message, `IP显示：${config.mode === "hide" ? "完全隐藏" : `IPv4末尾${config.ipv4Segments}段、IPv6末尾${config.ipv6Segments}段打码`}\n${usage}`); return;
      }
      if (!isOwnerOrGroupSendAs(input.message, ownerId) || input.message.forwarded) {
        await context.telegram.edit(input.message, "只有账号本人可以修改IP显示设置"); return;
      }
      const operation = tail.then(async () => {
        context.signal.throwIfAborted();
        const current = getIpPrivacy();
        let next: IpPrivacy;
        if (args[0] === "ip" && args[1] === "hide" && args.length === 2) next = {...current, mode: "hide"};
        else if (args[0] === "ip" && args[1] === "mask" && (args.length === 3 || args.length === 4)
          && /^[1-4]$/.test(args[2]) && (args[3] === undefined || /^[1-8]$/.test(args[3]))) {
          next = {mode: "mask", ipv4Segments: Number(args[2]), ipv6Segments: args[3] === undefined ? current.ipv6Segments : Number(args[3])};
        } else {await context.telegram.edit(input.message, `用法：\n${usage}\nIPv4：1–4段；IPv6：1–8段`); return;}
        await context.storage.json<IpPrivacy & Record<string, unknown>>("ip.json", {...current}).update(state => ({...state, ...next}));
        setIpPrivacy(next);
        await context.telegram.edit(input.message, `IP显示已更新：${next.mode === "hide" ? "完全隐藏" : `IPv4末尾${next.ipv4Segments}段、IPv6末尾${next.ipv6Segments}段打码`}`);
      });
      tail = operation.catch(() => undefined);
      await operation;
    }}}
  });
}
