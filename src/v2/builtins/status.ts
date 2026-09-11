import os from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {readFile, statfs} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {getBotName} from "../branding";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type PluginContext} from "../sdk";
import {CustomFile} from "teleproto/client/uploads.js";
import {bold, code, concat, text, type Html} from "../ui/text";
import {renderStatusCard} from "./status-card";

export interface ProcessMemorySnapshot {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
}

export interface CapacitySnapshot {
  readonly used: number;
  readonly total: number;
}

export interface CpuSnapshot {
  readonly systemPercent?: number;
  readonly processPercent?: number;
  readonly logicalCores: number;
}

export interface StatusSnapshot {
  readonly applicationVersion: string;
  readonly revision?: string;
  readonly teleprotoVersion: string;
  readonly nodeVersion: string;
  readonly hostname: string;
  readonly operatingSystem: string;
  readonly platform: string;
  readonly arch: string;
  readonly kernel: string;
  readonly locale: string;
  readonly pid: number;
  readonly processUptime: number;
  readonly hostUptime?: number;
  readonly processMemory: ProcessMemorySnapshot;
  readonly systemMemory: CapacitySnapshot;
  readonly swap?: CapacitySnapshot;
  readonly disk?: CapacitySnapshot;
  readonly cpu: CpuSnapshot;
  readonly loadAverage: readonly number[];
  readonly networkInterfaces: readonly string[];
  readonly scanDurationMs: number;
}

interface CpuCounters {
  readonly idle: number;
  readonly total: number;
  readonly logicalCores: number;
}

type RevisionReader = (signal: AbortSignal) => Promise<string | undefined>;
type StatusCollector = (root: string, signal: AbortSignal, revision: RevisionReader) => Promise<StatusSnapshot>;

function cpuCounters(): CpuCounters {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return {idle, total, logicalCores: cpus.length};
}

function boundedPercent(value: number): number | undefined {
  if (!Number.isFinite(value)) return;
  return Math.max(0, Math.min(100, value));
}

function sampledCpu(before: CpuCounters, after: CpuCounters, processMicros: number, wallMicros: number): CpuSnapshot {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  const logicalCores = Math.max(1, after.logicalCores);
  return Object.freeze({
    systemPercent: total > 0 ? boundedPercent((1 - idle / total) * 100) : undefined,
    processPercent: wallMicros > 0 ? boundedPercent(processMicros / wallMicros / logicalCores * 100) : undefined,
    logicalCores,
  });
}

async function jsonVersion(file: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as {version?: unknown};
    return typeof value.version === "string" && value.version.trim() ? value.version : "不可用";
  } catch {
    return "不可用";
  }
}

export function parseOsRelease(source: string): string | undefined {
  const row = source.split(/\r?\n/).find(line => line.startsWith("PRETTY_NAME="));
  if (!row) return;
  const value = row.slice("PRETTY_NAME=".length).trim();
  if (!value) return;
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch {}
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

async function operatingSystem(): Promise<string> {
  if (process.platform === "linux") {
    try {
      const name = parseOsRelease(await readFile("/etc/os-release", "utf8"));
      if (name) return name;
    } catch {}
  }
  return `${os.type()} ${os.release()}`;
}

export function parseSwap(source: string): CapacitySnapshot | undefined {
  const values = new Map<string, number>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^(SwapTotal|SwapFree):\s+(\d+)\s+kB$/i.exec(line.trim());
    if (match) values.set(match[1].toLowerCase(), Number(match[2]) * 1024);
  }
  const total = values.get("swaptotal");
  const free = values.get("swapfree");
  if (total === undefined || free === undefined) return;
  return Object.freeze({used: Math.max(0, total - free), total});
}

export function parseSystemMemory(source: string): CapacitySnapshot | undefined {
  const values = new Map<string, number>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^(MemTotal|MemAvailable|MemFree):\s+(\d+)\s+kB$/i.exec(line.trim());
    if (match) values.set(match[1].toLowerCase(), Number(match[2]) * 1024);
  }
  const total = values.get("memtotal");
  const available = values.get("memavailable") ?? values.get("memfree");
  if (total === undefined || available === undefined) return;
  return Object.freeze({used: Math.max(0, total - available), total});
}

