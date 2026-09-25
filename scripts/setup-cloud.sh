#!/usr/bin/env bash
# Prepares a cloud container (Claude Code on the web) for the full V2 checks.
#
# The container ships Node 22, but this project pins Node 24 (.nvmrc,
# engines.node). The plugin repository's tests also expect both checkouts side
# by side as real directories named TeleBox-Core and TeleBox-Plugins, while the
# web checkouts are named after the repositories. This script installs Node 24
# with the preinstalled nvm, installs dependencies, builds, and bind-mounts the
# checkouts under the expected names. It is idempotent: run it again after
# adding the plugin repository to a session that has already started.
#
#   bash scripts/setup-cloud.sh
#
# Commands in such a session do not share shell state, so prefix later commands
# with the PATH line printed at the end, or run this script from a SessionStart
# hook, where it appends that line to $CLAUDE_ENV_FILE.
set -euo pipefail

core="$(cd "$(dirname "$0")/.." && pwd)"
cd "$core"

echo "== Node.js $(cat .nvmrc) via nvm"
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm not found at $NVM_DIR; install Node $(cat .nvmrc) another way" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"
nvm install >/dev/null    # reads .nvmrc; a no-op once installed
nvm use >/dev/null
node_bin="$(dirname "$(nvm which current)")"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$node_bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
node --version

echo "== Dependencies and build"
npm install --no-audit --no-fund
npm run build:v2

# mount_alias SOURCE ALIAS_DIR: make SOURCE visible under a second name in
# the same parent directory. A bind mount is a real directory, which the
# storage layer insists on; a symlink would be rejected. Mounts do not survive
# a container restart, so this has to run again in a new container.
mount_alias() {
  local source="$1" alias_dir="$2"
  if mountpoint -q "$alias_dir"; then
    return
  fi
  if [ -e "$alias_dir" ]; then
    echo "$alias_dir already exists; leaving it alone"
    return
  fi
  mkdir "$alias_dir"
  if ! mount --bind "$source" "$alias_dir"; then
    rmdir "$alias_dir"
    echo "Could not bind-mount $source at $alias_dir; copy it there as a real directory instead" >&2
  fi
}

echo "== Cross-repository test layout"
parent="$(dirname "$core")"
if [ "$(basename "$core")" != "TeleBox-Core" ]; then
  mount_alias "$core" "$parent/TeleBox-Core"
fi
for plugins in "$parent/Mi-Box-Plugins" "$parent/mi-box-plugins"; do
  if [ -d "$plugins" ]; then
    mount_alias "$plugins" "$parent/TeleBox-Plugins"
    break
  fi
done
if [ -d "$parent/TeleBox-Plugins" ]; then
  echo "Plugin CI: bash $parent/TeleBox-Plugins/scripts/v2-validation.sh"
else
  echo "Plugin repository not found next to $core; add Mi-Box-Plugins to the session and run this script again"
fi

echo
echo "Node $(node --version) for later commands:  export PATH=\"$node_bin:\$PATH\""
