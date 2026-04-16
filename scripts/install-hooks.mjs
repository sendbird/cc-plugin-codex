#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * install-hooks.mjs — Installs plugin hooks.
 *
 * Steps:
 * 1. Read hooks/hooks.json from plugin dir (resolve relative to import.meta.url)
 * 2. Replace $PLUGIN_ROOT with absolute path to plugin directory
 * 3. Read existing ~/.codex/hooks.json (or empty {hooks:{}})
 * 4. For each event type, append new hooks (don't overwrite existing)
 * 5. Write merged result
 * 6. Ensure ~/.codex/config.toml has codex_hooks = true
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCodexHooksEnabled } from "./lib/codex-config.mjs";
import { resolveCodexHome } from "./lib/codex-paths.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const PLUGIN_HOOKS_FILE = path.join(PLUGIN_ROOT, "hooks", "hooks.json");
const CODEX_DIR = resolveCodexHome();
const CODEX_HOOKS_FILE = path.join(CODEX_DIR, "hooks.json");
const CODEX_CONFIG_TOML = path.join(CODEX_DIR, "config.toml");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

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

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function configureCodexHooks() {
  const existing = readTextFile(CODEX_CONFIG_TOML) ?? "";
  const { changed, content } = ensureCodexHooksEnabled(existing);
  if (changed || !fs.existsSync(CODEX_CONFIG_TOML)) {
    writeTextFile(CODEX_CONFIG_TOML, content);
  }
  return changed;
}

function escapeShellArgument(value) {
  const text = String(value);
  if (process.platform === "win32") {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function resolvePluginSubpath(relativePath) {
  const normalized = String(relativePath ?? "");
  if (!normalized || path.isAbsolute(normalized)) {
    throw new Error(`Invalid plugin-relative path: ${normalized}`);
  }
  const resolved = path.resolve(PLUGIN_ROOT, normalized);
  const pluginRootWithSep = `${PLUGIN_ROOT}${path.sep}`;
  if (resolved !== PLUGIN_ROOT && !resolved.startsWith(pluginRootWithSep)) {
    throw new Error(`Refusing to resolve path outside the plugin root: ${normalized}`);
  }
  return resolved;
}

function normalizeCommandForComparison(command) {
  return String(command)
    .replace(/\\(?=["'])/g, "")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePluginRoot(text) {
  return text.replace(/\$PLUGIN_ROOT/g, PLUGIN_ROOT);
}

function resolveHookCommand(command) {
  return command.replace(/"\$PLUGIN_ROOT\/([^"]+)"/g, (_, relativePath) =>
    escapeShellArgument(resolvePluginSubpath(relativePath))
  );
}

function deepReplacePlaceholders(obj) {
  if (typeof obj === "string") {
    return resolvePluginRoot(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(deepReplacePlaceholders);
  }
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === "command" && typeof value === "string") {
        result[key] = resolveHookCommand(value);
        continue;
      }
      result[key] = deepReplacePlaceholders(value);
    }
    return result;
  }
  return obj;
}

/**
 * Check if a hook entry is a duplicate of an existing one.
 * Two hook entries are considered duplicates if they have the same
 * command string (after placeholder resolution).
 */
function isDuplicateHookEntry(existing, candidate) {
  const existingHooks = existing.hooks ?? [];
  const candidateHooks = candidate.hooks ?? [];

  if (candidateHooks.length === 0) return false;

  // Check if any candidate hook command already exists in existing hooks
  for (const ch of candidateHooks) {
    if (!ch.command) continue;
    for (const eh of existingHooks) {
      if (
        eh.type === ch.type &&
        normalizeCommandForComparison(eh.command) ===
          normalizeCommandForComparison(ch.command)
      ) {
        return true;
      }
    }
  }
  return false;
}

function dedupeHookEntries(entries) {
  const seen = new Set();
  const deduped = [];

  for (const entry of entries) {
    const hooks = entry?.hooks ?? [];
    const matcher = entry?.matcher ?? "";
    const signature = hooks
      .map((hook) =>
        [
          hook?.type ?? "",
          normalizeCommandForComparison(hook?.command ?? ""),
          matcher,
        ].join("|")
      )
      .join("||");

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    deduped.push(entry);
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Step 1: Read plugin hooks template
  const pluginHooksRaw = readJsonFile(PLUGIN_HOOKS_FILE);
  if (!pluginHooksRaw || !pluginHooksRaw.hooks) {
    console.error("Error: Could not read plugin hooks template at", PLUGIN_HOOKS_FILE);
    process.exit(1);
  }

  // Step 2: Replace $PLUGIN_ROOT with actual path
  const pluginHooks = deepReplacePlaceholders(pluginHooksRaw);
  console.log(`Plugin root resolved to: ${PLUGIN_ROOT}`);

  // Step 3: Read existing hooks.json (or create empty)
  let existingHooks = readJsonFile(CODEX_HOOKS_FILE);
  if (!existingHooks) {
    existingHooks = { hooks: {} };
    console.log("No existing hooks.json found, creating new one.");
  } else {
    console.log(`Found existing hooks.json at ${CODEX_HOOKS_FILE}`);
  }

  if (!existingHooks.hooks) {
    existingHooks.hooks = {};
  }

  for (const [eventType, entries] of Object.entries(existingHooks.hooks)) {
    if (Array.isArray(entries)) {
      existingHooks.hooks[eventType] = dedupeHookEntries(entries);
    }
  }

  // Step 4: Merge — for each event type, append new hooks without overwriting
  let addedCount = 0;
  let skippedCount = 0;

  for (const [eventType, entries] of Object.entries(pluginHooks.hooks)) {
    if (!Array.isArray(entries)) continue;

    if (!existingHooks.hooks[eventType]) {
      existingHooks.hooks[eventType] = [];
    }

    for (const entry of entries) {
      // Check for duplicates
      const alreadyExists = existingHooks.hooks[eventType].some((existing) =>
        isDuplicateHookEntry(existing, entry)
      );

      if (alreadyExists) {
        skippedCount++;
        console.log(`  [skip] ${eventType}: hook already exists`);
      } else {
        existingHooks.hooks[eventType].push(entry);
        addedCount++;
        console.log(`  [add]  ${eventType}: added hook entry`);
      }
    }
  }

  // Step 5: Write merged result
  writeJsonFile(CODEX_HOOKS_FILE, existingHooks);
  console.log(`\nWrote ${CODEX_HOOKS_FILE}`);
  console.log(`  Added: ${addedCount} hook entries`);
  console.log(`  Skipped: ${skippedCount} duplicate entries`);

  // Step 6: Ensure config.toml enables codex_hooks
  const codexHooksChanged = configureCodexHooks();
  if (codexHooksChanged) {
    console.log("\nEnabled codex_hooks in ~/.codex/config.toml.");
  } else {
    console.log("\nCodex hooks are enabled in config.toml. Ready to go.");
  }

  console.log("");
  console.log("Codex hooks installation complete.");
}

main();
