import {bold} from "../ui/text";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {isOwnerOrGroupSendAs} from "../permissions";
import {existsSync} from "node:fs";
import {renderCommandHelp} from "../commands";

export default function createBf(root = process.cwd(), ownerId = process.env.TB_OWNER_ID) {
  const bfCommand: CommandDefinition = {
    description: "打包并发送 Mi Box 备份",
    helpArgs: ["help", "h"],
    args: "",
    arguments: [],
    examples: [{args: "", description: "建议在收藏夹中执行，便于保存和下载备份文件。"}],
    help: [
      {
        heading: "备份内容：",
        body: "• assets：主程序与插件的数据目录\n• .env：环境配置，可能包含登录信息和密钥\n• package.json：应用版本及依赖声明\n仅打包实际存在的上述项目。",
      },
      {
        heading: "运行条件：",
        body: "• 由账号本人操作，支持本账号在群内以频道身份发出的新命令。\n" +
          "• 主机需要提供 /usr/bin/tar，且进程能够读取备份目录、写入临时目录。\n" +
          "• 打包限时 30 秒，文件发送还取决于网络状态和 Telegram 文件限制。",
      },
      {
        heading: "使用示例：",
        body: "1. 打开收藏夹，发送 <code>{prefix}bf</code>\n" +
          "2. 等待“备份已生成并发送”，下载收到的压缩包\n" +
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
        if (!entries.length) throw new Error("没有可备份的文件");
        await ctx.processes.run("/usr/bin/tar", ["-czf", output, "-C", root, ...entries], {
          timeoutMs: 30000, maxOutputBytes: 2000,
        });
        await ctx.telegram.withClient(async client => {
          const raw = invocation.message.raw as {peerId: unknown};
          await client.sendFile(raw.peerId as never, {file: output, caption: "Mi Box 备份"});
        });
        await ctx.telegram.edit(invocation.message, "备份已生成并发送");
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
      intro: "将主程序目录中的配置与数据打包成 tar.gz 文件，并发送到执行命令的当前对话。\n\n使用：",
      footer: ["{prefix}bf help / {prefix}help bf 查看本说明。"],
    }),
    commands: {bf: bfCommand},
  });
}
