#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCodexHome } from "./lib/codex-paths.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const MARKETPLACE_NAME = "local-plugins";
const MARKETPLACE_DISPLAY_NAME = "Local Plugins";
const PLUGIN_NAME = "cc";
const HOME_DIR = os.homedir();
const CODEX_HOME = resolveCodexHome();
const MARKETPLACE_FILE = path.join(HOME_DIR, ".agents", "plugins", "marketplace.json");
const CODEX_CONFIG_FILE = path.join(CODEX_HOME, "config.toml");
const CODEX_HOOKS_FILE = path.join(CODEX_HOME, "hooks.json");
const CODEX_AGENT_FILE = path.join(CODEX_HOME, "agents", "cc-rescue.toml");
const CODEX_SKILLS_DIR = path.join(CODEX_HOME, "skills");
const CODEX_PROMPTS_DIR = path.join(CODEX_HOME, "prompts");
const MANAGED_AGENT_MARKER = "# Managed by cc-plugin-codex.";
const PLUGIN_CONFIG_HEADER = `[plugins."${PLUGIN_NAME}@${MARKETPLACE_NAME}"]`;
const AGENT_CONFIG_HEADER = '[agents."cc-rescue"]';
const MANAGED_AGENT_REGISTRATION_LINES = [
  'description = "Forward substantial rescue tasks to Claude Code through the companion runtime."',
  'config_file = "agents/cc-rescue.toml"',
];
const EXPORTED_SKILLS = [
  "review",
  "adversarial-review",
  "rescue",
  "status",
  "result",
  "cancel",
  "setup",
];

function usage() {
  console.error(
    "Usage: node scripts/local-plugin-install.mjs <install|uninstall> " +
      "[--plugin-root <path>] [--skip-hook-install]"
  );
  process.exit(1);
}

function normalizePathSlashes(value) {
  return value.replace(/\\/g, "/");
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || !["install", "uninstall"].includes(command)) {
    usage();
  }

  let pluginRoot = DEFAULT_PLUGIN_ROOT;
  let skipHookInstall = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--plugin-root") {
      const next = args.shift();
      if (!next) usage();
      pluginRoot = path.resolve(next);
      continue;
    }
    if (arg === "--skip-hook-install") {
      skipHookInstall = true;
      continue;
    }
    usage();
  }

  return { command, pluginRoot, skipHookInstall };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, content) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, content, "utf8");
}

function normalizeTrailingNewline(text) {
  return `${text.replace(/\s*$/, "")}\n`;
}

function formatCodexPromptName(skillName) {
  return `${PLUGIN_NAME}-${skillName}`;
}

function formatCodexSkillInvocationName(skillName) {
  return `${PLUGIN_NAME}:${skillName}`;
}

function extractFrontmatterFields(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  const fields = new Map();
  if (!match) {
    return fields;
  }

  for (const line of match[1].split("\n")) {
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) {
      continue;
    }
    fields.set(fieldMatch[1], fieldMatch[2]);
  }

  return fields;
}

function rewriteSkillFrontmatter(markdown, skillName) {
  return markdown.replace(
    /^---\n([\s\S]*?)\n---/,
    (_whole, body) => {
      const nextLines = body.split("\n").map((line) => {
        if (line.startsWith("name:")) {
          return `name: ${formatCodexSkillInvocationName(skillName)}`;
        }
        return line;
      });
      return `---\n${nextLines.join("\n")}\n---`;
    }
  );
}

