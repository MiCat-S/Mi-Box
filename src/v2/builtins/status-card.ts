import {existsSync} from "node:fs";
import type {StatusSnapshot} from "./status";

type CanvasModule = typeof import("canvas");
type CanvasContext = ReturnType<ReturnType<CanvasModule["createCanvas"]>["getContext"]>;

export const STATUS_CARD_WIDTH = 1600;
export const STATUS_CARD_HEIGHT = 900;

const FONT_FAMILY = "TeleBoxStatusCJK";
const FONT_STACK = `"${FONT_FAMILY}", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Droid Sans Fallback", sans-serif`;
const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\simhei.ttf",
] as const;

let canvasModule: CanvasModule | undefined;
let fontInitialized = false;

function canvas(): CanvasModule {
  if (!canvasModule) canvasModule = require("canvas") as CanvasModule;
  return canvasModule;
}

function ensureFont(): void {
  if (fontInitialized) return;
  fontInitialized = true;
  for (const candidate of FONT_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      canvas().registerFont(candidate, {family: FONT_FAMILY});
      return;
    } catch {}
  }
}

function roundedRect(ctx: CanvasContext, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function setFont(ctx: CanvasContext, size: number, weight = 700): void {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

function fittedText(ctx: CanvasContext, value: string, maximumWidth: number, maximumSize: number, minimumSize: number): string {
  for (let size = maximumSize; size >= minimumSize; size -= 2) {
    setFont(ctx, size);
    if (ctx.measureText(value).width <= maximumWidth) return value;
  }
  setFont(ctx, minimumSize);
  let visible = value;
  while (visible.length && ctx.measureText(`${visible}…`).width > maximumWidth) visible = visible.slice(0, -1);
  return visible ? `${visible}…` : "…";
}

function boundedPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return;
  return Math.max(0, Math.min(100, value));
}

function capacityPercent(value: {readonly used: number; readonly total: number} | undefined): number | undefined {
  if (!value || !Number.isFinite(value.used) || !Number.isFinite(value.total) || value.total < 0) return;
  if (value.total === 0) return 0;
  return boundedPercent(value.used / value.total * 100);
}

function cardDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "不可用";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor(total % 86400 / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const remaining = total % 60;
  const clock = [hours, minutes, remaining].map(value => String(value).padStart(2, "0")).join(":");
  return days ? `${days}天 ${clock}` : clock;
}

function resourceHealth(values: readonly (number | undefined)[]): {readonly label: string; readonly color: string} {
  const maximum = Math.max(0, ...values.filter((value): value is number => value !== undefined));
  if (maximum >= 90) return {label: "资源告警", color: "#fb7185"};
  if (maximum >= 75) return {label: "需要关注", color: "#fbbf24"};
  return {label: "运行正常", color: "#34f59a"};
}

function gaugeColor(value: number | undefined, normal: string): string {
  if (value !== undefined && value >= 90) return "#fb7185";
  if (value !== undefined && value >= 75) return "#fbbf24";
  return normal;
}

function drawRadioMark(ctx: CanvasContext, x: number, y: number): void {
  ctx.save();
  ctx.strokeStyle = "#22d3ee";
  ctx.fillStyle = "#e2e8f0";
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(x, y, 40, Math.PI * 1.08, Math.PI * 1.55);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 22, Math.PI * 1.08, Math.PI * 1.55);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x - 35, y + 32, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawGauge(ctx: CanvasContext, x: number, y: number, label: string, value: number | undefined, color: string): void {
  const width = 336;
  const height = 250;
  roundedRect(ctx, x, y, width, height, 28);
  ctx.fillStyle = "rgba(10, 35, 53, 0.86)";
  ctx.fill();
  ctx.strokeStyle = "rgba(56, 139, 190, 0.48)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const centerX = x + 104;
  const centerY = y + 125;
  const radius = 68;
  ctx.lineCap = "round";
  ctx.lineWidth = 18;
  ctx.strokeStyle = "#213a4d";
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.stroke();
  if (value !== undefined && value > 0) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * value / 100);
    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = "#f1f5f9";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  setFont(ctx, 38, 800);
  ctx.fillText(value === undefined ? "--" : `${Math.round(value)}%`, centerX, centerY + 2);

  ctx.strokeStyle = "rgba(63, 132, 170, 0.55)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + 205, y + 61);
  ctx.lineTo(x + 205, y + height - 61);
  ctx.stroke();
  ctx.textAlign = "left";
  setFont(ctx, label === "Swap" ? 43 : 42, 700);
  ctx.fillText(label, x + 232, centerY + 2);
}

