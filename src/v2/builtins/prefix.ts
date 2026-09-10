import type { PluginHost } from "../host";
import type { PrefixPersistence } from "../prefixes";
import { STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type PluginDefinition } from "../sdk";
import { renderCommandHelp } from "../commands";

type PrefixHost = Pick<PluginHost, "configuration" | "replacePrefixes">;
const queues = new WeakMap<PrefixHost, Promise<void>>();

function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function list(prefixes: readonly string[]): string {
  return prefixes.map(prefix => `<code>${html(prefix)}</code>`).join(" • ");
}

export function createPrefix(host: PrefixHost, persistence: PrefixPersistence): PluginDefinition {
  // The business path keeps its first-line parser (CRLF handling and the
  // legacy help/h position); help text itself comes from the same declaration.
  const prefixCommand: CommandDefinition = {
    description: "查看、设置、追加或删除命令前缀",
    args: "",
    alternates: [
      {args: "set [前缀...]", description: "设置并持久化前缀"},
      {args: "add [前缀...]", description: "追加前缀"},
      {args: "del [前缀...]", description: "删除前缀"},
    ],
    examples: [{args: "set . ！"}, {args: "add ?"}, {args: "del !"}],
    help: [
      {
        heading: "说明：",
        body: "• 只处理消息第一行，其余行忽略。\n" +
          "• 修改会写入 <code>.env</code> 的 TB_PREFIX；写入失败时仅本次生效。\n" +
          "• 前缀会去重并保持顺序，至少保留一个。",
      },
    ],
    handle(input, context) {
      // Own the entire operation through actual settlement, not an abort race.
      return context.tasks.run("prefix:update", () => {
        const result = (queues.get(host) ?? Promise.resolve()).then(async () => {
          context.signal.throwIfAborted();
          const current = host.configuration().prefixes;
          const usage = buildHelp(current[0]);
          const [, ...args] = input.message.text.trim().split(/\r?\n/u)[0].split(/\s+/u);
          const sub = (args[0] ?? "").toLowerCase();
          const edit = (text: string) => {
            context.signal.throwIfAborted();
            return context.telegram.edit(input.message, text, { parseMode: "html", linkPreview: false });
          };
          if (!sub) return edit(`🔧 当前前缀: ${list(current)}\n用法: <code>${html(current[0])}prefix set . ！</code>`);
          if ([sub, args[1]?.toLowerCase()].some(value => value === "help" || value === "h") ||
              !["set", "add", "del"].includes(sub)) return edit(usage);
          const tokens = args.slice(1).filter(Boolean);
          if (!tokens.length) return edit(`❌ 参数不足\n\n${usage}`);
          const prefixes = [...new Set(sub === "set" ? tokens : sub === "add" ? [...current, ...tokens]
            : current.filter(prefix => !tokens.includes(prefix)))];
          if (!prefixes.length) return edit("❌ 至少保留一个前缀");
          if (prefixes.some(prefix => prefix.includes("\0"))) return edit(`❌ 前缀无效\n\n${usage}`);
          host.replacePrefixes(prefixes);
          let persisted = true;
          try { await persistence.persist(Object.freeze([...prefixes]), context.signal); }
          catch {
            context.signal.throwIfAborted();
            persisted = false;
            context.log.error("prefix.persistence_failed");
          }
          return edit(`✅ 已设置前缀: ${list(prefixes)} ${persisted ? "(已写入 .env)" : "(.env 写入失败, 仅本次生效)"}`);
        });
        const settled = result.then(() => undefined, () => undefined);
        queues.set(host, settled);
        void settled.then(() => { if (queues.get(host) === settled) queues.delete(host); });
        return result;
      });
    },
  };
  const buildHelp = (prefix: string): string =>
    renderCommandHelp("prefix", prefixCommand, {prefix, title: "🛠 <b>前缀管理</b>"});
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "prefix", description: "查看、设置、追加或删除命令前缀",
    commands: {prefix: prefixCommand},
  });
}
