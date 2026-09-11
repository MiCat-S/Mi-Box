import {bold} from "../ui/text";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {isOwnerOrGroupSendAs} from "../permissions";
import {existsSync} from "node:fs";
import {renderCommandHelp} from "../commands";
import {Api} from "teleproto";

export default function createBf(root = process.cwd(), ownerId = process.env.TB_OWNER_ID) {
  const bfCommand: CommandDefinition = {
    description: "打包并发送 Mi Box 备份",
    helpArgs: ["help", "h"],
    // Owner identity now resolves for outgoing private messages, so forwarded
    // commands must be dropped at admission before any pack or upload.
    ignoreForwarded: true,
    args: "",
    arguments: [],
    examples: [{args: "", description: "可在任意对话执行；备份文件只发送到本账号收藏夹。"}],
    help: [
      {
        heading: "备份内容：",
        body: "• assets：主程序与插件的数据目录\n• .env：环境配置，可能包含登录信息和密钥\n• package.json：应用版本及依赖声明\n仅打包实际存在的上述项目。",
      },
      {
        heading: "运行条件：",
        body: "• 由账号本人操作，支持本账号在群内以频道身份发出的新命令。\n" +
          "• 主机需要提供 /usr/bin/tar，且进程能够读取备份目录、写入临时目录。\n" +
          "• 打包限时 30 秒，文件发送还取决于网络状态和 Telegram 文件限制。\n" +
          "• 无论命令来自收藏夹、私聊还是群聊，备份只发送到本账号收藏夹，不会发到当前对话。",
      },
      {
        heading: "使用示例：",
        body: "1. 在收藏夹、私聊或群聊发送 <code>{prefix}bf</code>\n" +
          "2. 等待“已发送到收藏夹”，在收藏夹下载收到的压缩包\n" +
          "3. 将压缩包保存在可信位置；向他人分享前检查其中的配置和凭据",
      },
      {
        heading: "功能范围：",
        body: "当前命令负责生成备份。恢复需要按部署目录手动还原文件，并检查对应版本与服务配置。",
      },
    ],
    async handle(invocation, ctx) {
      if (!isOwnerOrGroupSendAs(invocation.message, ownerId)) {
        await ctx.telegram.edit(invocation.message, "没有创建备份的权限");
        return;
      }
      await ctx.files.withTemp(async (temp, signal) => {
        const output = path.join(temp, `mi-box-${randomUUID()}.tar.gz`);
        const entries = ["assets", ".env", "package.json"].filter(entry => existsSync(path.join(root, entry)));
        if (!entries.length) {
          ctx.log.error("bf.no_input");
          await ctx.telegram.edit(invocation.message, "❌ 没有可备份的文件");
          return;
        }
        try {
          await ctx.processes.run("/usr/bin/tar", ["-czf", output, "-C", root, ...entries], {
            timeoutMs: 30_000, maxOutputBytes: 2000,
          });
          signal.throwIfAborted();
        } catch (error) {
          if (signal.aborted) throw error;
          // Never surface the tar argv, filesystem paths or native error text to the chat.
          ctx.log.error("bf.pack_failed");
          await ctx.telegram.edit(invocation.message, "❌ 备份打包失败，请稍后重试");
          return;
        }
        try {
          await ctx.telegram.withClient(async client => {
            // Saved Messages is the only permitted destination; never the invoking chat,
            // which may be a public group.
            await client.sendFile(new Api.InputPeerSelf(), {file: output, caption: "Mi Box 备份"});
          });
          signal.throwIfAborted();
        } catch (error) {
          if (signal.aborted) throw error;
          ctx.log.error("bf.send_failed");
          await ctx.telegram.edit(invocation.message, "❌ 备份发送失败，请稍后重试");
          return;
        }
        await ctx.telegram.edit(invocation.message, "✅ 备份已生成，已发送到收藏夹");
      });
    },
  };
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "bf",
    description: "创建 Mi Box 配置与数据备份",
    renderHelp: prefix => renderCommandHelp("bf", bfCommand, {
      prefix,
      title: bold("💾 配置与数据备份"),
      intro: "将主程序目录中的配置与数据打包成 tar.gz 文件，并仅发送到本账号收藏夹。\n\n使用：",
      footer: ["{prefix}bf help / {prefix}help bf 查看本说明。"],
    }),
    commands: {bf: bfCommand},
  });
}
