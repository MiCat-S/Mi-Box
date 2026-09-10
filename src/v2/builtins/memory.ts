import {bold} from "../ui/text";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type CommandInvocation, type PluginContext} from "../sdk";
import {renderCommandHelp} from "../commands";

interface MemoryConfig extends Record<string, unknown> {enabled: boolean; heap: number; rss: number; silent: boolean; baselineHeap?: number; baselineRss?: number;}
const defaults: MemoryConfig = {enabled: false, heap: 150, rss: 512, silent: false};

function snapshot() {
  const value = process.memoryUsage();
  return {heap: value.heapUsed / 1048576, heapTotal: value.heapTotal / 1048576,
    rss: value.rss / 1048576, external: value.external / 1048576,
    arrayBuffers: value.arrayBuffers / 1048576};
}
function html(value: number): string {return value.toFixed(2);}
function report(config: MemoryConfig): string {
  const m = snapshot();
  const level = m.rss > config.rss || m.heap > config.heap ? "偏高" : "正常";
  const heapPercent = m.heapTotal > 0 ? (m.heap / m.heapTotal) * 100 : 0;
  const baseline = config.baselineRss === undefined ? "" :
    `\nRSS 变化: <code>${m.rss >= config.baselineRss ? "+" : ""}${html(m.rss - config.baselineRss)} MB</code>`;
  return `<b>内存状态</b>\n\n` +
    `RSS（进程总占用）: <code>${html(m.rss)} / ${config.rss} MB</code>\n` +
    `Heap（JS 已用）: <code>${html(m.heap)} / ${html(m.heapTotal)} MB</code>　<code>${html(heapPercent)}%</code>\n` +
    `External（原生内存）: <code>${html(m.external)} MB</code>\n` +
    `ArrayBuffer（缓冲区）: <code>${html(m.arrayBuffers)} MB</code>\n` +
    `状态: <b>${level}</b>\n` +
    `基线 RSS: <code>${config.baselineRss === undefined ? "未设置" : html(config.baselineRss) + " MB"}</code>${baseline}\n` +
    `自动保护: <b>${config.enabled ? "开启" : "关闭"}</b>`;
}
function parsePositive(value: string | undefined): number | undefined {
  const number = Number(value); return Number.isFinite(number) && number > 0 ? number : undefined;
}
async function configOf(ctx: PluginContext) {
  return ctx.storage.json<MemoryConfig>("config.json", defaults);
}

const usage = "用法：.memory health|status|sysinfo|on|off|protect|reset|set heap|rss 数值";

const health = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
  const current = await (await configOf(ctx)).read();
  await ctx.telegram.edit(invocation.message, report(current), {parseMode: "html"});
};
const sysinfo = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
  const current = await (await configOf(ctx)).read();
  const result = await ctx.processes.run("/usr/bin/uptime", [], {timeoutMs: 3000});
  await ctx.telegram.edit(invocation.message, `<b>系统状态</b>\n<code>${result.stdout.toString().trim()}</code>\n\n${report(current)}`, {parseMode: "html"});
};
const toggle = (enabled: boolean) => async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
  await (await configOf(ctx)).update(value => ({...value, enabled}));
  await ctx.telegram.edit(invocation.message, `自动内存保护已${enabled ? "开启" : "关闭"}`);
};
const silent = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
  const value = invocation.args[0] === "on";
  await (await configOf(ctx)).update(current => ({...current, silent: value}));
  await ctx.telegram.edit(invocation.message, `内存通知已${value ? "静默" : "开启"}`);
};
const setThreshold = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
  const target = invocation.args[0];
  const value = parsePositive(invocation.args[1]);
  if (!value || !["heap", "rss"].includes(target ?? "")) {
    await ctx.telegram.edit(invocation.message, "用法：.memory set heap|rss 数值"); return;
  }
  await (await configOf(ctx)).update(current => ({...current, [target!]: value}));
  await ctx.telegram.edit(invocation.message, `已设置 ${target} 上限为 ${value} MB`);
};
const reset = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
  const m = snapshot();
  await (await configOf(ctx)).update(value => ({...value, baselineHeap: m.heap, baselineRss: m.rss}));
  await ctx.telegram.edit(invocation.message, "当前内存已记录为观察起点");
};

const memoryCommand: CommandDefinition = {
  description: "查看内存与系统状态",
  helpArgs: ["help", "h"],
  defaultSubcommand: "health",
  subcommands: {
    health: {
      aliases: ["status", "protect"], group: "查询：",
      description: "查看当前内存、基线与阈值报告",
      args: "",
      handle: health,
    },
    sysinfo: {description: "追加系统运行时间与负载（需要 uptime）", args: "", group: "查询：", handle: sysinfo},
    on: {description: "开启阈值监测，默认关闭", args: "", group: "监测设置：", handle: toggle(true)},
    off: {description: "关闭阈值监测，默认关闭", args: "", group: "监测设置：", handle: toggle(false)},
    silent: {
      group: "监测设置：",
      description: "保存静默开关，默认 off；当前定时任务仅写日志，此设置不改变日志行为",
      args: "on|off",
      arguments: [{name: "on|off", required: true, description: "除 on 以外的值视为 off"}],
      examples: [{args: "silent off"}],
      handle: silent,
    },
    set: {
      group: "监测设置：",
      description: "设置 JS 堆或进程总内存阈值，默认 heap 150 MB、rss 512 MB",
      args: "heap|rss 数值",
      arguments: [
        {name: "heap|rss", required: true, description: "heap 为 JS 已用堆内存，rss 为进程总内存"},
        {name: "数值", required: true, description: "大于 0 的数值，单位 MB"},
      ],
      examples: [{args: "set rss 768"}, {args: "set heap 256"}],
      handle: setThreshold,
    },
    reset: {description: "将当前内存记录为观察基线", args: "", group: "查询：", examples: [{args: "reset"}], handle: reset},
  },
  help: [
    {
      heading: "指标与实际行为：",
      body: "• Heap 是 JS 堆内存；RSS 是进程驻留内存；External 和 ArrayBuffer 展示原生内存与缓冲区占用。\n" +
        "• 阈值须为大于 0 的数值，单位 MB（按 1024 × 1024 字节换算）。超过任一阈值时报告显示“偏高”。\n" +
        "• 开启监测后，每 10 分钟检查一次；超过阈值时记录内存日志。此处的“自动保护”指阈值监测，回收内存及重启需要另行处理。\n" +
        "• reset 只记录基线，阈值和监测开关继续使用原配置。\n• 稍后用 <code>{prefix}memory</code> 观察总占用和基线变化。",
    },
  ],
  async handle(invocation, ctx) {
    await ctx.telegram.edit(invocation.message, usage);
  },
};

export default function createMemory() {
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "memory", description: "内存快照与自动保护",
    renderHelp: prefix => renderCommandHelp("memory", memoryCommand, {
      prefix,
      title: bold("🧠 内存状态与阈值监测"),
      intro: "查看进程内存、记录观察基线，并配置定时监测阈值。",
      footer: ["{prefix}memory help / {prefix}help memory 查看本说明。"],
    }),
    commands: {memory: memoryCommand},
    jobs: {monitor: {cron: "*/10 * * * *", description: "定时记录内存状态", async handle(ctx) {
      const store = await configOf(ctx); const config = await store.read(); const m = snapshot();
      if (config.enabled && (m.heap > config.heap || m.rss > config.rss)) {
        ctx.log.info("memory.threshold", {heap: Math.round(m.heap), rss: Math.round(m.rss)});
      }
    }}},
  });
}