async function linuxMemorySnapshot(): Promise<{
  readonly systemMemory?: CapacitySnapshot;
  readonly swap?: CapacitySnapshot;
} | undefined> {
  if (process.platform !== "linux") return;
  try {
    const source = await readFile("/proc/meminfo", "utf8");
    return Object.freeze({systemMemory: parseSystemMemory(source), swap: parseSwap(source)});
  } catch {
    return;
  }
}

async function diskSnapshot(root: string): Promise<CapacitySnapshot | undefined> {
  try {
    const value = await statfs(root);
    const blockSize = Number(value.bsize);
    const total = Number(value.blocks) * blockSize;
    const free = Number(value.bfree) * blockSize;
    if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return;
    return Object.freeze({used: Math.max(0, total - free), total});
  } catch {
    return;
  }
}

function activeNetworkInterfaces(): readonly string[] {
  const active = Object.entries(os.networkInterfaces())
    .filter(([, addresses]) => addresses?.some(address => !address.internal))
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
  return Object.freeze(active);
}

function hostUptime(): number | undefined {
  try {
    const value = os.uptime();
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
  } catch {
    return;
  }
}

export async function collectStatus(root: string, signal: AbortSignal, revision: RevisionReader): Promise<StatusSnapshot> {
  signal.throwIfAborted();
  const scanStarted = performance.now();
  const cpuBefore = cpuCounters();
  const processBefore = process.cpuUsage();
  const cpuStarted = performance.now();
  const metadata = Promise.all([
    jsonVersion(path.join(root, "package.json")),
    jsonVersion(path.join(root, "node_modules", "teleproto", "package.json")),
    operatingSystem(),
    linuxMemorySnapshot(),
    diskSnapshot(root),
    revision(signal),
  ]);
  await delay(160, undefined, {signal});
  const cpuAfter = cpuCounters();
  const processDelta = process.cpuUsage(processBefore);
  const cpuElapsedMicros = (performance.now() - cpuStarted) * 1000;
  const [applicationVersion, teleprotoVersion, osName, linuxMemory, disk, commit] = await metadata;
  signal.throwIfAborted();
  const memory = process.memoryUsage();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  return Object.freeze({
    applicationVersion,
    revision: commit,
    teleprotoVersion,
    nodeVersion: process.version,
    hostname: os.hostname(),
    operatingSystem: osName,
    platform: process.platform,
    arch: process.arch,
    kernel: `${os.type()} ${os.release()}`,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    pid: process.pid,
    processUptime: Math.floor(process.uptime()),
    hostUptime: hostUptime(),
    processMemory: Object.freeze({rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal}),
    systemMemory: linuxMemory?.systemMemory ??
      Object.freeze({used: Math.max(0, totalMemory - freeMemory), total: totalMemory}),
    swap: linuxMemory?.swap,
    disk,
    cpu: sampledCpu(cpuBefore, cpuAfter, processDelta.user + processDelta.system, cpuElapsedMicros),
    loadAverage: Object.freeze([...os.loadavg()]),
    networkInterfaces: activeNetworkInterfaces(),
    scanDurationMs: Math.max(0, Math.round(performance.now() - scanStarted)),
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "不可用";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "不可用";
  const total = Math.floor(seconds);
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

export function formatPercent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "不可用" : `${value.toFixed(1)}%`;
}

function row(label: string, value: string): Html {
  return concat(text("• "), text(label), text(": "), code(value));
}

function section(title: string, rows: readonly Html[]): Html {
  return concat(bold(title), text("\n"), ...rows.flatMap((value, index) => index ? [text("\n"), value] : [value]));
}

function formatNetworkInterfaces(names: readonly string[]): string {
  if (!names.length) return "仅回环或不可用";
  const visible = names.slice(0, 4).join(" · ");
  return names.length > 4 ? `${visible} · 另 ${names.length - 4} 个` : visible;
}

export function renderStatus(snapshot: StatusSnapshot): Html {
  const name = getBotName();
  const load = snapshot.loadAverage.slice(0, 3).map(value =>
    Number.isFinite(value) ? value.toFixed(2) : "不可用").join(" / ");
  const processShare = snapshot.systemMemory.total > 0
    ? snapshot.processMemory.rss / snapshot.systemMemory.total * 100 : undefined;
  return concat(
    section("🖥 主机", [
      row("节点", `${snapshot.hostname} · ${snapshot.platform}/${snapshot.arch}`),
      row("系统", snapshot.operatingSystem),
      row("内核", snapshot.kernel),
      row("语言", snapshot.locale),
      row("网络", formatNetworkInterfaces(snapshot.networkInterfaces)),
    ]),
    text("\n\n"),
    section("🧠 进程", [
      row("进程", `PID ${snapshot.pid} · ${snapshot.cpu.logicalCores} 线程`),
      row(`${name} CPU`, formatPercent(snapshot.cpu.processPercent)),
      row(`${name} RSS`, `${formatBytes(snapshot.processMemory.rss)} · ${formatPercent(processShare)}`),
      row("JS Heap", `${formatBytes(snapshot.processMemory.heapUsed)} / ${formatBytes(snapshot.processMemory.heapTotal)}`),
    ]),
    text("\n\n"),
    section("⏱ 运行详情", [
      row("主机在线", formatDuration(snapshot.hostUptime)),
      row("负载 1 / 5 / 15 分钟", load),
      row("状态采样", `${snapshot.scanDurationMs}ms`),
    ]),
  );
}

export default function createStatus(root = process.cwd(), collector: StatusCollector = collectStatus) {
  const statusCommand: CommandDefinition = {
    description: "查看运行状态面板",
    args: "",
    arguments: [],
    examples: [{args: "", description: "查看核心版本、主机信息与资源水位"}],
    help: [
      {
        heading: "输出内容",
        body: "• 图片：运行状态、进程在线时间、核心版本，以及 CPU、内存、Swap、磁盘水位。\n" +
          "• 图片说明：主机、系统、内核、网络、进程内存、负载与采样耗时。",
      },
      {
        heading: "说明",
        body: "CPU 采样约 160ms；其他信息只读取本机状态。Git、Linux Swap 等平台能力不可用时会显示降级结果。",
      },
    ],
    async handle(invocation, ctx) {
      const revision: RevisionReader = async signal => {
        try {
          const result = await ctx.processes.run("/usr/bin/git", ["-C", root, "rev-parse", "--short=7", "HEAD"],
            {timeoutMs: 1200, maxOutputBytes: 128, signal});
          const value = result.stdout.toString("utf8").trim();
          return /^[0-9a-f]{7}$/i.test(value) ? value : undefined;
        } catch {
          return;
        }
      };
      try {
        const snapshot = await collector(root, ctx.signal, revision);
        const card = renderStatusCard(snapshot, getBotName());
        const raw = invocation.message.raw as {peerId?: unknown; inputChat?: unknown; delete?: (options?: {revoke?: boolean}) => Promise<unknown>} | undefined;
        if (!raw?.peerId) throw new Error("Status message context unavailable");
        await ctx.telegram.withClient(async (client, signal) => {
          signal.throwIfAborted();
          const file = new CustomFile("mibot-status.png", card.length, "", card);
          await client.sendFile((raw.inputChat ?? raw.peerId) as never, {file, caption: renderStatus(snapshot), parseMode: "html",
            forceDocument: false, ...(invocation.message.topicId ? {topMsgId: invocation.message.topicId} : {})});
          try { await raw.delete?.({revoke: true}); }
          catch { ctx.log.error("status_command_delete_failed"); }
        });
      } catch {
        ctx.log.error("status_card_failed");
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "状态面板生成或发送失败，请稍后重试");
      }
    },
  };

  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "status",
    description: "查看核心、主机与资源运行面板",
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 1500, maxOutputBytes: 256}},
    commands: {status: statusCommand},
  });
}
