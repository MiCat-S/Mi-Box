import { setTimeout as delay } from "node:timers/promises";
import type { Api } from "teleproto";
import type { PluginHost } from "../host";
import { definePlugin, STRUCTURED_PLUGIN_API_VERSION, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext, type PluginDefinition } from "../sdk";
import type { SqliteConnection } from "../sqlite";
import { renderCommandHelp } from "../commands";

interface AliasRow { original: string; final: string; }
interface AliasState {
  database: ReturnType<PluginContext["storage"]["sqlite"]>;
  tail: Promise<void>;
}

class AliasInputError extends Error {}

function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function rows(db: SqliteConnection): AliasRow[] {
  const result = db.prepare<[], AliasRow>("SELECT original, final FROM aliases ORDER BY original").all();
  if (result.some(row => typeof row.original !== "string" || !row.original.trim() ||
      typeof row.final !== "string" || !row.final.trim())) {
    throw new Error("别名数据库包含无效记录");
  }
  return result;
}

function mapping(records: AliasRow[]): Record<string, string> {
  return Object.fromEntries(records.map(row => [row.original, row.final]));
}

function serialize<T>(state: AliasState, context: PluginContext, operation: () => Promise<T>): Promise<T> {
  // Include publication in the queue, so different chats cannot publish stale snapshots.
  const result = state.tail.then(() => {
    context.signal.throwIfAborted();
    return operation();
  });
  state.tail = result.then(() => undefined, () => undefined);
  return result;
}

function edit(context: PluginContext, message: MessageEnvelope, text: string): Promise<void> {
  return context.telegram.edit(message, html(text), { parseMode: "html", linkPreview: false });
}

async function temporary(context: PluginContext, message: MessageEnvelope, text: string): Promise<void> {
  await edit(context, message, text);
  await context.tasks.run("alias:temporary-delete", async () => {
    try {
      await delay(5000, undefined, { signal: context.signal });
      await context.telegram.withClient(async (client, signal) => {
        signal.throwIfAborted();
        const raw = message.raw as Api.Message | undefined;
        const peer = raw?.className === "Message" ? raw.inputChat ?? raw.peerId
          : (await import("teleproto/Helpers.js")).returnBigInt(message.chatId);
        signal.throwIfAborted();
        await client.deleteMessages(peer, [message.id], { revoke: false });
        signal.throwIfAborted();
      });
    } catch {
      context.signal.throwIfAborted();
      throw new Error("别名临时消息删除失败");
    }
  });
}

