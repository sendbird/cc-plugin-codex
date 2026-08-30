#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { callCodexAppServer } from "./lib/codex-app-server.mjs";
import {
  ensureCodexWritableRoots,
  ensureNativePluginHooksEnabled,
  removeCodexWritableRoots,
} from "./lib/codex-config.mjs";
import {
  resolveCodexHome,
  resolveMarketplacePluginDataRoot,
  resolveWritablePluginDataRoots,
} from "./lib/codex-paths.mjs";
import {
  LEGACY_MARKETPLACE_NAME,
  listManagedPluginCacheEntries,
  pluginIdForMarketplace,
  PLUGIN_NAME,
} from "./lib/plugin-identity.mjs";
import {
  cleanupManagedGlobalIntegrations,
  removeManagedSkillWrappers,
} from "./lib/managed-global-integration.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const CODEX_HOME = resolveCodexHome();
const HOME_DIR = os.homedir();
const CODEX_CONFIG_FILE = path.join(CODEX_HOME, "config.toml");
const LEGACY_INSTALL_DIR = path.join(CODEX_HOME, "plugins", PLUGIN_NAME);
const PERSONAL_MARKETPLACE_FILE = path.join(HOME_DIR, ".agents", "plugins", "marketplace.json");
const DEFAULT_MARKETPLACE_NAME = "sendbird";
const DEFAULT_MARKETPLACE_SOURCE = "sendbird/codex-marketplace";

function usage() {
  console.error("Usage: cc-plugin-codex <install|update|uninstall>");
  process.exit(1);
}

function parseArgs(argv) {
  const [command] = argv;
  if (!command || !["install", "update", "uninstall"].includes(command)) {
    usage();
  }
  return { command };
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function removeIfEmpty(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  if (fs.readdirSync(dirPath).length === 0) {
    fs.rmdirSync(dirPath);
  }
}

function resolveInstallerMarketplaceConfig() {
  const marketplaceName =
    process.env.CC_PLUGIN_CODEX_MARKETPLACE_NAME?.trim() || DEFAULT_MARKETPLACE_NAME;
  const source =
    process.env.CC_PLUGIN_CODEX_MARKETPLACE_SOURCE?.trim() || DEFAULT_MARKETPLACE_SOURCE;
  const refName = process.env.CC_PLUGIN_CODEX_MARKETPLACE_REF?.trim() || null;
  const sparsePaths = (process.env.CC_PLUGIN_CODEX_MARKETPLACE_SPARSE_PATHS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    marketplaceName,
    source,
    refName,
    sparsePaths: sparsePaths.length > 0 ? sparsePaths : null,
  };
}

function configureNativePluginHooks() {
  const existing = readText(CODEX_CONFIG_FILE);
  const { changed, content } = ensureNativePluginHooksEnabled(existing);
  if (changed || !fs.existsSync(CODEX_CONFIG_FILE)) {
    writeText(CODEX_CONFIG_FILE, content);
  }
  return changed;
}

function removePersonalMarketplaceCcEntries() {
  if (!fs.existsSync(PERSONAL_MARKETPLACE_FILE)) {
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(PERSONAL_MARKETPLACE_FILE, "utf8"));
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.plugins)) {
    return;
  }
  const nextPlugins = parsed.plugins.filter((plugin) => plugin?.name !== PLUGIN_NAME);
  if (nextPlugins.length === parsed.plugins.length) {
    return;
  }
  if (nextPlugins.length === 0) {
    fs.rmSync(PERSONAL_MARKETPLACE_FILE, { force: true });
    removeIfEmpty(path.dirname(PERSONAL_MARKETPLACE_FILE));
    removeIfEmpty(path.dirname(path.dirname(PERSONAL_MARKETPLACE_FILE)));
    return;
  }
  parsed.plugins = nextPlugins;
  writeText(PERSONAL_MARKETPLACE_FILE, `${JSON.stringify(parsed, null, 2)}\n`);
}

function normalizeTrailingNewline(text) {
  return `${String(text).replace(/\s*$/, "")}\n`;
}

function removeManagedPluginConfigSections() {
  if (!fs.existsSync(CODEX_CONFIG_FILE)) {
    return;
  }
  const lines = fs.readFileSync(CODEX_CONFIG_FILE, "utf8").split("\n");
  const kept = [];
  let skip = false;
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (skip && trimmed.startsWith("[")) {
      skip = false;
    }
    if (!skip && /^\[\s*plugins\s*\.\s*["']?cc@([^"'\]]+)["']?\s*\]\s*(?:#.*)?$/i.test(trimmed)) {
      skip = true;
      changed = true;
      continue;
    }
    if (!skip) {
      kept.push(line);
    }
  }

  if (changed) {
    writeText(CODEX_CONFIG_FILE, normalizeTrailingNewline(kept.join("\n").replace(/\n{3,}/g, "\n\n")));
  }
}

