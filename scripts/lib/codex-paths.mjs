/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_DATA_NAMESPACE = "cc";
export const LEGACY_PLUGIN_DATA_NAMESPACES = ["cc", "claude-code"];

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function normalizePathSlashes(value) {
  return value.replace(/\\/g, "/");
}

export function canonicalPath(candidate) {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export function samePath(a, b, platform = process.platform) {
  const left = canonicalPath(a);
  const right = canonicalPath(b);
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function resolveCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function resolvePluginsDataRoot() {
  return path.join(resolveCodexHome(), "plugins", "data");
}

export function resolvePluginCacheInstallInfo(
  pluginRoot = PLUGIN_ROOT,
  codexHome = resolveCodexHome()
) {
  const cacheRoot = path.join(codexHome, "plugins", "cache");
  const relativePath = path.relative(
    canonicalPath(cacheRoot),
    canonicalPath(pluginRoot)
  );
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  const [marketplaceName, pluginName, version, ...rest] = relativePath
    .split(path.sep)
    .filter(Boolean);
  if (
    !marketplaceName ||
    !/^[A-Za-z0-9_-]+$/.test(marketplaceName) ||
    pluginName !== PLUGIN_DATA_NAMESPACE ||
    !version ||
    rest.length > 0
  ) {
    return null;
  }
  return {
    marketplaceName,
    pluginName,
    version,
    pluginId: `${pluginName}@${marketplaceName}`,
  };
}

export function resolveMarketplacePluginDataRoot(marketplaceName) {
  if (!/^[A-Za-z0-9_-]+$/.test(marketplaceName)) {
    throw new Error(`Invalid marketplace name: ${marketplaceName}`);
  }
  return path.join(resolvePluginsDataRoot(), `${PLUGIN_DATA_NAMESPACE}-${marketplaceName}`);
}

export function resolveExpectedPluginDataRoot(
  pluginRoot = PLUGIN_ROOT,
  codexHome = resolveCodexHome()
) {
  const cacheInstall = resolvePluginCacheInstallInfo(pluginRoot, codexHome);
  const namespace = cacheInstall
    ? `${PLUGIN_DATA_NAMESPACE}-${cacheInstall.marketplaceName}`
    : PLUGIN_DATA_NAMESPACE;
  return path.join(codexHome, "plugins", "data", namespace);
}

export function resolvePluginDataRoot(namespace) {
  if (namespace !== undefined) {
    return path.join(resolvePluginsDataRoot(), namespace);
  }

  const injectedRoot =
    process.env.PLUGIN_DATA?.trim() || process.env.CLAUDE_PLUGIN_DATA?.trim();
  if (injectedRoot) {
    const resolvedInjectedRoot = path.resolve(injectedRoot);
    const expectedRoot = resolveExpectedPluginDataRoot();
    if (samePath(resolvedInjectedRoot, expectedRoot)) {
      return resolvedInjectedRoot;
    }
  }

  return resolveExpectedPluginDataRoot();
}

export function resolveWritablePluginDataRoots(
  primaryRoot = resolveExpectedPluginDataRoot()
) {
  const roots = [
    primaryRoot,
    ...LEGACY_PLUGIN_DATA_NAMESPACES.map((namespace) =>
      resolvePluginDataRoot(namespace)
    ),
  ];
  return roots.filter(
    (candidate, index) =>
      !roots.slice(0, index).some((previous) => samePath(previous, candidate))
  );
}

export function resolvePluginStateRoot(namespace) {
  return path.join(resolvePluginDataRoot(namespace), "state");
}

export function resolvePluginRuntimeRoot(namespace) {
  return path.join(resolvePluginDataRoot(namespace), "runtime");
}
