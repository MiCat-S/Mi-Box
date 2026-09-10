import {bold} from "../ui/text";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type CommandInvocation, type PluginContext, type SubcommandDefinition} from "../sdk";
import {getIpPrivacy, setIpPrivacy, type IpPrivacy} from "../ip-privacy";
import {isOwnerOrGroupSendAs} from "../permissions";
import {renderCommandHelp} from "../commands";

const usage = (prefix: string): string => `${prefix}privacy ip mask 2 4\n${prefix}privacy ip hide`;
const describe = (config: IpPrivacy): string =>
  config.mode === "hide" ? "完全隐藏" : `IPv4末尾${config.ipv4Segments}段、IPv6末尾${config.ipv6Segments}段打码`;

export default function createPrivacy(ownerId: string) {
  let tail = Promise.resolve();

  const ownerCheck = async (invocation: CommandInvocation, ctx: PluginContext): Promise<boolean> => {
    if (isOwnerOrGroupSendAs(invocation.message, ownerId) && !invocation.message.forwarded) return true;
    await ctx.telegram.edit(invocation.message, "只有账号本人可以修改IP显示设置");
    return false;
  };

  const mutate = async (invocation: CommandInvocation, ctx: PluginContext, apply: (current: IpPrivacy) => IpPrivacy): Promise<void> => {
    const operation = tail.then(async () => {
      ctx.signal.throwIfAborted();
      const current = getIpPrivacy();
      const next = apply(current);
      await ctx.storage.json<IpPrivacy & Record<string, unknown>>("ip.json", {...current}).update(state => ({...state, ...next}));
      setIpPrivacy(next);
      await ctx.telegram.edit(invocation.message, `IP显示已更新：${describe(next)}`);
    });
    tail = operation.catch(() => undefined);
    await operation;
  };

  const hide = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    if (invocation.args.length !== 0) {
      await ctx.telegram.edit(invocation.message, `用法：\n${usage(invocation.prefix)}\nIPv4：1–4段；IPv6：1–8段`);
      return;
    }
    await mutate(invocation, ctx, current => ({...current, mode: "hide"}));
  };

  const mask = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const ipv4 = invocation.args[0];
    const ipv6 = invocation.args[1];
    if (invocation.args.length > 2 || !/^[1-4]$/.test(ipv4 ?? "") || (ipv6 !== undefined && !/^[1-8]$/.test(ipv6))) {
      await ctx.telegram.edit(invocation.message, `用法：\n${usage(invocation.prefix)}\nIPv4：1–4段；IPv6：1–8段`);
      return;
    }
    await mutate(invocation, ctx, current => ({
      mode: "mask", ipv4Segments: Number(ipv4), ipv6Segments: ipv6 === undefined ? current.ipv6Segments : Number(ipv6),
    }));
  };

  const ipCommand: SubcommandDefinition = {
    description: "设置 IP 打码或完全隐藏",
    group: "命令：",
    authorize: ownerCheck,
    subcommands: {
      hide: {description: "完全隐藏识别到的 IP 地址", args: "", handle: hide},
      mask: {
        description: "将地址末尾指定段数打码",
        args: "IPv4段数 [IPv6段数]",
        arguments: [
          {name: "IPv4段数", required: true, description: "1–4 的整数"},
          {name: "IPv6段数", description: "1–8 的整数；省略时保留当前 IPv6 段数"},
        ],
        examples: [{args: "mask 2 4"}, {args: "mask 1"}],
        handle: mask,
      },
    },
    args: "",
    async handle(invocation, ctx) {
      await ctx.telegram.edit(invocation.message, `用法：\n${usage(invocation.prefix)}\nIPv4：1–4段；IPv6：1–8段`);
    },
  };

  const privacyCommand: CommandDefinition = {
    description: "设置所有输出的IP打码或隐藏",
    helpArgs: ["help", "h"],
    // Legacy parsing compared scope and action case-sensitively.
    subcommandsCaseSensitive: true,
    subcommands: {ip: ipCommand},
    help: [
      {
        heading: "参数：",
        body: "• IPv4 段数：1–4 的整数\n• IPv6 段数：1–8 的整数；省略时保留当前 IPv6 段数\n• 从完全隐藏切回部分打码时，重新执行 mask 命令",
      },
      {
        heading: "权限与范围：",
        body: "• 修改设置由账号本人操作，支持本账号在群内以频道身份发出的新命令；转发的指令不能修改设置。\n" +
          "• 设置影响后续经过统一输出处理的消息，不会追溯编辑已经发出的历史消息。\n" +
          "• 此设置控制文字中的 IP 显示；图片、附件及绕过统一输出处理的内容需单独检查。",
      },
      {heading: "常见提示：", body: "参数错误时，检查段数是否为上述范围内的整数，以及参数数量是否正确。"},
    ],
    async handle(invocation, ctx) {
      if (!invocation.args.length) {
        const config = getIpPrivacy();
        await ctx.telegram.edit(invocation.message, `IP显示：${describe(config)}\n${usage(invocation.prefix)}`);
        return;
      }
      if (!await ownerCheck(invocation, ctx)) return;
      await ctx.telegram.edit(invocation.message, `用法：\n${usage(invocation.prefix)}\nIPv4：1–4段；IPv6：1–8段`);
    },
  };

  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "privacy",
    description: "IP显示隐私：privacy ip mask IPv4段数 [IPv6段数] 或 privacy ip hide",
    renderHelp: prefix => renderCommandHelp("privacy", privacyCommand, {
      prefix,
      title: bold("🔏 IP 显示隐私"),
      intro: "设置主程序统一输出处理中的 IP 打码或隐藏规则，配置持久保存。",
      footer: ["{prefix}privacy help / {prefix}help privacy 查看本说明。"],
    }),
    async setup(context) {
      const saved = await context.storage.json<IpPrivacy & Record<string, unknown>>("ip.json", {...getIpPrivacy()}).read();
      setIpPrivacy(saved);
    },
    commands: {privacy: privacyCommand},
  });
}
