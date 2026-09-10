import {readFile} from "node:fs/promises";
import path from "node:path";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";

async function packageVersion(root: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {version?: string};
    return value.version ?? "未知";
  } catch {
    return "未知";
  }
}

export default function createVersion(root = process.cwd()) {
  const versionCommand: CommandDefinition = {
    description: "查看版本信息",
    args: "",
    arguments: [],
    examples: [{args: "", description: "显示 Mi Box、Node.js、平台和进程 PID"}],
    help: [
      {
        heading: "说明",
        body: "显示 <code>package.json</code> 中的应用版本、Node.js 版本、运行平台和进程 PID。\n" +
          "只查看版本时可使用 <code>{prefix}ver</code>；两者行为一致，但 <code>{prefix}ver</code> 不显示 PID。",
      },
    ],
    async handle(invocation, ctx) {
      const text = [
        "<b>Mi Box 版本</b>", "",
        `Mi Box: <code>${await packageVersion(root)}</code>`,
        `Node.js: <code>${process.version}</code>`,
        `平台: <code>${process.platform}/${process.arch}</code>`,
        `PID: <code>${process.pid}</code>`,
      ].join("\n");
      await ctx.telegram.edit(invocation.message, text, {parseMode: "html"});
    },
  };

  const verCommand: CommandDefinition = {
    description: "version 的简写",
    args: "",
    arguments: [],
    examples: [{args: "", description: "显示 Mi Box、Node.js 和平台（不含 PID）"}],
    help: [
      {heading: "说明", body: "与 <code>{prefix}version</code> 相同，但不显示进程 PID。"},
    ],
    async handle(invocation, ctx) {
      const text = `<b>Mi Box 版本</b>\nMi Box: <code>${await packageVersion(root)}</code>\nNode.js: <code>${process.version}</code>\n平台: <code>${process.platform}/${process.arch}</code>`;
      await ctx.telegram.edit(invocation.message, text, {parseMode: "html"});
    },
  };

  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "version", description: "查看 Mi Box 与运行环境版本",
    commands: {version: versionCommand, ver: verCommand},
  });
}
