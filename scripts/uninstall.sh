#!/usr/bin/env bash

# Copyright 2026 Sendbird, Inc.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd tar
require_cmd node

REPO_TARBALL_URL="${CC_PLUGIN_CODEX_TARBALL_URL:-https://github.com/sendbird/cc-plugin-codex/archive/refs/heads/main.tar.gz}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL "$REPO_TARBALL_URL" | tar xz -C "$TMP_DIR" --strip-components=1
node "$TMP_DIR/scripts/installer-cli.mjs" uninstall
