/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import path from "node:path";
import { resolveCodexHome } from "./codex-paths.mjs";

export const PLUGIN_NAME = "cc";
export const LEGACY_MARKETPLACE_NAME = "local-plugins";

const MANAGED_PLUGIN_SECTION_PATTERN =
  /^\[\s*plugins\s*\.\s*["']?cc@([^"'\]]+)["']?\s*\]\s*(?:#.*)?$/i;
const PLUGIN_ENABLED_PATTERN = /^enabled\s*=\s*true\s*(?:#.*)?$/i;
const TOML_SECTION_PATTERN = /^\[.*\]\s*(?:#.*)?$/;
const TOML_ASSIGNMENT_PATTERN = /^[A-Za-z0-9_.-]+\s*=/;

function readText(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

export function pluginIdForMarketplace(marketplaceName) {
  return `${PLUGIN_NAME}@${marketplaceName}`;
}

export function pluginConfigHeader(marketplaceName) {
  return `[plugins."${pluginIdForMarketplace(marketplaceName)}"]`;
}

export function parseManagedPluginSections(configContent) {
  const sections = [];
  const lines = String(configContent ?? "").split("\n");
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(MANAGED_PLUGIN_SECTION_PATTERN);
    if (sectionMatch) {
      current = {
        pluginId: pluginIdForMarketplace(sectionMatch[1]),
        marketplaceName: sectionMatch[1],
        enabled: false,
      };
      sections.push(current);
      continue;
    }

    if (trimmed.startsWith("[")) {
      current = null;
      continue;
    }

    if (current && PLUGIN_ENABLED_PATTERN.test(trimmed)) {
      current.enabled = true;
    }
  }

  return sections;
}

export function listManagedPluginCacheEntries(codexHome = resolveCodexHome()) {
  const cacheRoot = path.join(codexHome, "plugins", "cache");
  if (!fs.existsSync(cacheRoot)) {
    return [];
  }

  const entries = [];
  for (const marketplaceName of fs.readdirSync(cacheRoot).sort()) {
    const pluginCacheRoot = path.join(cacheRoot, marketplaceName, PLUGIN_NAME);
    if (!fs.existsSync(pluginCacheRoot)) {
      continue;
    }

    for (const cacheEntryName of fs.readdirSync(pluginCacheRoot).sort()) {
      const cachePath = path.join(pluginCacheRoot, cacheEntryName);
      let stats = null;
      try {
        stats = fs.statSync(cachePath);
      } catch {
        continue;
      }

      if (!stats.isDirectory()) {
        continue;
      }

      entries.push({
        marketplaceName,
        pluginId: pluginIdForMarketplace(marketplaceName),
        cacheEntryName,
        cachePath,
      });
    }
  }

  return entries;
}

export function getManagedPluginSignals(codexHome = resolveCodexHome()) {
  const configFile = path.join(codexHome, "config.toml");
  const configContent = readText(configFile);
  const cacheEntries = listManagedPluginCacheEntries(codexHome);
  const cachePresent = cacheEntries.length > 0;

  if (configContent == null) {
    return {
      configState: "unknown",
      cachePresent,
      reason: "config-missing",
      sections: [],
      activeSection: null,
      cacheEntries,
    };
  }

  if (configContent.trim() === "") {
    return {
      configState: "unknown",
      cachePresent,
      reason: "config-empty",
      sections: [],
      activeSection: null,
      cacheEntries,
    };
  }

  const hasTomlLikeStructure = configContent
    .split("\n")
    .map((line) => line.trim())
    .some(
      (line) =>
        line !== "" &&
        !line.startsWith("#") &&
        (TOML_SECTION_PATTERN.test(line) || TOML_ASSIGNMENT_PATTERN.test(line))
    );

  if (!hasTomlLikeStructure) {
    return {
      configState: "unknown",
      cachePresent,
      reason: "config-unrecognized",
      sections: [],
      activeSection: null,
      cacheEntries,
    };
  }

  const sections = parseManagedPluginSections(configContent);
  const activeSection = sections.find((section) => section.enabled) ?? null;

  if (sections.length === 0) {
    return {
      configState: "inactive",
      cachePresent,
      reason: "plugin-section-missing",
      sections,
      activeSection,
      cacheEntries,
    };
  }

  return {
    configState: activeSection ? "active" : "inactive",
    cachePresent,
    reason: activeSection ? "plugin-enabled" : "plugin-disabled",
    sections,
    activeSection,
    cacheEntries,
  };
}

export function getPreferredMarketplaceName(
  fallback = LEGACY_MARKETPLACE_NAME,
  codexHome = resolveCodexHome()
) {
  const signals = getManagedPluginSignals(codexHome);
  return (
    signals.activeSection?.marketplaceName ??
    signals.sections[0]?.marketplaceName ??
    signals.cacheEntries[0]?.marketplaceName ??
    fallback
  );
}
