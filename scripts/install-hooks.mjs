#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * install-hooks.mjs — Legacy compatibility wrapper.
 *
 * Native Codex plugin hooks are loaded from hooks/hooks.json in the plugin cache.
 * This script now only enables the required feature gates and removes stale
 * global hook entries from older cc-plugin-codex installs.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNativePluginHooksEnabled } from "./lib/codex-config.mjs";
import { resolveCodexHome } from "./lib/codex-paths.mjs";
import { removeManagedHooks } from "./lib/managed-global-integration.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const CODEX_DIR = resolveCodexHome();
const CODEX_CONFIG_TOML = path.join(CODEX_DIR, "config.toml");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTextFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function configureNativePluginHooks() {
  const existing = readTextFile(CODEX_CONFIG_TOML) ?? "";
  const { changed, content } = ensureNativePluginHooksEnabled(existing);
  if (changed || !fs.existsSync(CODEX_CONFIG_TOML)) {
    writeTextFile(CODEX_CONFIG_TOML, content);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const nativeHooksChanged = configureNativePluginHooks();
  removeManagedHooks(PLUGIN_ROOT);

  if (nativeHooksChanged) {
    console.log("Enabled native Codex plugin hooks in ~/.codex/config.toml.");
  } else {
    console.log("Native Codex plugin hooks are already enabled.");
  }
  console.log("Codex now loads this plugin's hooks from hooks/hooks.json in the active plugin cache.");
}

main();