function rewriteSkillBody(markdown, pluginRoot) {
  const normalizedPluginRoot = normalizePathSlashes(pluginRoot);
  return markdown
    .replaceAll("<plugin-root>", normalizedPluginRoot)
    .replace(
      new RegExp(
        `Resolve \`${escapeRegExp(normalizedPluginRoot)}\` as two directories above this skill file\\. The companion entrypoint is:`,
        "g"
      ),
      "Use the companion entrypoint at:"
    )
    .replace(
      new RegExp(
        `Resolve \`${escapeRegExp(normalizedPluginRoot)}\` as two directories above this skill file, then run:`,
        "g"
      ),
      "Use the companion entrypoint:"
    )
    .replace(
      new RegExp(
        `The global cc-rescue agent is installed by \`node \"${escapeRegExp(normalizedPluginRoot)}\\/scripts\\/install-hooks\\.mjs\"\` and registered in ~\\/\\.codex\\/config\\.toml\\.\\n\\nUse the companion entrypoint at:`,
        "g"
      ),
      `The global cc-rescue agent is installed by \`node "${normalizedPluginRoot}/scripts/install-hooks.mjs"\` and registered in \`~/.codex/config.toml\`.\n\nUse the companion entrypoint at:`
    );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function installCodexSkillWrappers(pluginRoot) {
  for (const skillName of EXPORTED_SKILLS) {
    const sourceSkillPath = path.join(pluginRoot, "skills", skillName, "SKILL.md");
    const sourceSkill = readText(sourceSkillPath);
    if (!sourceSkill) {
      throw new Error(`Missing skill source: ${sourceSkillPath}`);
    }

    const wrappedSkill = rewriteSkillBody(
      rewriteSkillFrontmatter(sourceSkill, skillName),
      pluginRoot
    );
    const targetSkillPath = path.join(
      CODEX_SKILLS_DIR,
      formatCodexPromptName(skillName),
      "SKILL.md"
    );
    writeText(targetSkillPath, normalizeTrailingNewline(wrappedSkill));

    const frontmatterFields = extractFrontmatterFields(sourceSkill);
    const promptLines = ["---"];
    if (frontmatterFields.has("description")) {
      promptLines.push(`description: ${frontmatterFields.get("description")}`);
    }
    promptLines.push("---", "");
    promptLines.push(
      `Use the $${formatCodexSkillInvocationName(skillName)} skill for this command and follow its instructions exactly.`,
      "",
      "Treat any text after the prompt name as the raw arguments to pass through."
    );
    writeText(
      path.join(CODEX_PROMPTS_DIR, `${formatCodexPromptName(skillName)}.md`),
      normalizeTrailingNewline(promptLines.join("\n"))
    );
  }
}

function removeCodexSkillWrappers() {
  for (const skillName of EXPORTED_SKILLS) {
    fs.rmSync(path.join(CODEX_SKILLS_DIR, formatCodexPromptName(skillName)), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(CODEX_PROMPTS_DIR, `${formatCodexPromptName(skillName)}.md`), {
      force: true,
    });
  }
}

function resolveMarketplacePluginPath(pluginRoot) {
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

function loadMarketplaceFile() {
  const existing = readText(MARKETPLACE_FILE);
  if (!existing) {
    return {
      name: MARKETPLACE_NAME,
      interface: {
        displayName: MARKETPLACE_DISPLAY_NAME,
      },
      plugins: [],
    };
  }

  const parsed = JSON.parse(existing);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid marketplace file at ${MARKETPLACE_FILE}`);
  }

  if (!Array.isArray(parsed.plugins)) {
    parsed.plugins = [];
  }
  if (!parsed.name) {
    parsed.name = MARKETPLACE_NAME;
  }
  if (!parsed.interface || typeof parsed.interface !== "object") {
    parsed.interface = {};
  }
  if (!parsed.interface.displayName) {
    parsed.interface.displayName = MARKETPLACE_DISPLAY_NAME;
  }
  return parsed;
}

function saveMarketplaceFile(data) {
  if (!Array.isArray(data.plugins) || data.plugins.length === 0) {
    if (fs.existsSync(MARKETPLACE_FILE)) {
      fs.rmSync(MARKETPLACE_FILE, { force: true });
    }
    return;
  }
  writeText(MARKETPLACE_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

function upsertMarketplaceEntry(pluginRoot) {
  const pluginPath = resolveMarketplacePluginPath(pluginRoot);
  const marketplace = loadMarketplaceFile();
  const nextEntry = {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: pluginPath,
    },
    policy: {
      installation: "INSTALLED_BY_DEFAULT",
      authentication: "ON_USE",
    },
    category: "Coding",
  };

  const existingIndex = marketplace.plugins.findIndex(
    (plugin) => plugin?.name === PLUGIN_NAME
  );
  if (existingIndex >= 0) {
    marketplace.plugins.splice(existingIndex, 1, nextEntry);
  } else {
    marketplace.plugins.push(nextEntry);
  }

  saveMarketplaceFile(marketplace);
}

function removeMarketplaceEntry(pluginRoot) {
  const existing = readText(MARKETPLACE_FILE);
  if (!existing) {
    return;
  }

  const pluginPath = resolveMarketplacePluginPath(pluginRoot);
  const marketplace = loadMarketplaceFile();
  marketplace.plugins = marketplace.plugins.filter((plugin) => {
    if (plugin?.name !== PLUGIN_NAME) {
      return true;
    }
    return plugin?.source?.path !== pluginPath;
  });
  saveMarketplaceFile(marketplace);
}

function removeTomlSections(content, headers) {
  const lines = content.split("\n");
  const kept = [];
  let skip = false;
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (skip && trimmed.startsWith("[")) {
      skip = false;
    }
    if (!skip && headers.has(trimmed)) {
      skip = true;
      changed = true;
      continue;
    }
    if (!skip) {
      kept.push(line);
    }
  }

  return {
    changed,
    content: normalizeTrailingNewline(
      kept.join("\n").replace(/\n{3,}/g, "\n\n")
    ),
  };
}

function getTomlSectionBodyLines(content, header) {
  const lines = content.split("\n");
  let inSection = false;
  const body = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed === header) {
        inSection = true;
      }
      continue;
    }

    if (trimmed.startsWith("[")) {
      break;
    }

    if (trimmed !== "") {
      body.push(trimmed);
    }
  }

  return inSection ? body : null;
}

function appendTomlSection(content, header, bodyLines) {
  const base = content.replace(/\s*$/, "");
  const suffix = [header, ...bodyLines, ""].join("\n");
  if (!base) {
    return `${suffix}\n`;
  }
  return `${base}\n\n${suffix}\n`;
}

function ensurePluginEnabled(content) {
  const { content: withoutBlock } = removeTomlSections(content, new Set([PLUGIN_CONFIG_HEADER]));
  return appendTomlSection(withoutBlock, PLUGIN_CONFIG_HEADER, ['enabled = true']);
}

function ensureCodexHooksEnabled(content) {
  const lines = content.split("\n");
  const next = [];
  let inFeatures = false;
  let foundFeatures = false;
  let foundCodexHooks = false;
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (inFeatures && !foundCodexHooks) {
        next.push("codex_hooks = true");
        foundCodexHooks = true;
        changed = true;
      }
      inFeatures = trimmed === "[features]";
      foundFeatures ||= inFeatures;
      next.push(line);
      continue;
    }

    if (inFeatures && /^codex_hooks\s*=/.test(trimmed)) {
      foundCodexHooks = true;
      if (trimmed !== "codex_hooks = true") {
        next.push("codex_hooks = true");
        changed = true;
      } else {
        next.push(line);
      }
      continue;
    }

    next.push(line);
  }

  if (inFeatures && !foundCodexHooks) {
    next.push("codex_hooks = true");
    foundCodexHooks = true;
    changed = true;
  }

  if (!foundFeatures) {
    if (next.length > 0 && next[next.length - 1].trim() !== "") {
      next.push("");
    }
    next.push("[features]", "codex_hooks = true");
    changed = true;
  }

  return {
    changed,
    content: normalizeTrailingNewline(next.join("\n").replace(/\n{3,}/g, "\n\n")),
  };
}

function readConfigFile() {
  return readText(CODEX_CONFIG_FILE) ?? "";
}

function writeConfigFile(content) {
  writeText(CODEX_CONFIG_FILE, normalizeTrailingNewline(content));
}

function removeLocalPluginConfig() {
  const existing = readConfigFile();
  let nextContent = existing;
  let changed = false;

  const pluginRemoval = removeTomlSections(nextContent, new Set([PLUGIN_CONFIG_HEADER]));
  nextContent = pluginRemoval.content;
  changed ||= pluginRemoval.changed;

  const agentSection = getTomlSectionBodyLines(nextContent, AGENT_CONFIG_HEADER);
  const hasManagedAgentRegistration =
    Array.isArray(agentSection) &&
    agentSection.length === MANAGED_AGENT_REGISTRATION_LINES.length &&
    agentSection.every((line, index) => line === MANAGED_AGENT_REGISTRATION_LINES[index]);

  if (hasManagedAgentRegistration) {
    const agentRemoval = removeTomlSections(nextContent, new Set([AGENT_CONFIG_HEADER]));
    nextContent = agentRemoval.content;
    changed ||= agentRemoval.changed;
  }

  if (changed) {
    writeConfigFile(nextContent);
  }
}

function configureLocalPlugin() {
  const existing = readConfigFile();
  const withPluginEnabled = ensurePluginEnabled(existing);
  const { content } = ensureCodexHooksEnabled(withPluginEnabled);
  writeConfigFile(content);
}

function removeManagedHooks(pluginRoot) {
  const raw = readText(CODEX_HOOKS_FILE);
  if (!raw) {
    return;
  }

  const parsed = JSON.parse(raw);
  const nextHooks = {};
  let changed = false;
  const hookPrefix = normalizePathSlashes(path.join(pluginRoot, "hooks")) + "/";

  for (const [eventName, entries] of Object.entries(parsed.hooks ?? {})) {
    const keptEntries = [];
    for (const entry of entries ?? []) {
      const keptNested = (entry.hooks ?? []).filter((hook) => {
        const command = normalizePathSlashes(String(hook?.command ?? ""));
        const shouldRemove = command.includes(hookPrefix);
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

function removeManagedAgentFile() {
  const existing = readText(CODEX_AGENT_FILE);
  if (existing?.includes(MANAGED_AGENT_MARKER)) {
    fs.rmSync(CODEX_AGENT_FILE, { force: true });
  }
}

function runInstallHooks(pluginRoot) {
  const result = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "install-hooks.mjs")], {
    cwd: pluginRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function install(pluginRoot, skipHookInstall) {
  upsertMarketplaceEntry(pluginRoot);
  configureLocalPlugin();
  installCodexSkillWrappers(pluginRoot);
  if (!skipHookInstall) {
    runInstallHooks(pluginRoot);
  }
  console.log(`Installed ${PLUGIN_NAME} from ${pluginRoot}`);
}

function uninstall(pluginRoot) {
  removeMarketplaceEntry(pluginRoot);
  removeLocalPluginConfig();
  removeCodexSkillWrappers();
  removeManagedHooks(pluginRoot);
  removeManagedAgentFile();
  console.log(`Uninstalled ${PLUGIN_NAME} from ${pluginRoot}`);
}

const { command, pluginRoot, skipHookInstall } = parseArgs(process.argv.slice(2));

if (command === "install") {
  install(pluginRoot, skipHookInstall);
} else {
  uninstall(pluginRoot);
}
