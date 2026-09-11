import os from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {readFile, statfs} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {getBotName} from "../branding";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition, type PluginContext} from "../sdk";
import {bold, code, concat, text, type Html} from "../ui/text";

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

export function waterline(used: number, total: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0) return "────────";
  const percent = Math.max(0, Math.min(100, used / total * 100));
  const filled = Math.round(percent / 100 * 8);
  return `${"▰".repeat(filled)}${"▱".repeat(8 - filled)}`;
}

function row(label: string, value: string): Html {
  return concat(text("• "), text(label), text(": "), code(value));
}

function capacityRow(label: string, snapshot: CapacitySnapshot | undefined, empty = "不可用"): Html {
  if (!snapshot) return row(label, empty);
  if (snapshot.total === 0) return row(label, "未启用");
  return row(label, `${waterline(snapshot.used, snapshot.total)} ${formatPercent(snapshot.used / snapshot.total * 100)} · ${formatBytes(snapshot.used)} / ${formatBytes(snapshot.total)}`);
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
  const version = snapshot.revision ? `${snapshot.applicationVersion} (${snapshot.revision})` : snapshot.applicationVersion;
  const load = snapshot.loadAverage.slice(0, 3).map(value =>
    Number.isFinite(value) ? value.toFixed(2) : "不可用").join(" / ");
  const processShare = snapshot.systemMemory.total > 0
    ? snapshot.processMemory.rss / snapshot.systemMemory.total * 100 : undefined;
  return concat(
    bold(`📡 ${name} 运行面板`), text("\n"),
    concat(text("🟢 在线 · 本次采样 "), code(`${snapshot.scanDurationMs}ms`)),
    text("\n\n"),
    section("🧩 核心", [
      row(name, version),
      row("运行时", `Node.js ${snapshot.nodeVersion} · Teleproto ${snapshot.teleprotoVersion}`),
      row("进程", `PID ${snapshot.pid} · 在线 ${formatDuration(snapshot.processUptime)}`),
    ]),
    text("\n\n"),
    section("🖥 主机", [
      row("节点", `${snapshot.hostname} · ${snapshot.platform}/${snapshot.arch}`),
      row("系统", snapshot.operatingSystem),
      row("内核", snapshot.kernel),
      row("语言", snapshot.locale),
      row("网络", formatNetworkInterfaces(snapshot.networkInterfaces)),
    ]),
    text("\n\n"),
    section("💓 资源水位", [
      row("CPU", `系统 ${formatPercent(snapshot.cpu.systemPercent)} · ${name} ${formatPercent(snapshot.cpu.processPercent)} · ${snapshot.cpu.logicalCores} 线程`),
      capacityRow("内存", snapshot.systemMemory),
      row(`${name} RSS`, `${formatBytes(snapshot.processMemory.rss)} · ${formatPercent(processShare)}`),
      row("JS Heap", `${formatBytes(snapshot.processMemory.heapUsed)} / ${formatBytes(snapshot.processMemory.heapTotal)}`),
      capacityRow("Swap", snapshot.swap, "当前平台不可用"),
      capacityRow("磁盘", snapshot.disk),
    ]),
    text("\n\n"),
    section("⏱ 时间", [
      row("主机在线", formatDuration(snapshot.hostUptime)),
      row("负载 1 / 5 / 15 分钟", load),
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
        body: "• 核心：MiBot、Node.js、Teleproto、提交版本与进程在线时间。\n" +
          "• 主机：系统、内核、语言环境和活动网络接口。\n" +
          "• 资源：CPU 短时采样，以及内存、Swap、磁盘与系统负载快照。",
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
      await ctx.telegram.edit(invocation.message, renderStatus(await collector(root, ctx.signal, revision)),
        {parseMode: "html", linkPreview: false});
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
