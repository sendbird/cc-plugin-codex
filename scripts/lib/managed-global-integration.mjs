/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePathSlashes, resolveCodexHome } from "./codex-paths.mjs";
import {
  getManagedPluginSignals as getManagedPluginSignalsBase,
  LEGACY_MARKETPLACE_NAME,
  listManagedPluginCacheEntries,
  PLUGIN_NAME,
} from "./plugin-identity.mjs";

const CODEX_HOME = resolveCodexHome();
const HOME_DIR = os.homedir();
const CODEX_HOOKS_FILE = path.join(CODEX_HOME, "hooks.json");
const CODEX_SKILLS_DIR = path.join(CODEX_HOME, "skills");
const CODEX_PROMPTS_DIR = path.join(CODEX_HOME, "prompts");
const MANAGED_WRAPPER_SKILLS = [
  "review",
  "adversarial-review",
  "rescue",
  "status",
  "result",
  "cancel",
  "setup",
];

function readText(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
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

export function removeManagedHooks(pluginRoot) {
  const raw = readText(CODEX_HOOKS_FILE);
  if (!raw) {
    return;
  }

  const parsed = JSON.parse(raw);
  const nextHooks = {};
  let changed = false;
  const hookPrefixes = [
    normalizePathSlashes(path.join(pluginRoot, "hooks")) + "/",
    ...listManagedPluginCacheEntries().map(
      (cacheEntry) => normalizePathSlashes(path.join(cacheEntry.cachePath, "hooks")) + "/"
    ),
  ];

  for (const [eventName, entries] of Object.entries(parsed.hooks ?? {})) {
    const keptEntries = [];
    for (const entry of entries ?? []) {
      const keptNested = (entry.hooks ?? []).filter((hook) => {
        const command = normalizePathSlashes(String(hook?.command ?? ""));
        const shouldRemove = hookPrefixes.some((hookPrefix) => command.includes(hookPrefix));
        changed ||= shouldRemove;
        return !shouldRemove;
      });
      if (keptNested.length > 0) {
        keptEntries.push({ ...entry, hooks: keptNested });
      }
    }
    if (keptEntries.length > 0) {
      nextHooks[eventName] = keptEntries;
    }
  }

  if (!changed) {
    return;
  }

  if (Object.keys(nextHooks).length === 0) {
    fs.rmSync(CODEX_HOOKS_FILE, { force: true });
    return;
  }

  writeText(CODEX_HOOKS_FILE, `${JSON.stringify({ hooks: nextHooks }, null, 2)}\n`);
}

function formatWrapperName(skillName) {
  return `${PLUGIN_NAME}-${skillName}`;
}

export function removeManagedSkillWrappers() {
  for (const skillName of MANAGED_WRAPPER_SKILLS) {
    fs.rmSync(path.join(CODEX_SKILLS_DIR, formatWrapperName(skillName)), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(CODEX_PROMPTS_DIR, `${formatWrapperName(skillName)}.md`), {
      force: true,
    });
  }

  removeIfEmpty(CODEX_SKILLS_DIR);
  removeIfEmpty(CODEX_PROMPTS_DIR);
}

export function getManagedPluginSignals() {
  return getManagedPluginSignalsBase();
}

export function isCodexPluginActive() {
  return getManagedPluginSignals().configState === "active";
}

export function cleanupManagedGlobalIntegrations(pluginRoot) {
  removeManagedHooks(pluginRoot);
  removeManagedSkillWrappers();
}

export function resolveManagedMarketplacePluginPath(pluginRoot) {
  const relative = path.relative(HOME_DIR, pluginRoot);
  if (!relative || relative === "") {
    throw new Error(
      `Plugin root must not be the marketplace root itself: ${pluginRoot}`
    );
  }
  if (path.isAbsolute(relative)) {
    throw new Error(
      `Unable to express plugin root as a relative personal marketplace path: ${pluginRoot}`
    );
  }
  return `./${normalizePathSlashes(relative)}`;
}

export { LEGACY_MARKETPLACE_NAME, PLUGIN_NAME };
