/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

const tempHomes = [];
const tempSources = [];
const tempTarballs = [];
const tempHelpers = [];

function makeTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-installer-home-"));
  tempHomes.push(homeDir);
  return homeDir;
}

function makeTempSource() {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-installer-src-"));
  tempSources.push(sourceDir);
  return sourceDir;
}

function makeTempTarball() {
  const tarballPath = path.join(
    os.tmpdir(),
    `cc-installer-tarball-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`
  );
  tempTarballs.push(tarballPath);
  return tarballPath;
}

function makeTempHelper(name) {
  const helperPath = path.join(
    os.tmpdir(),
    `cc-installer-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  );
  tempHelpers.push(helperPath);
  return helperPath;
}

function copyFixture(sourceRoot) {
  const includePaths = [
    ".codex-plugin",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "README.md",
    "agents",
    "assets",
    "hooks",
    "internal-skills",
    "package.json",
    "prompts",
    "schemas",
    "scripts",
    "skills",
  ];

  for (const relativePath of includePaths) {
    const sourcePath = path.join(PROJECT_ROOT, relativePath);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    const destinationPath = path.join(sourceRoot, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
  }
}

function copyMarketplaceFixture(sourceRoot, marketplaceName = "sendbird") {
  const marketplaceRoot = path.join(sourceRoot, "sendbird-marketplace");
  const pluginRoot = path.join(marketplaceRoot, "plugins", "cc");
  copyFixture(pluginRoot);
  fs.mkdirSync(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify(
      {
        name: marketplaceName,
        interface: { displayName: "Sendbird Plugins" },
        plugins: [
          {
            name: "cc",
            source: {
              source: "local",
              path: "./plugins/cc",
            },
            policy: {
              installation: "AVAILABLE",
              authentication: "ON_USE",
            },
            category: "Coding",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return marketplaceRoot;
}

function runInstaller(command, homeDir, sourceRoot, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(sourceRoot, "scripts", "installer-cli.mjs"), command],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        ...extraEnv,
      },
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runLocalPluginInstaller(command, pluginRoot, homeDir, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(pluginRoot, "scripts", "local-plugin-install.mjs"), command, "--plugin-root", pluginRoot],
    {
      cwd: pluginRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        ...extraEnv,
      },
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runLocalPluginInstallerExpectFailure(command, pluginRoot, homeDir, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(pluginRoot, "scripts", "local-plugin-install.mjs"), command, "--plugin-root", pluginRoot],
    {
      cwd: pluginRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        ...extraEnv,
      },
      encoding: "utf8",
    }
  );

  assert.notEqual(result.status, 0, "expected local-plugin-install to fail");
  return result;
}

function createFakeCodex(homeDir, codexHome = path.join(homeDir, ".codex")) {
  const scriptPath = makeTempHelper("fake-codex-app-server");
  const logPath = path.join(codexHome, "fake-codex-requests.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    String.raw`import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [, , codexHome, logPath] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readConfig(configPath) {
  return fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
}

function normalizeTrailingNewline(text) {
  return text.replace(/\s*$/, "") + "\n";
}

function removeSection(content, header) {
  const lines = content.split("\n");
  const kept = [];
  let skip = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (skip && trimmed.startsWith("[")) {
      skip = false;
    }
    if (!skip && trimmed === header) {
      skip = true;
      continue;
    }
    if (!skip) {
      kept.push(line);
    }
  }

  return normalizeTrailingNewline(kept.join("\n").replace(/\n{3,}/g, "\n\n"));
}

function appendPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const base = removeSection(readConfig(configPath), header).replace(/\s*$/, "");
  const next = [header, "enabled = true", ""].join("\n");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, (base ? base + "\n\n" : "") + next + "\n", "utf8");
}

function clearPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const next = removeSection(readConfig(configPath), header);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, next, "utf8");
}

function copyPlugin(sourceRoot, destinationRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true });
}

function marketplaceRootFromPath(marketplacePath) {
  return path.dirname(path.dirname(path.dirname(marketplacePath)));
}

