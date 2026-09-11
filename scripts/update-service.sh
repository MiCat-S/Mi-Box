#!/bin/bash
set -euo pipefail
umask 077

write_result() {
  local result_automatic_id="$automatic_id"
  if [[ "$trigger" == "automatic" && "$automatic_id" =~ ^[0-9a-f]{64}$ ]]; then
    result_automatic_id=$(automatic_id_for "$automatic_id" "$1")
  fi
  node -e '
const fs = require("fs");
const [status, reason, target, requestId, previousVersion, currentVersion,
  previousRevision, currentRevision, trigger, automaticId] = process.argv.slice(1);
const result = {status, reason};
if (requestId) result.requestId = requestId;
const version = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const revision = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;
if (version.test(previousVersion)) result.previousVersion = previousVersion;
if (version.test(currentVersion)) result.currentVersion = currentVersion;
if (revision.test(previousRevision)) result.previousRevision = previousRevision;
if (revision.test(currentRevision)) result.currentRevision = currentRevision;
if (trigger === "automatic" && /^[0-9a-f]{64}$/i.test(automaticId)) {
  result.trigger = trigger;
  result.automaticId = automaticId;
}
const temporary = `${target}.tmp.${process.pid}`;
fs.writeFileSync(temporary, JSON.stringify(result), {encoding: "utf8", mode: 0o600});
fs.renameSync(temporary, target);
' "$1" "$2" "$result_file" "$request_id" "$previous_version" "$current_version" \
  "$previous_revision" "$current_revision" "$trigger" "$result_automatic_id"
}

read_version() {
  node -e '
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version;
if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value)) process.exit(1);
process.stdout.write(value);
' "$1"
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
    exit "$code"
  fi
}

automatic_id_for() {
  node -e '
const crypto = require("crypto");
process.stdout.write(crypto.createHash("sha256").update(process.argv.slice(1).join("\0")).digest("hex"));
' "$@"
}

write_dependency_marker() {
  node -e '
const fs = require("fs");
const [target, fingerprint] = process.argv.slice(1);
const temporary = `${target}.tmp.${process.pid}`;
fs.writeFileSync(temporary, fingerprint + "\n", {encoding: "utf8", mode: 0o600});
fs.renameSync(temporary, target);
' "$1" "$2"
}

wait_for_runtime_ready() {
  local invocation output
  invocation=$(systemctl show mibot.service -p InvocationID --value) || return $?
  [[ "$invocation" =~ ^[0-9a-f]{32}$ ]] || { printf '%s\n' "无法读取主服务启动标识" >&2; return 1; }
  for ((attempt=0; attempt<30; attempt++)); do
    output=$(journalctl "_SYSTEMD_INVOCATION_ID=$invocation" -o cat --no-pager) || return $?
    if [[ "$output" == *'"event":"runtime.ready"'* ]]; then return 0; fi
    systemctl is-active --quiet mibot.service || { printf '%s\n' "主服务未保持运行" >&2; return 1; }
    sleep 2
  done
  printf '%s\n' "等待主服务就绪超时" >&2
  return 1
}

