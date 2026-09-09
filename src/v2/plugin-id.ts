/**
 * Canonical plugin identifier rules shared by the SDK, releases, TPM and the
 * repository builder. The declared id may contain upper case letters and may
 * start with a digit; user input is resolved case-insensitively to the declared
 * id so stored configuration keys never change spelling.
 */
export const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isPluginId(value: string): boolean {
  return PLUGIN_ID_PATTERN.test(value);
}

export type PluginIdResolution =
  | {readonly id: string}
  | {readonly error: "NOT_FOUND" | "AMBIGUOUS"};

/**
 * Resolve a user supplied name against the declared ids. An exact match always
 * wins; otherwise a single case-insensitive match is accepted. Two ids that
 * only differ by case are reported as ambiguous instead of silently picking one.
 */
export function resolvePluginId(input: string, ids: readonly string[]): PluginIdResolution {
  if (ids.includes(input)) return {id: input};
  const matches = ids.filter(id => id.toLowerCase() === input.toLowerCase());
  if (!matches.length) return {error: "NOT_FOUND"};
  if (matches.length > 1) return {error: "AMBIGUOUS"};
  return {id: matches[0]};
}
