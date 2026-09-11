#!/bin/bash
set -euo pipefail
umask 077

write_result() {
  node -e '
const fs = require("fs");
const [status, reason, target, requestId] = process.argv.slice(1);
const result = {status, reason};
if (requestId) result.requestId = requestId;
const temporary = `${target}.tmp.${process.pid}`;
fs.writeFileSync(temporary, JSON.stringify(result), {encoding: "utf8", mode: 0o600});
fs.renameSync(temporary, target);
' "$1" "$2" "$result_file" "$request_id"
}

run_step() {
  local step="$1"
  shift
  local output code
  if output=$("$@" 2>&1); then
    return 0
  else
    code=$?
    status="failed"
    reason="${step}失败（退出码 ${code}）：${output}"
    write_result "$status" "$reason"
    exit "$code"
  fi
}

acquire_update_lock() {
  if ! mkdir -p /run/lock; then
    reason="无法创建 /run/lock，可能缺少 systemd 服务权限"
    return 1
  fi
  exec 9>/run/lock/mibot-update.lock
  if ! flock -n 9; then
    reason="已有更新任务正在执行，请等待其结束后重试"
    return 3
  fi
}

main() {
  local usage='Usage: bash scripts/update-service.sh [--root DIRECTORY | REPOSITORY_DIRECTORY]'
  if [[ $# == 1 && "$1" == --help ]]; then printf '%s\n' "$usage"; return 0; fi
  if [[ "${1:-}" == --root ]]; then
    [[ $# == 2 && -n "$2" && "$2" != --* ]] || { echo "$usage" >&2; return 2; }
    shift
  fi
  [[ $# == 0 || ( $# == 1 && -n "$1" && "$1" != --* ) ]] || { echo "$usage" >&2; return 2; }
  root=${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)}
  root=$(cd -- "$root" && pwd -P)
  git -C "$root" rev-parse --is-inside-work-tree >/dev/null
  cd "$root"
  result_file="$root/temp/update-result.json"
  request_file="$root/temp/update-request.json"
  request_claim="$root/temp/update-request.claim.$$"
  request_id=""
  status="failed"
  reason="更新服务异常退出"
  mkdir -p "$root/temp"

  acquire_update_lock

  if mv "$request_file" "$request_claim" 2>/dev/null; then
    request_id=$(node -e '
const fs = require("fs");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof value.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.requestId)) process.stdout.write(value.requestId);
} catch {}
' "$request_claim")
    rm -f "$request_claim"
  fi
  trap 'if [[ "$status" != "success" ]]; then write_result "$status" "$reason"; fi' EXIT

  run_step "拉取代码" git pull --ff-only origin main
  dependency_fingerprint=$(node -e '
const fs = require("fs");
const crypto = require("crypto");
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$root/package-lock.json")
  dependency_marker="$root/node_modules/.mibot-package-lock.sha256"
  installed_fingerprint=""
  if [[ -f "$dependency_marker" ]]; then installed_fingerprint=$(<"$dependency_marker"); fi
  if [[ ! -d node_modules || "$installed_fingerprint" != "$dependency_fingerprint" ]]; then
    run_step "安装依赖" npm ci
    run_step "记录依赖状态" node -e '
const fs = require("fs");
const [target, fingerprint] = process.argv.slice(1);
const temporary = `${target}.tmp.${process.pid}`;
fs.writeFileSync(temporary, fingerprint + "\n", {encoding: "utf8", mode: 0o600});
fs.renameSync(temporary, target);
' "$dependency_marker" "$dependency_fingerprint"
  fi
  run_step "构建主程序" npm run package:v2
  run_step "运行运行时自检" npm run check:v2
  run_step "重启主服务" systemctl restart mibot.service

  status="success"
  reason=""
  write_result "success" ""
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