function handleInstall(params) {
  const marketplace = JSON.parse(fs.readFileSync(params.marketplacePath, "utf8"));
  const plugin = marketplace.plugins.find((entry) => entry.name === params.pluginName);
  if (!plugin) {
    throw new Error("missing plugin in marketplace");
  }
  const pluginId = params.pluginName + "@" + marketplace.name;
  const sourceRoot = path.resolve(marketplaceRootFromPath(params.marketplacePath), plugin.source.path);
  const cacheRoot = path.join(codexHome, "plugins", "cache", marketplace.name, params.pluginName, "local");
  copyPlugin(sourceRoot, cacheRoot);
  appendPluginSection(path.join(codexHome, "config.toml"), pluginId);
  return {
    authPolicy: plugin.policy?.authentication || "ON_USE",
    appsNeedingAuth: [],
  };
}

function handleUninstall(params) {
  const [pluginName, marketplaceName] = String(params.pluginId).split("@");
  const cacheRoot = path.join(codexHome, "plugins", "cache", marketplaceName, pluginName);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  clearPluginSection(path.join(codexHome, "config.toml"), params.pluginId);
  return {};
}

function logMessage(message) {
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n", "utf8");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  logMessage(message);

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }

  if (message.method === "plugin/install") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleInstall(message.params) }) + "\n");
    return;
  }

  if (message.method === "plugin/uninstall") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleUninstall(message.params) }) + "\n");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\n"
  );
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([scriptPath, codexHome, logPath]),
    },
    logPath,
  };
}

function createMarketplaceAwareCodex(homeDir, codexHome = path.join(homeDir, ".codex")) {
  const scriptPath = makeTempHelper("fake-codex-app-server-marketplace");
  const logPath = path.join(codexHome, "fake-codex-requests.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const codexHome = ${JSON.stringify(codexHome)};
const logPath = ${JSON.stringify(logPath)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function readConfig(configPath) {
  return fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
}

function normalizeTrailingNewline(text) {
  return text.replace(/\\s*$/, "") + "\\n";
}

function removeSection(content, header) {
  const lines = content.split("\\n");
  const kept = [];
  let skip = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (skip && trimmed.startsWith("[")) {
      skip = false;
    }
    if (!skip && trimmed === header) {
      skip = true;
      continue;
    }
    if (!skip) {
      kept.push(line);
    }
  }
  return normalizeTrailingNewline(kept.join("\\n").replace(/\\n{3,}/g, "\\n\\n"));
}

function appendPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const base = removeSection(readConfig(configPath), header).replace(/\\s*$/, "");
  const next = [header, "enabled = true", ""].join("\\n");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, (base ? base + "\\n\\n" : "") + next + "\\n", "utf8");
}

function copyPlugin(sourceRoot, destinationRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true });
}

function marketplaceRootFromPath(marketplacePath) {
  return path.dirname(path.dirname(path.dirname(marketplacePath)));
}

function installMarketplace(sourceRoot) {
  const marketplacePath = path.join(sourceRoot, ".agents", "plugins", "marketplace.json");
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  const installedRoot = path.join(codexHome, "marketplaces", marketplace.name);
  fs.rmSync(installedRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(installedRoot), { recursive: true });
  fs.cpSync(sourceRoot, installedRoot, { recursive: true });
  return {
    alreadyAdded: false,
    installedRoot,
    marketplaceName: marketplace.name,
  };
}

function handleInstall(params) {
  const marketplace = JSON.parse(fs.readFileSync(params.marketplacePath, "utf8"));
  const plugin = marketplace.plugins.find((entry) => entry.name === params.pluginName);
  if (!plugin) {
    throw new Error("missing plugin in marketplace");
  }
  const pluginId = params.pluginName + "@" + marketplace.name;
  const sourceRoot = path.resolve(marketplaceRootFromPath(params.marketplacePath), plugin.source.path);
  const cacheRoot = path.join(codexHome, "plugins", "cache", marketplace.name, params.pluginName, "local");
  copyPlugin(sourceRoot, cacheRoot);
  appendPluginSection(path.join(codexHome, "config.toml"), pluginId);
  return {
    authPolicy: plugin.policy?.authentication || "ON_USE",
    appsNeedingAuth: [],
  };
}

function logMessage(message) {
  fs.appendFileSync(logPath, JSON.stringify(message) + "\\n", "utf8");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  logMessage(message);

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n");
    return;
  }

  if (message.method === "marketplace/add") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: installMarketplace(message.params.source) }) + "\\n");
    return;
  }

  if (message.method === "plugin/install") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleInstall(message.params) }) + "\\n");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\\n"
  );
});\n`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: scriptPath,
    },
    logPath,
  };
}

function createMethodNotFoundCodex(homeDir, codexHome = path.join(homeDir, ".codex")) {
  const scriptPath = makeTempHelper("fake-codex-app-server-method-not-found");
  const logPath = path.join(codexHome, "fake-codex-requests.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    String.raw`import fs from "node:fs";