export function renderStatusCard(snapshot: StatusSnapshot, name: string): Buffer {
  ensureFont();
  const surface = canvas().createCanvas(STATUS_CARD_WIDTH, STATUS_CARD_HEIGHT);
  const ctx = surface.getContext("2d");
  const background = ctx.createLinearGradient(0, 0, STATUS_CARD_WIDTH, STATUS_CARD_HEIGHT);
  background.addColorStop(0, "#071927");
  background.addColorStop(0.58, "#071520");
  background.addColorStop(1, "#05111a");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, STATUS_CARD_WIDTH, STATUS_CARD_HEIGHT);

  ctx.strokeStyle = "rgba(39, 103, 139, 0.14)";
  ctx.lineWidth = 1;
  for (let x = 48; x < STATUS_CARD_WIDTH; x += 64) {
    ctx.beginPath(); ctx.moveTo(x, 48); ctx.lineTo(x, STATUS_CARD_HEIGHT - 48); ctx.stroke();
  }
  for (let y = 48; y < STATUS_CARD_HEIGHT; y += 64) {
    ctx.beginPath(); ctx.moveTo(48, y); ctx.lineTo(STATUS_CARD_WIDTH - 48, y); ctx.stroke();
  }

  roundedRect(ctx, 30, 30, STATUS_CARD_WIDTH - 60, STATUS_CARD_HEIGHT - 60, 34);
  ctx.strokeStyle = "#0e83bd";
  ctx.lineWidth = 4;
  ctx.stroke();

  drawRadioMark(ctx, 120, 140);
  ctx.fillStyle = "#f1f5f9";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const title = `${name} · 运行状态`;
  const visibleTitle = fittedText(ctx, title, 595, 68, 42);
  ctx.fillText(visibleTitle, 180, 150);

  ctx.strokeStyle = "#215a78";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(82, 235);
  ctx.lineTo(755, 235);
  ctx.stroke();

  const cpu = boundedPercent(snapshot.cpu.systemPercent);
  const memory = capacityPercent(snapshot.systemMemory);
  const disk = capacityPercent(snapshot.disk);
  const swap = capacityPercent(snapshot.swap);
  const health = resourceHealth([cpu, memory, disk, swap]);
  ctx.save();
  ctx.shadowColor = health.color;
  ctx.shadowBlur = 24;
  ctx.fillStyle = health.color;
  ctx.beginPath();
  ctx.arc(128, 370, 42, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = health.color;
  setFont(ctx, 68, 800);
  ctx.fillText(health.label, 205, 374);

  ctx.fillStyle = "#9fb2c5";
  setFont(ctx, 42, 600);
  ctx.fillText("在线", 88, 555);
  ctx.fillStyle = "#f1f5f9";
  const duration = fittedText(ctx, cardDuration(snapshot.processUptime), 500, 68, 48);
  ctx.fillText(duration, 205, 555);

  drawGauge(ctx, 810, 115, "CPU", cpu, gaugeColor(cpu, "#34f59a"));
  drawGauge(ctx, 1174, 115, "内存", memory, gaugeColor(memory, "#34f59a"));
  drawGauge(ctx, 810, 395, "磁盘", disk, gaugeColor(disk, "#fbbf24"));
  drawGauge(ctx, 1174, 395, "Swap", swap, gaugeColor(swap, "#22d3ee"));

  ctx.strokeStyle = "#215a78";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(82, 732);
  ctx.lineTo(1518, 732);
  ctx.stroke();
  const version = `${name} ${snapshot.applicationVersion}${snapshot.revision ? ` (${snapshot.revision})` : ""}  ·  Node ${snapshot.nodeVersion}  ·  Teleproto ${snapshot.teleprotoVersion}`;
  ctx.fillStyle = "#b8c7d7";
  ctx.textAlign = "center";
  const visibleVersion = fittedText(ctx, version, 1370, 34, 24);
  ctx.fillText(visibleVersion, STATUS_CARD_WIDTH / 2, 805);

  return surface.toBuffer("image/png");
}
