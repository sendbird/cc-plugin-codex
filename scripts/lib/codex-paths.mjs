/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import os from "node:os";
import path from "node:path";

export const PLUGIN_DATA_NAMESPACE = "cc";
export const LEGACY_PLUGIN_DATA_NAMESPACES = ["claude-code"];

export function resolveCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function resolvePluginsDataRoot() {
  return path.join(resolveCodexHome(), "plugins", "data");
}

export function resolvePluginDataRoot(namespace = PLUGIN_DATA_NAMESPACE) {
  return path.join(resolvePluginsDataRoot(), namespace);
}

export function resolvePluginStateRoot(namespace = PLUGIN_DATA_NAMESPACE) {
  return path.join(resolvePluginDataRoot(namespace), "state");
}

export function resolvePluginRuntimeRoot(namespace = PLUGIN_DATA_NAMESPACE) {
  return path.join(resolvePluginDataRoot(namespace), "runtime");
}