export function createAlias(host: Pick<PluginHost, "listCommands" | "configuration" | "replaceAliases">): PluginDefinition {
  const states = new WeakMap<PluginContext, AliasState>();
  const prefix = host.configuration().prefixes[0];
  const setArgs = "[别名...] [原命令...]";
  const delArgs = "[别名...]";
  const setUsage = `参数不足，用法：${prefix}alias set ${setArgs}`;
  const delUsage = `参数不足，用法：${prefix}alias del ${delArgs}`;

  function target(tokens: string[]): AliasRow {
    if (tokens.length < 2) throw new AliasInputError(setUsage);
    const commands = new Set(host.listCommands().map(command => command.name));
    const split = tokens.findIndex((token, index) => index > 0 && commands.has(token));
    const alias = split > 0 ? tokens.slice(0, split).join(" ") : tokens[0];
    const original = split > 0 ? tokens.slice(split).join(" ") : tokens[1];
    const command = original.split(/\s+/)[0];
    if (!commands.has(command)) {
      if (Object.hasOwn(host.configuration().aliases, command)) {
        throw new AliasInputError("不应该对重定向的命令再次重定向");
      }
      throw new AliasInputError(`没找到${command}该原始命令，不保存该重定向`);
    }
    // The legacy schema names the alias "original" and its command expansion "final".
    return { original: alias, final: original };
  }

  const operate = async (
    invocation: CommandInvocation,
    context: PluginContext,
    action: "set" | "del" | "list",
  ): Promise<void> => {
    const state = states.get(context);
    if (!state) throw new Error("别名插件尚未初始化");
    let response: string;
    try {
      response = await serialize(state, context, async () => {
        if (action === "list") {
          const records = await state.database.read(rows);
          return records.length ? "重命名列表：\n" + records.map(row => `${row.original} -> ${row.final}`).join("\n")
            : "当前没有任何别名配置";
        }
        const tokens = [...invocation.args];
        const result = await state.database.transaction(db => {
          let text: string;
          if (action === "set") {
            const entry = target(tokens);
            db.prepare("DELETE FROM aliases WHERE final = ? AND original <> ?").run(entry.final, entry.original);
            // UPDATE preserves extension values, including required columns with no default.
            const updated = db.prepare("UPDATE aliases SET final = ? WHERE original = ?").run(entry.final, entry.original);
            if (updated.changes === 0) {
              db.prepare("INSERT INTO aliases (original, final) VALUES (?, ?)").run(entry.original, entry.final);
            }
            text = `插件命令重命名成功，${entry.original} -> ${entry.final}`;
          } else {
            const alias = tokens.join(" ");
            if (!alias) throw new AliasInputError(delUsage);
            const removed = db.prepare("DELETE FROM aliases WHERE original = ?").run(alias).changes > 0;
            text = removed ? `删除 ${alias} 重命名成功` : `删除 ${alias} 重命名失败，请检查命令是否存在`;
          }
          return { records: rows(db), response: text };
        });
        context.signal.throwIfAborted();
        host.replaceAliases(mapping(result.records));
        return result.response;
      });
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof AliasInputError) return temporary(context, invocation.message, error.message);
      context.log.error("alias.storage_failed", { operation: action });
      return temporary(context, invocation.message, "别名数据库操作失败，请稍后重试");
    }
    await edit(context, invocation.message, response);
  };

  const aliasCommand: CommandDefinition = {
    description: "设置、删除或列出命令别名",
    // Subcommand matching stays case-sensitive to preserve the legacy behavior.
    subcommandsCaseSensitive: true,
    args: "set|del|ls",
    subcommands: {
      set: {
        args: setArgs,
        description: "使用别名执行原命令；同一完整目标只保留一个别名",
        examples: [{ args: "set a b", description: "使用别名 a 执行命令 b" }],
        handle: (invocation, context) => operate(invocation, context, "set"),
      },
      del: {
        args: delArgs,
        description: "删除指定别名",
        examples: [{ args: "del a" }],
        handle: (invocation, context) => operate(invocation, context, "del"),
      },
      ls: {
        aliases: ["list"],
        description: "查看所有别名",
        handle: (invocation, context) => operate(invocation, context, "list"),
      },
    },
    handle: async (invocation, context) => {
      const sub = invocation.args[0];
      if (!sub) return edit(context, invocation.message, "不知道你要干什么！");
      return edit(context, invocation.message, `未知子命令: ${sub}`);
    },
  };

  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "alias",
    description: `插件命令重命名\n<code>${html(prefix)}alias set a b</code> - 使用别名 a 执行 b（同一完整目标只保留一个别名）\n` +
      `<code>${html(prefix)}alias del a</code> - 删除别名\n<code>${html(prefix)}alias ls</code> - 查看所有别名`,
    renderHelp: helpPrefix => renderCommandHelp("alias", aliasCommand, { prefix: helpPrefix }),
    async setup(context) {
      const state: AliasState = { database: context.storage.sqlite("alias.db"), tail: Promise.resolve() };
      const records = await state.database.transaction(db => {
        db.exec("CREATE TABLE IF NOT EXISTS aliases (original TEXT PRIMARY KEY, final TEXT NOT NULL)");
        return rows(db);
      });
      context.signal.throwIfAborted();
      host.replaceAliases(mapping(records));
      states.set(context, state);
    },
    commands: { alias: aliasCommand },
  });
}
