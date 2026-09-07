import {isIP} from "node:net";

export interface IpPrivacy {mode: "mask" | "hide"; ipv4Segments: number; ipv6Segments: number;}
const defaults: IpPrivacy = {mode: "mask", ipv4Segments: 2, ipv6Segments: 4};
let policy: Readonly<IpPrivacy> = Object.freeze({...defaults});
export function getIpPrivacy(): Readonly<IpPrivacy> {return policy;}
export function setIpPrivacy(value: IpPrivacy): void {
  if (!["mask", "hide"].includes(value.mode) || !Number.isInteger(value.ipv4Segments) || value.ipv4Segments < 1 || value.ipv4Segments > 4
    || !Number.isInteger(value.ipv6Segments) || value.ipv6Segments < 1 || value.ipv6Segments > 8) throw new Error("IP_PRIVACY_CONFIG");
  policy = Object.freeze({...value});
}
interface Replacement {start: number; end: number; value: string;}
function ipv6Groups(address: string): string[] {
  let source = address.split("%")[0];
  if (source.includes(".")) {
    const index = source.lastIndexOf(":");
    const bytes = source.slice(index + 1).split(".").map(Number);
    source = source.slice(0, index + 1) + ((bytes[0] << 8) + bytes[1]).toString(16) + ":" + ((bytes[2] << 8) + bytes[3]).toString(16);
  }
  const [left, right] = source.split("::");
  const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
  return right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
}
function replacements(text: string, config: Readonly<IpPrivacy>): Replacement[] {
  const matches: Replacement[] = [];
  const patterns = [/(?<![\w:])(?:[a-f\d]{0,4}:){2,}[a-f\d:.]*(?:%[\w.-]+)?(?![\w:])/gi, /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)/g];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const address = match[0].replace(/[.]+$/, "");
    const version = isIP(address);
    if (!version || matches.some(item => match.index < item.end && match.index + address.length > item.start)) continue;
    const parts = version === 4 ? address.split(".") : ipv6Groups(address);
    const count = version === 4 ? config.ipv4Segments : config.ipv6Segments;
    const value = config.mode === "hide" ? "[IP已隐藏]" : parts.map((part, index) => index >= parts.length - count ? "*" : part).join(version === 4 ? "." : ":");
    matches.push({start: match.index, end: match.index + address.length, value});
  }
  return matches.sort((a, b) => a.start - b.start);
}
export function maskIpText(text: string, config = getIpPrivacy()): string {
  let result = "", start = 0;
  for (const item of replacements(text, config)) {result += text.slice(start, item.start) + item.value; start = item.end;}
  return result + text.slice(start);
}
function copy<T extends object>(value: T): T {return Object.assign(Object.create(Object.getPrototypeOf(value)), value);}
type Entity = {offset: number; length: number; url?: string; className?: string};
function ipLink(value: string): boolean {
  let decoded = value;
  try {decoded = decodeURIComponent(value);} catch {}
  if (maskIpText(decoded) !== decoded) return true;
  try {return isIP(new URL(decoded).hostname.replace(/^\[|\]$/g, "")) !== 0;} catch {return false;}
}
export function redactMessage<T extends {message?: string; entities?: Entity[]}>(source: T): T {
  const output = copy(source);
  const original = source.message;
  if (typeof original !== "string") return output;
  const changes = replacements(original, getIpPrivacy());
  output.message = maskIpText(original);
  const position = (offset: number, end: boolean): number => {
    let shift = 0;
    for (const item of changes) {
      if (offset <= item.start) break;
      if (offset < item.end) return item.start + shift + (end ? item.value.length : 0);
      shift += item.value.length - (item.end - item.start);
    }
    return offset + shift;
  };
  if (source.entities) output.entities = source.entities.filter(entity => !(entity.url && ipLink(entity.url))
    && !(entity.className === "MessageEntityUrl" && ipLink(original.slice(entity.offset, entity.offset + entity.length)))).map(entity => {
    const next = copy(entity);
    next.offset = position(entity.offset, false);
    next.length = position(entity.offset + entity.length, true) - next.offset;
    return next;
  }).filter(entity => entity.length > 0);
  return output;
}

function redactMedia(source: unknown): unknown {
  if (!source || typeof source !== "object") return source;
  const media = copy(source) as Record<string, unknown>;
  if (Array.isArray(media.attributes)) media.attributes = media.attributes.map(attribute => {
    if (attribute?.className !== "DocumentAttributeFilename") return attribute;
    const next = copy(attribute) as {fileName: string};
    next.fileName = maskIpText(next.fileName); return next;
  });
  if (media.file && typeof media.file === "object" && "name" in media.file && typeof media.file.name === "string") {
    media.file = Object.assign(copy(media.file), {name: maskIpText(media.file.name)});
  }
  return media;
}
function redactMarkup(source: unknown): unknown {
  if (!source || typeof source !== "object" || !("rows" in source) || !Array.isArray(source.rows)) return source;
  const markup = copy(source) as {rows: {buttons?: unknown[]}[]};
  markup.rows = source.rows.map(row => {
    if (!Array.isArray(row.buttons)) return row;
    const next = copy(row) as {buttons: Record<string, unknown>[]};
    next.buttons = row.buttons.filter((button: {url?: string; type?: {url?: string}}) =>
      !(button.url && ipLink(button.url)) && !(button.type?.url && ipLink(button.type.url))).map((button: {text?: string}) => {
      const next = copy(button); if (typeof next.text === "string") next.text = maskIpText(next.text); return next;
    });
    return next;
  }).filter(row => !Array.isArray(row.buttons) || row.buttons.length);
  return markup.rows.length ? markup : undefined;
}

/** Intercepts final TL message fields after HTML/Markdown parsing, including direct client calls. */
const installations = new WeakSet<object>();
export function installIpPrivacy(client: object): () => void {
  if (installations.has(client)) throw new Error("IP_PRIVACY_ALREADY_INSTALLED");
  const target = client as {invoke(request: unknown, ...args: unknown[]): Promise<unknown>};
  const original = target.invoke;
  const descriptor = Object.getOwnPropertyDescriptor(target, "invoke");
  const outgoing = new Set(["messages.SendMessage", "messages.EditMessage", "messages.SendMedia", "messages.SendMultiMedia", "messages.EditInlineBotMessage"]);
  const wrapper = async function(this: unknown, request: unknown, ...args: unknown[]): Promise<unknown> {
    let value = request;
    if (request && typeof request === "object" && "className" in request && outgoing.has(String(request.className))) {
      const body = request as {message?: string; entities?: Entity[]; multiMedia?: {message?: string; entities?: Entity[]; media?: unknown}[]; media?: unknown; replyMarkup?: unknown; noWebpage?: boolean};
      const next = redactMessage(body);
      if (body.multiMedia) next.multiMedia = body.multiMedia.map(item => Object.assign(redactMessage(item), {media: redactMedia(item.media)}));
      if (body.media) next.media = redactMedia(body.media);
      if (body.replyMarkup) next.replyMarkup = redactMarkup(body.replyMarkup);
      // A remote preview can expose content that isn't represented in the local text.
      if (next.message !== body.message || body.entities?.some(entity => entity.url && ipLink(entity.url))) next.noWebpage = true;
      value = next;
    }
    return original.call(this, value, ...args);
  };
  target.invoke = wrapper;
  installations.add(client);
  return () => {installations.delete(client); if (target.invoke === wrapper) {if (descriptor) Object.defineProperty(target, "invoke", descriptor); else delete (target as Partial<typeof target>).invoke;}};
}
