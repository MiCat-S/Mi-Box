import {bold, text, type Html} from "./text";

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

export const MAX_HTML_LENGTH = 3_500;
export const MAX_ENTITIES = 90;
/** Bytes reserved so an appended page label never pushes a page over the budget. */
export const PAGE_LABEL_RESERVE = 16;

/**
 * Unified page suffix for paginated plugin output. It stays empty for a single
 * page so single-page replies keep their original text.
 */
export function pageLabel(index: number, total: number): string {
  return total > 1 ? `\n${index + 1}/${total} 页` : "";
}

export interface PageDelivery {
  readonly published: number;
  readonly total: number;
  readonly interrupted: boolean;
  readonly error?: unknown;
}

/**
 * Deliver paginated content: the first page edits the original message and the
 * rest reply to it. A failure after the first page never overwrites the already
 * published result; the caller reports the interruption separately. Abort
 * reasons are rethrown so the caller can distinguish cancellation.
 */
export async function deliverPages(
  pages: readonly string[],
  signal: AbortSignal,
  send: (page: string, index: number) => Promise<void>,
): Promise<PageDelivery> {
  let published = 0;
  try {
    for (const [index, page] of pages.entries()) {
      signal.throwIfAborted();
      await send(page, index);
      published += 1;
    }
  } catch (error) {
    signal.throwIfAborted();
    return {published, total: pages.length, interrupted: true, error};
  }
  return {published, total: pages.length, interrupted: false};
}

export function interruptedNotice(delivery: PageDelivery): string {
  return `⚠️ 已发送 ${delivery.published}/${delivery.total} 页，后续页发送中断，可重新执行查看`;
}

/**
 * Reduce a delivery failure to a stable category for logging. Never returns a
 * message, URL, credential or arbitrary text: only a short code or class name.
 */
export function deliveryErrorCategory(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as {code?: unknown}).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) return code;
    const name = (error as {name?: unknown}).name;
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(name)) return name;
  }
  return "UNKNOWN";
}

export interface Section {
  readonly heading?: string;
  readonly lines: readonly Html[];
}

export interface DocumentOptions {
  readonly title: string;
  readonly subtitle?: string;
  readonly sections: readonly Section[];
  readonly footer?: string | readonly Html[];
}

interface Block {
  readonly html: string;
  readonly entities: number;
}

const supportedTags = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a",
  "code", "pre", "blockquote", "span", "tg-spoiler", "spoiler", "tg-emoji", "tg-date",
]);

const asHtml = (value: string): Html => value as Html;

export function section(heading: string | undefined, lines: readonly Html[]): Section;
export function section(lines: readonly Html[]): Section;
export function section(value: string | readonly Html[] | undefined, lines?: readonly Html[]): Section {
  return Object.freeze({
    ...(typeof value === "string" ? {heading: value} : {}),
    lines: Object.freeze([...(typeof value === "string" || value === undefined ? lines ?? [] : value)]),
  });
}

function plainBlocks(source: string, reserve = 0): Block[] {
  const result: Block[] = [];
  let html = "";
  const budget = Math.max(1, MAX_HTML_LENGTH - reserve - "<pre></pre>".length);
  // Iterate code points so an astral character can never be split in two.
  for (const character of source) {
    const escaped = escapeHtml(character);
    if (html.length + escaped.length > budget) {
      result.push({html: `<pre>${html}</pre>`, entities: 1});
      html = "";
    }
    html += escaped;
  }
  if (html.trim()) result.push({html: `<pre>${html}</pre>`, entities: 1});
  return result;
}