function cleanupLegacyLocalInstall() {
  cleanupManagedGlobalIntegrations(LEGACY_INSTALL_DIR);
  cleanupManagedGlobalIntegrations(PACKAGE_ROOT);
  removeManagedSkillWrappers();
  removePersonalMarketplaceCcEntries();
  fs.rmSync(LEGACY_INSTALL_DIR, { recursive: true, force: true });
}

async function addMarketplaceThroughCodex({ source, refName, sparsePaths }) {
  const params = { source };
  if (refName) {
    params.refName = refName;
  }
  if (sparsePaths && sparsePaths.length > 0) {
    params.sparsePaths = sparsePaths;
  }

  return await callCodexAppServer({
    cwd: PACKAGE_ROOT,
    method: "marketplace/add",
    params,
  });
}

async function installPluginThroughCodex(marketplacePath) {
  await callCodexAppServer({
    cwd: path.dirname(marketplacePath),
    method: "plugin/install",
    params: {
      marketplacePath,
      pluginName: PLUGIN_NAME,
      forceRemoteSync: false,
    },
  });
}

async function uninstallPluginThroughCodex(marketplaceName) {
  await callCodexAppServer({
    cwd: CODEX_HOME,
    method: "plugin/uninstall",
    params: {
      pluginId: pluginIdForMarketplace(marketplaceName),
      forceRemoteSync: false,
    },
  });
}

async function installOrUpdate() {
  const marketplaceConfig = resolveInstallerMarketplaceConfig();
  const hooksChanged = configureNativePluginHooks();
  cleanupLegacyLocalInstall();

  const marketplace = await addMarketplaceThroughCodex(marketplaceConfig);
  const marketplacePath = path.join(
    marketplace.installedRoot,
    ".agents",
    "plugins",
    "marketplace.json"
  );
  await installPluginThroughCodex(marketplacePath);
  const installedMarketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  const installedMarketplaceName =
    marketplace.marketplaceName ??
    installedMarketplace.name ??
    marketplaceConfig.marketplaceName;
  const pluginDataRoot = resolveMarketplacePluginDataRoot(installedMarketplaceName);
  const pluginDataRoots = resolveWritablePluginDataRoots(pluginDataRoot);
  const writableRootChanged = await ensureCodexWritableRoots(
    PACKAGE_ROOT,
    pluginDataRoots
  );

  console.log(`Installed ${PLUGIN_NAME} from ${marketplaceConfig.source} into the Codex plugin cache.`);
  if (hooksChanged) {
    console.log("Enabled [features].hooks in ~/.codex/config.toml.");
  }
  if (writableRootChanged) {
    console.log(`Allowed plugin state writes under ${pluginDataRoots.join(", ")}.`);
  }
  if (hooksChanged || writableRootChanged) {
    console.log("Restart Codex so existing sessions use the updated plugin configuration.");
  }
}

async function uninstall() {
  const marketplaceConfig = resolveInstallerMarketplaceConfig();
  cleanupLegacyLocalInstall();
  const marketplaceNames = [
    ...new Set([
      marketplaceConfig.marketplaceName,
      DEFAULT_MARKETPLACE_NAME,
      LEGACY_MARKETPLACE_NAME,
      ...listManagedPluginCacheEntries(CODEX_HOME).map(
        (entry) => entry.marketplaceName
      ),
    ]),
  ];
  const pluginDataRoots = marketplaceNames.flatMap((marketplaceName) => {
    try {
      return resolveWritablePluginDataRoots(
        resolveMarketplacePluginDataRoot(marketplaceName)
      );
    } catch {
      return [];
    }
  });

  for (const marketplaceName of marketplaceNames) {
    try {
      await uninstallPluginThroughCodex(marketplaceName);
    } catch {
      // Continue local cleanup across historical install modes.
    }
  }
  removeManagedPluginConfigSections();

  try {
    if (await removeCodexWritableRoots(PACKAGE_ROOT, pluginDataRoots)) {
      console.log("Removed plugin data roots from Codex writable-root config.");
    }
  } catch (error) {
    console.error(
      `Warning: unable to remove plugin data roots from Codex writable-root config: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  for (const cacheEntry of listManagedPluginCacheEntries(CODEX_HOME)) {
    fs.rmSync(cacheEntry.cachePath, { recursive: true, force: true });
  }

  const cacheDir = path.join(CODEX_HOME, "plugins", "cache");
  if (fs.existsSync(cacheDir)) {
    for (const marketplaceName of fs.readdirSync(cacheDir)) {
      removeIfEmpty(path.join(cacheDir, marketplaceName, PLUGIN_NAME));
      removeIfEmpty(path.join(cacheDir, marketplaceName));
    }
    removeIfEmpty(cacheDir);
  }

  console.log(`Uninstalled ${PLUGIN_NAME} from Codex plugin cache and removed legacy local installs.`);
}

const { command } = parseArgs(process.argv.slice(2));

if (command === "install" || command === "update") {
  await installOrUpdate();
} else {
  await uninstall();
}