rollback_automatic() {
  local original_reason="$reason" fingerprint marker installed
  set +e
  git reset --hard "$rollback_revision" >/dev/null 2>&1
  local code=$?
  if [[ $code == 0 ]]; then
    fingerprint=$(node -e '
const fs = require("fs");
const crypto = require("crypto");
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$root/package-lock.json" 2>/dev/null)
    code=$?
  fi
  marker="$root/node_modules/.mibot-package-lock.sha256"
  installed=""
  if [[ -f "$marker" ]]; then installed=$(<"$marker"); fi
  if [[ $code == 0 && ( ! -d node_modules || "$installed" != "$fingerprint" ) ]]; then
    rm -f "$marker"
    npm ci >/dev/null 2>&1
    code=$?
    if [[ $code == 0 ]]; then write_dependency_marker "$marker" "$fingerprint" >/dev/null 2>&1; code=$?; fi
  fi
  if [[ $code == 0 ]]; then npm run package:v2 >/dev/null 2>&1; code=$?; fi
  if [[ $code == 0 ]]; then npm run check:v2 >/dev/null 2>&1; code=$?; fi
  if [[ $code == 0 ]]; then systemctl restart mibot.service >/dev/null 2>&1; code=$?; fi
  if [[ $code == 0 ]]; then wait_for_runtime_ready >/dev/null 2>&1; code=$?; fi
  set -e
  if [[ $code == 0 ]]; then
    current_version="$previous_version"
    current_revision="$rollback_revision"
    reason="${original_reason}；已自动恢复上一版本"
  else
    reason="${original_reason}；自动恢复失败（退出码 ${code}），请立即检查服务器日志"
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
  local usage='Usage: bash scripts/update-service.sh [--automatic] [--root DIRECTORY | REPOSITORY_DIRECTORY]'
  if [[ $# == 1 && "$1" == --help ]]; then printf '%s\n' "$usage"; return 0; fi
  mode="manual"
  if [[ "${1:-}" == --automatic ]]; then mode="automatic"; shift; fi
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
  if [[ "$mode" == automatic ]]; then result_file="$root/temp/automatic-update-result.json"; fi
  request_file="$root/temp/update-request.json"
  request_claim="$root/temp/update-request.claim.$$"
  request_id=""
  trigger="manual"
  automatic_id=""
  rollback_revision=""
  rollback_needed=false
  status="failed"
  reason="更新服务异常退出"
  previous_version=""
  current_version=""
  previous_revision=""
  current_revision=""
  mkdir -p "$root/temp"

  acquire_update_lock

  if [[ "$mode" == manual ]] && mv "$request_file" "$request_claim" 2>/dev/null; then
    request_id=$(node -e '
const fs = require("fs");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof value.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.requestId)) process.stdout.write(value.requestId);
} catch {}
' "$request_claim")
    rm -f "$request_claim"
  fi
  finish() {
    local code=$?
    trap - EXIT
    if [[ "$status" != "success" ]]; then
      if [[ "$mode" == automatic && "$rollback_needed" == true && -n "$rollback_revision" ]]; then
        rollback_automatic
      fi
      write_result "$status" "$reason"
    fi
    exit "$code"
  }
  trap finish EXIT

  previous_version=$(read_version "$root/package.json" 2>/dev/null || true)
  previous_revision=$(git rev-parse --verify HEAD 2>/dev/null || true)
  if [[ "$mode" == automatic ]]; then
    trigger="automatic"
    automatic_id=$(automatic_id_for "$previous_revision" fetch)
    run_step "拉取远端信息" git fetch origin main
    remote_revision=$(git rev-parse --verify refs/remotes/origin/main 2>/dev/null || true)
    [[ "$remote_revision" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || {
      status="failed"; reason="无法读取 origin/main 的提交"; exit 1;
    }
    automatic_id=$(automatic_id_for "$previous_revision" "$remote_revision")
    comparison=$(git rev-list --left-right --count HEAD...refs/remotes/origin/main 2>/dev/null || true)
    if [[ ! "$comparison" =~ ^([0-9]+)[[:space:]]+([0-9]+)$ ]]; then
      status="failed"; reason="无法比较本地分支与 origin/main"; exit 1
    fi
    ahead=${BASH_REMATCH[1]}
    behind=${BASH_REMATCH[2]}
    if (( ahead > 0 )); then
      status="failed"
      reason=$([[ $behind -gt 0 ]] && printf '本地与 origin/main 已分叉' || printf '本地存在尚未推送的提交')
      exit 1
    fi
    if (( behind == 0 )); then
      status="success"
      return 0
    fi
    if ! git diff --quiet --ignore-submodules -- || ! git diff --cached --quiet --ignore-submodules --; then
      status="failed"; reason="部署仓库存在未提交的已跟踪文件变更"; exit 1
    fi
    if [[ -n $(git ls-files --others --exclude-standard) ]]; then
      status="failed"; reason="部署仓库存在未提交的未跟踪文件"; exit 1
    fi
    rollback_revision="$previous_revision"
    run_step "快进代码" git merge --ff-only refs/remotes/origin/main
    rollback_needed=true
  else
    run_step "拉取代码" git pull --ff-only origin main
  fi
  current_version=$(read_version "$root/package.json" 2>/dev/null || true)
  current_revision=$(git rev-parse --verify HEAD 2>/dev/null || true)
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
    run_step "记录依赖状态" write_dependency_marker "$dependency_marker" "$dependency_fingerprint"
  fi
  run_step "构建主程序" npm run package:v2
  run_step "运行运行时自检" npm run check:v2
  run_step "重启主服务" systemctl restart mibot.service
  run_step "等待主程序就绪" wait_for_runtime_ready

  status="success"
  rollback_needed=false
  reason=""
  write_result "success" ""
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
