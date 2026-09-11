#!/bin/bash
set -euo pipefail
umask 077

write_result() {
  node -e '
const fs = require("fs");
const [status, reason, target] = process.argv.slice(1);
fs.writeFileSync(target, JSON.stringify({status, reason}), {encoding: "utf8", mode: 0o600});
fs.chmodSync(target, 0o600);
' "$1" "$2" "$result_file"
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
  status="failed"
  reason="更新服务异常退出"
  mkdir -p "$root/temp"
  trap 'if [[ "$status" != "success" ]]; then write_result "$status" "$reason"; fi' EXIT

  acquire_update_lock

  before=$(git rev-parse HEAD)
  run_step "拉取代码" git pull --ff-only origin main
  after=$(git rev-parse HEAD)

  if [[ "$before" != "$after" || ! -d node_modules ]]; then
    run_step "安装依赖" npm ci
  fi
  run_step "构建主程序" npm run build:v2
  run_step "打包插件与运行时" npm run package:v2
  run_step "运行运行时自检" npm run check:v2
  run_step "重启主服务" systemctl restart mibot.service

  status="success"
  reason=""
  write_result "success" ""
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