async function parserTools(reserve = 0) {
  const {parseDocument, DomUtils} = await import("htmlparser2");
  type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
  const serialize = (node: HtmlNode): string => DomUtils.getOuterHTML(node, {encodeEntities: "utf8"});

  const normalize = (source: string): Block[] => {
    if (!source.trim()) return [];
    const document = parseDocument(source);
    const stack: HtmlNode[] = [...document.children];
    let entities = 0;
    let unsupported = false;
    const links = new Set<string>();
    while (stack.length) {
      const node = stack.pop()!;
      if ("attribs" in node) {
        entities += 1;
        if (!supportedTags.has(node.name)) unsupported = true;
        if (node.name === "a" && node.attribs.href) {
          links.add(node.attribs.href);
          try {
            if (!["http:", "https:", "tg:", "mailto:"].includes(new URL(node.attribs.href).protocol)) unsupported = true;
          } catch {
            unsupported = true;
          }
        }
      }
      if ("children" in node) stack.push(...node.children);
    }
    if (unsupported) return [
      {html: "此段包含不支持的格式，以下按文本显示。", entities: 0},
      ...plainBlocks(source, reserve),
    ];
    const html = document.children.map(serialize).join("");
    if (html.length <= MAX_HTML_LENGTH - reserve && entities <= MAX_ENTITIES) return [{html, entities}];
    let plain = DomUtils.textContent(document);
    const addresses = [...links];
    if (addresses.length) plain += `\n链接地址：\n${addresses.join("\n")}`;
    return [
      {html: "此段超出单条消息的长度或格式数量预算，以下以纯文本分段显示。", entities: 0},
      ...plainBlocks(plain, reserve),
    ];
  };

  const description = (source: string): Block[] => {
    const document = parseDocument(source);
    const result: Block[] = [];
    let current = "";
    // Newlines outside tags are block boundaries; formatted elements stay whole.
    for (const node of document.children) {
      if (node.type !== "text") {
        current += serialize(node);
        continue;
      }
      const lines = node.data.split("\n");
      current += escapeHtml(lines[0]);
      for (const line of lines.slice(1)) {
        result.push(...normalize(current));
        current = escapeHtml(line);
      }
    }
    result.push(...normalize(current));
    return result;
  };

  return {normalize, description};
}

/**
 * Parse trusted plugin-authored rich text through the same allowlist and
 * bounded fallback path as documents. This is intentionally not rawHtml: an
 * unsupported tag or URL is rendered as escaped text.
 */
export async function richText(source: string): Promise<readonly Html[]> {
  const {description} = await parserTools();
  return description(source).map(block => asHtml(block.html));
}

/** Preserve complete authored help while respecting Telegram message budgets. */
export async function renderRichText(source: string, reserve = 0): Promise<readonly string[]> {
  const {description} = await parserTools(reserve);
  return paginate(description(source), reserve);
}

function appendBlocks(target: Block[], source: string, normalize: (source: string) => Block[]): void {
  // Generated Html is normalized once, never escaped a second time, and
  // complete tags remain page-local.
  target.push(...normalize(source));
}

function paginate(blocks: readonly Block[], reserve = 0): string[] {
  const result: string[] = [];
  let html = "";
  let entities = 0;
  const limit = Math.max(1, MAX_HTML_LENGTH - reserve);
  for (const block of blocks) {
    if (!block.html.trim()) continue;
    if (html && (html.length + 1 + block.html.length > limit || entities + block.entities > MAX_ENTITIES)) {
      result.push(html);
      html = "";
      entities = 0;
    }
    html += `${html ? "\n" : ""}${block.html}`;
    entities += block.entities;
  }
  if (html) result.push(html);
  return result;
}

export async function renderDocument(options: DocumentOptions, reserve = 0): Promise<readonly string[]> {
  const tools = await parserTools(reserve);
  const blocks: Block[] = [];
  appendBlocks(blocks, bold(options.title), tools.normalize);
  if (options.subtitle) appendBlocks(blocks, text(options.subtitle), tools.normalize);
  for (const [index, item] of options.sections.entries()) {
    if (item.heading) appendBlocks(blocks, `${index ? "\n" : ""}${bold(item.heading)}`, tools.normalize);
    for (const line of item.lines) appendBlocks(blocks, line, tools.normalize);
  }
  if (options.footer) {
    if (typeof options.footer === "string") appendBlocks(blocks, `\n${text(options.footer)}`, tools.normalize);
    else for (const [index, line] of options.footer.entries()) {
      appendBlocks(blocks, `${index ? "" : "\n"}${line}`, tools.normalize);
    }
  }
  return paginate(blocks, reserve);
}
