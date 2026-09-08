import {definePlugin} from "../sdk";
import {getIpPrivacy, setIpPrivacy, type IpPrivacy} from "../ip-privacy";
import {isOwnerOrGroupSendAs} from "../permissions";

export default function createPrivacy(ownerId: string) {
  let tail = Promise.resolve();
  return definePlugin({apiVersion: 1, id: "privacy", description: "IP显示隐私：privacy ip mask IPv4段数 [IPv6段数] 或 privacy ip hide",
    async setup(context) {
      const saved = await context.storage.json<IpPrivacy & Record<string, unknown>>("ip.json", {...getIpPrivacy()}).read();
      setIpPrivacy(saved);
    },
    commands: {privacy: {description: "设置所有输出的IP打码或隐藏", async handle(input, context) {
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