import readline from "node:readline";

const [, , codexHome, logPath] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function logMessage(message) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n", "utf8");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  logMessage(message);

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\n"
  );
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([scriptPath, codexHome, logPath]),
    },
    logPath,
  };
}

function createHangingCodex(homeDir, codexHome = path.join(homeDir, ".codex")) {
  const scriptPath = makeTempHelper("fake-codex-app-server-hang");
  const logPath = path.join(codexHome, "fake-codex-requests.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    String.raw`import fs from "node:fs";
import readline from "node:readline";

const [, , codexHome, logPath] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function logMessage(message) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n", "utf8");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  logMessage(message);

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }

  // Intentionally never respond to plugin/install to exercise timeout fallback.
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([scriptPath, codexHome, logPath]),
      CC_PLUGIN_CODEX_APP_SERVER_TIMEOUT_MS: "100",
    },
    logPath,
  };
}

function createUninstallOrderCodex(homeDir, codexHome = path.join(homeDir, ".codex")) {
  const scriptPath = makeTempHelper("fake-codex-app-server-uninstall-order");
  const logPath = path.join(codexHome, "fake-codex-requests.log");
  const inspectPath = path.join(codexHome, "uninstall-order.json");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    String.raw`import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [, , codexHome, logPath, inspectPath] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readConfig(configPath) {
  return fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
}

function normalizeTrailingNewline(text) {
  return text.replace(/\s*$/, "") + "\n";
}

function removeSection(content, header) {
  const lines = content.split("\n");
  const kept = [];
  let skip = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (skip && trimmed.startsWith("[")) {
      skip = false;
    }
    if (!skip && trimmed === header) {
      skip = true;
      continue;
    }
    if (!skip) {
      kept.push(line);
    }
  }

  return normalizeTrailingNewline(kept.join("\n").replace(/\n{3,}/g, "\n\n"));
}

function appendPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const base = removeSection(readConfig(configPath), header).replace(/\s*$/, "");
  const next = [header, "enabled = true", ""].join("\n");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, (base ? base + "\n\n" : "") + next + "\n", "utf8");
}

function clearPluginSection(configPath, pluginId) {
  const header = '[plugins."' + pluginId + '"]';
  const next = removeSection(readConfig(configPath), header);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, next, "utf8");
}

function copyPlugin(sourceRoot, destinationRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true });
}

function marketplaceRootFromPath(marketplacePath) {
  return path.dirname(path.dirname(path.dirname(marketplacePath)));
}

function handleInstall(params) {
  const marketplace = JSON.parse(fs.readFileSync(params.marketplacePath, "utf8"));
  const plugin = marketplace.plugins.find((entry) => entry.name === params.pluginName);
  if (!plugin) {
    throw new Error("missing plugin in marketplace");
  }
  const pluginId = params.pluginName + "@" + marketplace.name;
  const sourceRoot = path.resolve(marketplaceRootFromPath(params.marketplacePath), plugin.source.path);
  const cacheRoot = path.join(codexHome, "plugins", "cache", marketplace.name, params.pluginName, "local");
  copyPlugin(sourceRoot, cacheRoot);
  appendPluginSection(path.join(codexHome, "config.toml"), pluginId);
  return {
    authPolicy: plugin.policy?.authentication || "ON_USE",
    appsNeedingAuth: [],
  };
}

function handleUninstall(params) {
  const hooksPath = path.join(codexHome, "hooks.json");
  const hooksText = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, "utf8") : "";
  writeJson(inspectPath, {
    managedHooksPresentAtUninstallCall:
      hooksText.includes("session-lifecycle-hook.mjs") ||
      hooksText.includes("stop-review-gate-hook.mjs") ||
      hooksText.includes("unread-result-hook.mjs"),
  });

  const [pluginName, marketplaceName] = String(params.pluginId).split("@");
  const cacheRoot = path.join(codexHome, "plugins", "cache", marketplaceName, pluginName);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  clearPluginSection(path.join(codexHome, "config.toml"), params.pluginId);
  return {};
}

function logMessage(message) {
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n", "utf8");
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  logMessage(message);

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }

  if (message.method === "plugin/install") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleInstall(message.params) }) + "\n");
    return;
  }

  if (message.method === "plugin/uninstall") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handleUninstall(message.params) }) + "\n");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\n"
  );
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([
        scriptPath,
        codexHome,
        logPath,
        inspectPath,
      ]),
    },
    logPath,
    inspectPath,
  };
}

function readFakeCodexLog(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createFixtureTarball(sourceRoot) {
  const tarballPath = makeTempTarball();
  const result = spawnSync("tar", ["-czf", tarballPath, "-C", sourceRoot, "."], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return tarballPath;
}

function runShellWrapper(scriptName, homeDir, sourceRoot, extraEnv = {}) {
  const tarballPath = createFixtureTarball(sourceRoot);
  const result = spawnSync("bash", [path.join(PROJECT_ROOT, "scripts", scriptName)], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CC_PLUGIN_CODEX_TARBALL_URL: `file://${tarballPath}`,
      ...extraEnv,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function countOccurrences(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

afterEach(() => {
  while (tempHomes.length > 0) {
    fs.rmSync(tempHomes.pop(), { recursive: true, force: true });
  }
  while (tempSources.length > 0) {
    fs.rmSync(tempSources.pop(), { recursive: true, force: true });
  }
  while (tempTarballs.length > 0) {
    fs.rmSync(tempTarballs.pop(), { force: true });
  }
  while (tempHelpers.length > 0) {
    fs.rmSync(tempHelpers.pop(), { force: true });
  }
});

describe("installer-cli", () => {
  it("installs through Codex marketplace/add and plugin/install into the plugin cache", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const configFile = path.join(homeDir, ".codex", "config.toml");
    const config = fs.readFileSync(configFile, "utf8");
    const marketplaceFile = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    const hooksFile = path.join(homeDir, ".codex", "hooks.json");
    const legacyInstallDir = path.join(homeDir, ".codex", "plugins", "cc");
    const cacheDir = path.join(homeDir, ".codex", "plugins", "cache", "sendbird", "cc", "local");
    const cachedReviewSkill = path.join(cacheDir, "skills", "review", "SKILL.md");
    const requests = readFakeCodexLog(fakeCodex.logPath);
    const pluginInstallRequest = requests.find((request) => request.method === "plugin/install");

    assert.match(config, /\[plugins\."cc@sendbird"\]/);
    assert.match(config, /hooks = true/);
    assert.match(config, /plugin_hooks = true/);
    assert.ok(!fs.existsSync(legacyInstallDir), "installer should not create a stable local plugin root");
    assert.ok(!fs.existsSync(hooksFile), "installer should not write global hooks.json");
    assert.ok(fs.existsSync(cachedReviewSkill));
    assert.match(fs.readFileSync(cachedReviewSkill, "utf8"), /<plugin-root>\/scripts\/claude-companion\.mjs/);
    assert.ok(
      requests.some((request) => request.method === "marketplace/add"),
      "installer should call Codex marketplace/add"
    );
    assert.equal(
      pluginInstallRequest?.params?.marketplacePath,
      path.join(homeDir, ".codex", "marketplaces", "sendbird", ".agents", "plugins", "marketplace.json")
    );
    assert.ok(
      !fs.existsSync(marketplaceFile),
      "official marketplace installs should not mutate the personal marketplace file"
    );
  });

  it("does not fall back to local config activation when marketplace/add is unavailable", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMethodNotFoundCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    const result = spawnSync(
      process.execPath,
      [path.join(sourceRoot, "scripts", "installer-cli.mjs"), "install"],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          ...fakeCodex.env,
          CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
          CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
        },
        encoding: "utf8",
      }
    );

    const config = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");

    assert.notEqual(result.status, 0, "marketplace/add failure should fail install");
    assert.doesNotMatch(config, /\[plugins\."cc@sendbird"\]/);
    assert.ok(!fs.existsSync(path.join(homeDir, ".codex", "skills", "cc-review", "SKILL.md")));
    assert.ok(!fs.existsSync(path.join(homeDir, ".agents", "plugins", "marketplace.json")));
  });

  it("rejects direct local checkout installs", () => {
    const homeDir = makeTempHome();
    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    copyFixture(installDir);

    const result = runLocalPluginInstallerExpectFailure("install", installDir, homeDir);

    assert.match(result.stderr, /Local checkout installs are no longer supported/i);
    assert.match(result.stderr, /codex marketplace add sendbird\/codex-marketplace/i);
  });

  it("installs successfully when CODEX_HOME is outside the user's home directory", () => {
    const homeDir = makeTempHome();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-external-codex-home-"));
    tempHomes.push(codexHome);
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir, codexHome);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CODEX_HOME: codexHome,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const cacheDir = path.join(codexHome, "plugins", "cache", "sendbird", "cc", "local");

    assert.ok(fs.existsSync(path.join(cacheDir, "scripts", "installer-cli.mjs")));
  });

  it("removes stale fallback skill wrappers and legacy global hooks when official install succeeds", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    const staleSkillPath = path.join(homeDir, ".codex", "skills", "cc-review", "SKILL.md");
    const stalePromptPath = path.join(homeDir, ".codex", "prompts", "cc-review.md");
    const unrelatedSkillPath = path.join(homeDir, ".codex", "skills", "keep-me", "SKILL.md");
    const legacyInstallDir = path.join(homeDir, ".codex", "plugins", "cc");
    const hooksFile = path.join(homeDir, ".codex", "hooks.json");

    fs.mkdirSync(path.dirname(staleSkillPath), { recursive: true });
    fs.writeFileSync(staleSkillPath, "stale wrapper\n", "utf8");
    fs.mkdirSync(path.dirname(stalePromptPath), { recursive: true });
    fs.writeFileSync(stalePromptPath, "stale prompt\n", "utf8");
    fs.mkdirSync(path.dirname(unrelatedSkillPath), { recursive: true });
    fs.writeFileSync(unrelatedSkillPath, "leave me alone\n", "utf8");
    fs.mkdirSync(path.join(legacyInstallDir, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(legacyInstallDir, "hooks", "session-lifecycle-hook.mjs"), "", "utf8");
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: `node "${path.join(legacyInstallDir, "hooks", "session-lifecycle-hook.mjs")}"`,
            }],
          }],
        },
      }, null, 2) + "\n",
      "utf8"
    );

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    assert.ok(!fs.existsSync(legacyInstallDir));
    assert.ok(!fs.existsSync(hooksFile));
    assert.ok(!fs.existsSync(staleSkillPath));
    assert.ok(!fs.existsSync(stalePromptPath));
    assert.ok(fs.existsSync(unrelatedSkillPath), "official install should not remove unrelated user skills");
  });

  it("uninstalls cleanly while preserving unrelated user config", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    const marketplaceDir = path.join(homeDir, ".agents", "plugins");
    fs.mkdirSync(marketplaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, "marketplace.json"),
      JSON.stringify(
        {
          name: "local-plugins",
          interface: { displayName: "Local Plugins" },
          plugins: [
            {
              name: "other",
              source: { source: "local", path: "./.codex/plugins/other" },
              policy: { installation: "AVAILABLE", authentication: "ON_USE" },
              category: "Coding",
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      [
        '[plugins."github@openai-curated"]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(codexDir, "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "",
                hooks: [
                  {
                    type: "command",
                    command: "echo custom-hook",
                  },
                ],
              },
            ],
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const marketplacePath = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    const marketplaceBeforeUninstall = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
    marketplaceBeforeUninstall.plugins.push({
      name: "cc",
      source: { source: "local", path: "./stale/cc" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Coding",
    });
    fs.writeFileSync(marketplacePath, JSON.stringify(marketplaceBeforeUninstall, null, 2) + "\n", "utf8");

    fs.appendFileSync(
      path.join(homeDir, ".codex", "config.toml"),
      '\n[plugins."cc@sendbird"]\nenabled = true\n',
      "utf8"
    );

    runInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const marketplace = JSON.parse(
      fs.readFileSync(marketplacePath, "utf8")
    );
    const config = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");
    const hooks = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "hooks.json"), "utf8"));

    assert.ok(!fs.existsSync(installDir));
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, "other");
    assert.match(config, /\[plugins\."github@openai-curated"\]/);
    assert.doesNotMatch(config, /\[plugins\."cc@local-plugins"\]/);
    assert.doesNotMatch(config, /\[plugins\."cc@sendbird"\]/);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, "echo custom-hook");
  });

  it("removes versioned marketplace cache entries during uninstall", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const versionedCacheDir = path.join(
      homeDir,
      ".codex",
      "plugins",
      "cache",
      "sendbird",
      "cc",
      "1.0.8"
    );
    fs.mkdirSync(path.join(versionedCacheDir, "skills"), { recursive: true });
    fs.appendFileSync(
      path.join(homeDir, ".codex", "config.toml"),
      '\n[plugins."cc@sendbird"]\nenabled = true\n',
      "utf8"
    );

    runInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    assert.ok(!fs.existsSync(versionedCacheDir));
    assert.ok(!fs.existsSync(path.dirname(versionedCacheDir)));
  });

  it("removes legacy managed hook commands that point at versioned marketplace cache roots", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const codexDir = path.join(homeDir, ".codex");
    const versionedCacheDir = path.join(
      codexDir,
      "plugins",
      "cache",
      "sendbird",
      "cc",
      "1.0.9"
    );
    const hooksFile = path.join(codexDir, "hooks.json");

    fs.mkdirSync(path.join(versionedCacheDir, "hooks"), { recursive: true });
    fs.appendFileSync(
      path.join(codexDir, "config.toml"),
      '\n[plugins."cc@sendbird"]\nenabled = true\n',
      "utf8"
    );
    fs.writeFileSync(
      hooksFile,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "",
                hooks: [
                  {
                    type: "command",
                    command: `node '${path.join(versionedCacheDir, "hooks", "session-lifecycle-hook.mjs")}'`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    runInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    assert.ok(!fs.existsSync(hooksFile), "uninstall should remove managed hooks even when they point at a versioned cache root");
  });

  it("removes legacy managed hooks before calling Codex plugin/uninstall", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createUninstallOrderCodex(homeDir);
    copyFixture(sourceRoot);
    const codexDir = path.join(homeDir, ".codex");
    const cacheDir = path.join(codexDir, "plugins", "cache", "sendbird", "cc", "local");
    const hooksFile = path.join(codexDir, "hooks.json");
    fs.mkdirSync(path.join(cacheDir, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      '[plugins."cc@sendbird"]\nenabled = true\n',
      "utf8"
    );
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: `node "${path.join(cacheDir, "hooks", "session-lifecycle-hook.mjs")}"`,
            }],
          }],
        },
      }, null, 2) + "\n",
      "utf8"
    );

    runInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    const inspect = JSON.parse(fs.readFileSync(fakeCodex.inspectPath, "utf8"));
    assert.equal(
      inspect.managedHooksPresentAtUninstallCall,
      false,
      "managed hooks should be removed before plugin/uninstall deactivates the plugin config"
    );
  });

  it("keeps install/update idempotent while refreshing the cached copy", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    const installEnv = {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    };

    runInstaller("install", homeDir, sourceRoot, installEnv);
    runInstaller("install", homeDir, sourceRoot, installEnv);

    const readmePath = path.join(marketplaceRoot, "plugins", "cc", "README.md");
    fs.appendFileSync(
      readmePath,
      "\n<!-- installer-cli update regression marker -->\n",
      "utf8"
    );

    runInstaller("update", homeDir, sourceRoot, installEnv);

    const cacheDir = path.join(homeDir, ".codex", "plugins", "cache", "sendbird", "cc", "local");
    const cachedReadme = fs.readFileSync(path.join(cacheDir, "README.md"), "utf8");
    const config = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");

    assert.match(cachedReadme, /installer-cli update regression marker/);
    assert.equal(
      countOccurrences(config, /\[plugins\."cc@sendbird"\]/g),
      1,
      "installer should keep exactly one Sendbird plugin enablement block"
    );
  });

  it("shell installer wrappers parse cleanly", () => {
    for (const scriptName of ["install.sh", "uninstall.sh"]) {
      const result = spawnSync("bash", ["-n", path.join(PROJECT_ROOT, "scripts", scriptName)], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  });

  it("shell installer wrappers install and uninstall the plugin end to end", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMarketplaceAwareCodex(homeDir);
    copyFixture(sourceRoot);
    const marketplaceRoot = copyMarketplaceFixture(sourceRoot);

    runShellWrapper("install.sh", homeDir, sourceRoot, {
      ...fakeCodex.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    });

    const cacheDir = path.join(homeDir, ".codex", "plugins", "cache", "sendbird", "cc", "local");
    const configFile = path.join(homeDir, ".codex", "config.toml");
    assert.ok(fs.existsSync(path.join(cacheDir, "skills", "review", "SKILL.md")));
    assert.ok(fs.existsSync(configFile));

    runShellWrapper("uninstall.sh", homeDir, sourceRoot, fakeCodex.env);

    const config = fs.readFileSync(configFile, "utf8");
    assert.ok(!fs.existsSync(cacheDir), "shell uninstall should remove the cached plugin copy");
    assert.doesNotMatch(config, /\[plugins\."cc@sendbird"\]/);
  });
});
