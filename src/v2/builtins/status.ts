import os from "node:os";
import {getBotName} from "../branding";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";
import {bold, code, concat, field, text, type Html} from "../ui/text";

export interface ProcessMemorySnapshot {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
}

export interface SystemMemorySnapshot {
  readonly total: number;
  readonly free: number;
}

export interface StatusSnapshot {
  readonly uptime: number;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly pid: number;
  readonly processMemory: ProcessMemorySnapshot;
  readonly systemMemory: SystemMemorySnapshot;
  readonly loadAverage: readonly number[];
}

export function collectStatus(): StatusSnapshot {
  const memory = process.memoryUsage();
  return Object.freeze({
    uptime: Math.floor(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    processMemory: Object.freeze({
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
    }),
    systemMemory: Object.freeze({total: os.totalmem(), free: os.freemem()}),
    loadAverage: Object.freeze([...os.loadavg()]),
  });
}

/** Keep all memory rows in the same unit so snapshots are easy to compare. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "不可用";
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
  if (total < 60) return `${total}秒`;
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  if (minutes < 60) return `${minutes}分钟${remainingSeconds ? ` ${remainingSeconds}秒` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}小时${remainingMinutes ? ` ${remainingMinutes}分钟` : ""}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}天${remainingHours ? ` ${remainingHours}小时` : ""}${remainingMinutes ? ` ${remainingMinutes}分钟` : ""}`;
}

function lines(...values: readonly Html[]): Html {
  const result: Html[] = [];
  values.forEach((value, index) => {
    if (index) result.push(text("\n"));
    result.push(value);
  });
  return concat(...result);
}

export function renderStatus(snapshot: StatusSnapshot): Html {
  const processMemory = snapshot.processMemory;
  const systemMemory = snapshot.systemMemory;
  const used = Math.max(0, systemMemory.total - systemMemory.free);
  const load = snapshot.loadAverage.slice(0, 3).map(value =>
    Number.isFinite(value) ? value.toFixed(2) : "不可用").join(" / ");
  return concat(
    bold(`${getBotName()} 状态`), text("\n\n"),
    lines(
      bold("运行环境"),
      field("运行时间", formatDuration(snapshot.uptime)),
      field("Node", snapshot.nodeVersion),
      field("平台", `${snapshot.platform}/${snapshot.arch}`),
      field("PID", snapshot.pid),
    ),
    text("\n\n"),
    lines(
      bold("进程内存"),
      field("RSS", formatBytes(processMemory.rss)),
      field("JS Heap", `${formatBytes(processMemory.heapUsed)} / ${formatBytes(processMemory.heapTotal)}`),
      field("External", formatBytes(processMemory.external)),
    ),
    text("\n\n"),
    lines(
      bold("系统资源"),
      field("系统内存", `${formatBytes(used)} / ${formatBytes(systemMemory.total)}（剩余 ${formatBytes(systemMemory.free)}）`),
      concat(code("负载（1 / 5 / 15 分钟）"), text(": "), code(load)),
    ),
  );
}

const statusCommand: CommandDefinition = {
  description: "查看运行状态",
  args: "",
  arguments: [],
  examples: [{args: "", description: "查看当前运行环境、进程内存和系统资源"}],
  help: [
    {
      heading: "输出内容",
      body: "• 运行环境：运行时间、Node 版本、平台、PID。\n" +
        "• 进程内存：RSS、JS Heap、External。\n" +
        "• 系统资源：系统内存占用与 1 / 5 / 15 分钟负载。",
    },
    {heading: "说明", body: "快照来自当前进程与主机，不发起额外采样或网络请求。"},
  ],
  async handle(invocation, ctx) {
    await ctx.telegram.edit(invocation.message, renderStatus(collectStatus()), {parseMode: "html", linkPreview: false});
  },
};

export default function createStatus() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "status", description: "查看运行状态",
    commands: {status: statusCommand},
  });
}
