let displayName = "MiBot";

export function getBotName(): string { return displayName; }

export function setBotName(value: string): void {
  const name = value.trim();
  if (!name || [...name].length > 48 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("名称须为 1–48 个字符，不能包含换行或控制字符");
  }
  displayName = name;
}

export function brandText(text: string, html = true): string {
  const name = html ? displayName.replace(/[&<>"']/g,
    char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]!) : displayName;
  return text.replace(/MiBot/g, () => name);
}
