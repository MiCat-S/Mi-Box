type DiagnosticEvent =
  | "status.system_font_failed" | "status.bundled_font_failed"
  | "status.os_release_parse_failed" | "status.os_release_read_failed"
  | "update.changelog_read_failed" | "update.result_read_failed"
  | "update.automatic_result_read_failed" | "update.request_cleanup_failed"
  | "update.version_read_failed" | "update.remote_changelog_failed"
  | "exec.progress_failed";

/** Optional fallback diagnostics accept fixed events only, never private input or errors. */
export function debugDiagnostic(event: DiagnosticEvent): void {
  if (process.env.DEBUG === "1") console.warn(JSON.stringify({level: "debug", event}));
}
