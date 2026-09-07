/** A Telegram HTML fragment created by one of the safe UI builders. */
export type Html = string & {readonly __teleboxHtml: unique symbol};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
})[character]!);

const html = (value: string): Html => value as Html;

/** Escape ordinary text before it is sent with Telegram HTML parsing enabled. */
export function text(value: string): Html {
  return html(escapeHtml(value));
}

export function bold(value: string): Html {
  return html(`<b>${escapeHtml(value)}</b>`);
}

export function code(value: string): Html {
  return html(`<code>${escapeHtml(value)}</code>`);
}

export function field(label: string, value: string | number | boolean): Html {
  return html(`<b>${escapeHtml(label)}</b>: <code>${escapeHtml(String(value))}</code>`);
}

export function command(prefix: string, name: string, args?: string | readonly string[]): Html {
  const suffix = Array.isArray(args) ? args.join(" ") : args ?? "";
  return code(`${prefix}${name}${suffix ? ` ${suffix}` : ""}`);
}

export function link(url: string, label = url): Html {
  let protocol: string;
  try { protocol = new URL(url).protocol; }
  catch { throw new Error("Invalid UI link"); }
  if (!["http:", "https:", "tg:", "mailto:"].includes(protocol)) throw new Error("Invalid UI link");
  return html(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`);
}

/**
 * Join already-safe fragments. Plain strings are deliberately not accepted by
 * the type signature; callers must pass text(), code(), bold(), or another
 * safe builder instead of introducing an HTML escape hatch.
 */
export function concat(...parts: readonly Html[]): Html {
  return html(parts.join(""));
}
