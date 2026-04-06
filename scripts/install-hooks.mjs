#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * install-hooks.mjs — Installs plugin hooks plus the global cc-rescue agent.
 *
 * Steps:
 * 1. Read hooks/hooks.json from plugin dir (resolve relative to import.meta.url)
 * 2. Replace $PLUGIN_ROOT with absolute path to plugin directory
 * 3. Read existing ~/.codex/hooks.json (or empty {hooks:{}})
 * 4. For each event type, append new hooks (don't overwrite existing)
 * 5. Write merged result
 * 6. Copy the managed cc-rescue agent file into ~/.codex/agents/cc-rescue.toml
 * 7. Ensure ~/.codex/config.toml registers [agents."cc-rescue"]
 * 8. Check if ~/.codex/config.toml has codex_hooks = true, print guidance if not
 * 9. Ensure sandbox_workspace_write.network_access = true for OAuth keychain access
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexHome } from "./lib/codex-paths.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const PLUGIN_HOOKS_FILE = path.join(PLUGIN_ROOT, "hooks", "hooks.json");
const PLUGIN_AGENT_TEMPLATE_FILE = path.join(PLUGIN_ROOT, "agents", "cc-rescue.toml");
const CODEX_DIR = resolveCodexHome();
const CODEX_HOOKS_FILE = path.join(CODEX_DIR, "hooks.json");
const CODEX_CONFIG_TOML = path.join(CODEX_DIR, "config.toml");
const CODEX_AGENTS_DIR = path.join(CODEX_DIR, "agents");
const CODEX_RESCUE_AGENT_FILE = path.join(CODEX_AGENTS_DIR, "cc-rescue.toml");
const MANAGED_AGENT_MARKER = "# Managed by cc-plugin-codex.";

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

function escapeShellArgument(value) {
  const text = String(value);
  if (process.platform === "win32") {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

function timestampSuffix() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function installRescueAgentFile() {
  const template = readTextFile(PLUGIN_AGENT_TEMPLATE_FILE);
  if (!template) {
    console.error("Error: Could not read rescue agent template at", PLUGIN_AGENT_TEMPLATE_FILE);
    process.exit(1);
  }

  const resolved = template
    .replace(/^(\s*path\s*=\s*)"\$PLUGIN_ROOT\/([^"]+)"$/gm, (_, prefix, relativePath) =>
      `${prefix}"${escapeTomlString(resolvePluginSubpath(relativePath))}"`
    )
    .replace(/"\$PLUGIN_ROOT\/([^"]+)"/g, (_, relativePath) =>
      escapeShellArgument(resolvePluginSubpath(relativePath))
    );
  const existing = readTextFile(CODEX_RESCUE_AGENT_FILE);

  if (existing === resolved) {
    console.log(`Rescue agent already up to date at ${CODEX_RESCUE_AGENT_FILE}`);
    return { changed: false, backedUp: null };
  }

  let backupPath = null;
  if (existing && !existing.includes(MANAGED_AGENT_MARKER)) {
    backupPath = `${CODEX_RESCUE_AGENT_FILE}.bak-${timestampSuffix()}`;
    writeTextFile(backupPath, existing);
    console.log(`Backed up existing custom rescue agent to ${backupPath}`);
  }

  writeTextFile(CODEX_RESCUE_AGENT_FILE, resolved);
  console.log(`Installed rescue agent at ${CODEX_RESCUE_AGENT_FILE}`);
  return { changed: true, backedUp: backupPath };
}

function hasSandboxNetworkAccess(configContent) {
  // Match [sandbox_workspace_write] section with network_access = true
  return /\[sandbox_workspace_write\][\s\S]*?network_access\s*=\s*true/m.test(configContent);
}

function ensureSandboxNetworkAccess() {
  const existing = readTextFile(CODEX_CONFIG_TOML) ?? "";
  if (hasSandboxNetworkAccess(existing)) {
    return { changed: false };
  }

  // Check if the section exists but with network_access = false
  if (/\[sandbox_workspace_write\]/m.test(existing)) {
    // Section exists — update the value in place
    const updated = existing.replace(
      /(\[sandbox_workspace_write\][\s\S]*?)network_access\s*=\s*false/m,
      "$1network_access = true"
    );
    if (updated !== existing) {
      writeTextFile(CODEX_CONFIG_TOML, updated);
      console.log("Updated sandbox_workspace_write.network_access to true in config.toml");
      return { changed: true };
    }
    // Section exists but no network_access key — append it
    const withKey = existing.replace(
      /(\[sandbox_workspace_write\]\n)/m,
      "$1network_access = true\n"
    );
    writeTextFile(CODEX_CONFIG_TOML, withKey);
    console.log("Added network_access = true to existing [sandbox_workspace_write] in config.toml");
    return { changed: true };
  }

  // Section doesn't exist — append it
  const block = [
    "",
    "# Required for Claude Code OAuth: the macOS seatbelt sandbox blocks",
    "# Keychain access (com.apple.SecurityServer) unless network_access is enabled.",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
  ].join("\n");

  writeTextFile(CODEX_CONFIG_TOML, `${existing.replace(/\s*$/, "")}${block}`);
  console.log("Added [sandbox_workspace_write] network_access = true to config.toml");
  return { changed: true };
}

function hasRescueAgentRegistration(configContent) {
  return /^\s*\[agents\.(?:"cc-rescue"|cc-rescue)\]\s*$/m.test(configContent);
}

function ensureRescueAgentRegistration() {
  const existing = readTextFile(CODEX_CONFIG_TOML) ?? "";
  if (hasRescueAgentRegistration(existing)) {
    console.log('Found existing [agents."cc-rescue"] registration in config.toml');
    return { changed: false };
  }

  const block = [
    "",
    '[agents."cc-rescue"]',
    'description = "Forward substantial rescue tasks to Claude Code through the companion runtime."',
    'config_file = "agents/cc-rescue.toml"',
    "",
  ].join("\n");

  writeTextFile(CODEX_CONFIG_TOML, `${existing.replace(/\s*$/, "")}${block}`);
  console.log('Added [agents."cc-rescue"] to ~/.codex/config.toml');
  return { changed: true };
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

  // Step 6: Install managed rescue agent file
  const agentInstall = installRescueAgentFile();

  // Step 7: Ensure config.toml registers the rescue agent
  const agentRegistration = ensureRescueAgentRegistration();

  // Step 9: Ensure sandbox allows keychain access for OAuth auth
  const sandboxUpdate = ensureSandboxNetworkAccess();

  // Step 8: Check config.toml for codex_hooks setting
  let hasCodexHooks = false;
  if (fs.existsSync(CODEX_CONFIG_TOML)) {
    const configContent = fs.readFileSync(CODEX_CONFIG_TOML, "utf8");
    // Simple check — TOML parsing not needed for a boolean flag
    hasCodexHooks = /codex_hooks\s*=\s*true/i.test(configContent);
  }

  if (!hasCodexHooks) {
    console.log("\n--- IMPORTANT ---");
    console.log("Codex hooks are not enabled in your config.");
    console.log("Add the following to ~/.codex/config.toml:");
    console.log("");
    console.log("  [features]");
    console.log("  codex_hooks = true");
    console.log("");
    console.log("This enables Codex to execute lifecycle hooks from hooks.json.");
  } else {
    console.log("\nCodex hooks are enabled in config.toml. Ready to go.");
  }

  console.log("");
  if (agentInstall.changed || agentRegistration.changed) {
    console.log('Global "cc-rescue" agent is installed and registered.');
  } else {
    console.log('Global "cc-rescue" agent was already installed.');
  }
}

main();
