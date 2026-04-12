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
  it("installs into ~/.codex/plugins/cc and registers the plugin in the personal marketplace", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createFakeCodex(homeDir);
    copyFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, fakeCodex.env);

    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const cacheDir = path.join(homeDir, ".codex", "plugins", "cache", "local-plugins", "cc", "local");
    const marketplaceFile = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    const configFile = path.join(homeDir, ".codex", "config.toml");
    const hooksFile = path.join(homeDir, ".codex", "hooks.json");
    const fallbackSkillPath = path.join(homeDir, ".codex", "skills", "cc-review", "SKILL.md");
    const fallbackPromptPath = path.join(homeDir, ".codex", "prompts", "cc-review.md");
    const installedReviewSkill = path.join(installDir, "skills", "review", "SKILL.md");
    const cachedReviewSkill = path.join(cacheDir, "skills", "review", "SKILL.md");
    const normalizedInstallDir = installDir.replace(/\\/g, "/");

    assert.ok(fs.existsSync(path.join(installDir, "scripts", "installer-cli.mjs")));
    assert.ok(fs.existsSync(path.join(cacheDir, "skills", "review", "SKILL.md")));
    assert.ok(!fs.existsSync(fallbackSkillPath));
    assert.ok(!fs.existsSync(fallbackPromptPath));
    assert.ok(fs.readFileSync(installedReviewSkill, "utf8").includes(normalizedInstallDir));
    assert.doesNotMatch(fs.readFileSync(installedReviewSkill, "utf8"), /<installed-plugin-root>/i);
    assert.ok(fs.readFileSync(cachedReviewSkill, "utf8").includes(normalizedInstallDir));
    assert.doesNotMatch(fs.readFileSync(cachedReviewSkill, "utf8"), /<installed-plugin-root>/i);

    const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
    assert.equal(marketplace.plugins[0].name, "cc");
    assert.equal(marketplace.plugins[0].source.path, "./.codex/plugins/cc");

    const config = fs.readFileSync(configFile, "utf8");
    assert.match(config, /\[plugins\."cc@local-plugins"\]/);
    assert.match(config, /enabled = true/);
    assert.match(config, /\[features\]/);
    assert.match(config, /codex_hooks = true/);

    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    const sessionStartCommand = hooks.hooks.SessionStart[0].hooks[0].command;
    assert.ok(sessionStartCommand.includes(`${installDir}/hooks/session-lifecycle-hook.mjs`));
    assert.ok(!sessionStartCommand.includes(sourceRoot));

    const requests = readFakeCodexLog(fakeCodex.logPath);
    assert.ok(
      requests.some((request) => request.method === "plugin/install"),
      "installer should use Codex's official plugin/install path"
    );
  });

  it("materializes installed skill paths for a direct local checkout install", () => {
    const homeDir = makeTempHome();
    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const fakeCodex = createFakeCodex(homeDir);
    copyFixture(installDir);

    runLocalPluginInstaller("install", installDir, homeDir, fakeCodex.env);

    const installedReviewSkill = path.join(installDir, "skills", "review", "SKILL.md");
    const skillText = fs.readFileSync(installedReviewSkill, "utf8");
    const normalizedInstallDir = installDir.replace(/\\/g, "/");

    assert.ok(skillText.includes(normalizedInstallDir));
    assert.doesNotMatch(skillText, /<installed-plugin-root>/i);
  });

  it("installs successfully when CODEX_HOME is outside the user's home directory", () => {
    const homeDir = makeTempHome();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-external-codex-home-"));
    tempHomes.push(codexHome);
    const sourceRoot = makeTempSource();
    const fakeCodex = createFakeCodex(homeDir, codexHome);
    copyFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, { ...fakeCodex.env, CODEX_HOME: codexHome });

    const installDir = path.join(codexHome, "plugins", "cc");
    const marketplaceFile = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
    const expectedPath = `./${path.relative(homeDir, installDir).replace(/\\/g, "/")}`;

    assert.ok(fs.existsSync(path.join(installDir, "scripts", "installer-cli.mjs")));
    assert.equal(marketplace.plugins[0].source.path, expectedPath);
    assert.ok(expectedPath.includes(".."));
  });

  it("falls back to config-based activation when plugin/install is unsupported", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createMethodNotFoundCodex(homeDir);
    copyFixture(sourceRoot);

    const result = runInstaller("install", homeDir, sourceRoot, fakeCodex.env);

    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const cacheDir = path.join(homeDir, ".codex", "plugins", "cache", "local-plugins", "cc", "local");
    const fallbackSkillPath = path.join(homeDir, ".codex", "skills", "cc-review", "SKILL.md");
    const fallbackPromptPath = path.join(homeDir, ".codex", "prompts", "cc-review.md");
    const configFile = path.join(homeDir, ".codex", "config.toml");
    const hooksFile = path.join(homeDir, ".codex", "hooks.json");
    const config = fs.readFileSync(configFile, "utf8");
    const requests = readFakeCodexLog(fakeCodex.logPath);

    assert.ok(fs.existsSync(path.join(installDir, "scripts", "installer-cli.mjs")));
    assert.ok(fs.existsSync(hooksFile), "fallback install should still install managed hooks");
    assert.match(config, /\[plugins\."cc@local-plugins"\]/);
    assert.match(config, /enabled = true/);
    assert.ok(!fs.existsSync(cacheDir), "fallback install should still avoid relying on the Codex cache path");
    assert.ok(fs.existsSync(fallbackSkillPath), "fallback install should expose a Codex-native skill wrapper");
    assert.ok(fs.existsSync(fallbackPromptPath), "fallback install should expose a matching prompt wrapper");
    assert.match(fs.readFileSync(fallbackSkillPath, "utf8"), /^---\nname: cc:review\n/m);
    assert.match(fs.readFileSync(fallbackPromptPath, "utf8"), /Use the \$cc:review skill/);
    assert.ok(
      requests.some((request) => request.method === "plugin/install"),
      "fallback install should still try plugin/install first"
    );
    assert.match(result.stderr, /config fallback/i);
  });

  it("falls back to config-based activation when plugin/install hangs", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createHangingCodex(homeDir);
    copyFixture(sourceRoot);

    const result = runInstaller("install", homeDir, sourceRoot, fakeCodex.env);

    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const fallbackSkillPath = path.join(homeDir, ".codex", "skills", "cc-review", "SKILL.md");
    const configFile = path.join(homeDir, ".codex", "config.toml");
    const hooksFile = path.join(homeDir, ".codex", "hooks.json");
    const config = fs.readFileSync(configFile, "utf8");
    const requests = readFakeCodexLog(fakeCodex.logPath);

    assert.ok(fs.existsSync(path.join(installDir, "scripts", "installer-cli.mjs")));
    assert.ok(fs.existsSync(hooksFile), "timeout fallback install should still install managed hooks");
    assert.match(config, /\[plugins\."cc@local-plugins"\]/);
    assert.match(config, /enabled = true/);
    assert.ok(fs.existsSync(fallbackSkillPath), "timeout fallback should also install skill wrappers");
    assert.ok(
      requests.some((request) => request.method === "plugin/install"),
      "timeout fallback install should still try plugin/install first"
    );
    assert.match(result.stderr, /timed out waiting for plugin\/install/i);
    assert.match(result.stderr, /config fallback/i);
  });

  it("removes stale fallback skill wrappers when official plugin/install succeeds", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createFakeCodex(homeDir);
    copyFixture(sourceRoot);

    const staleSkillPath = path.join(homeDir, ".codex", "skills", "cc-review", "SKILL.md");
    const stalePromptPath = path.join(homeDir, ".codex", "prompts", "cc-review.md");
    const unrelatedSkillPath = path.join(homeDir, ".codex", "skills", "keep-me", "SKILL.md");

    fs.mkdirSync(path.dirname(staleSkillPath), { recursive: true });
    fs.writeFileSync(staleSkillPath, "stale wrapper\n", "utf8");
    fs.mkdirSync(path.dirname(stalePromptPath), { recursive: true });
    fs.writeFileSync(stalePromptPath, "stale prompt\n", "utf8");
    fs.mkdirSync(path.dirname(unrelatedSkillPath), { recursive: true });
    fs.writeFileSync(unrelatedSkillPath, "leave me alone\n", "utf8");

    runInstaller("install", homeDir, sourceRoot, fakeCodex.env);

    assert.ok(!fs.existsSync(staleSkillPath));
    assert.ok(!fs.existsSync(stalePromptPath));
    assert.ok(fs.existsSync(unrelatedSkillPath), "official install should not remove unrelated user skills");
  });

  it("uninstalls cleanly while preserving unrelated user config", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createFakeCodex(homeDir);
    copyFixture(sourceRoot);

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

    runInstaller("install", homeDir, sourceRoot, fakeCodex.env);
    runInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(homeDir, ".agents", "plugins", "marketplace.json"), "utf8")
    );
    const config = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");
    const hooks = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "hooks.json"), "utf8"));

    assert.ok(!fs.existsSync(installDir));
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, "other");
    assert.match(config, /\[plugins\."github@openai-curated"\]/);
    assert.doesNotMatch(config, /\[plugins\."cc@local-plugins"\]/);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, "echo custom-hook");
  });

  it("removes managed hooks before calling Codex plugin/uninstall", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createUninstallOrderCodex(homeDir);
    copyFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, fakeCodex.env);
    runInstaller("uninstall", homeDir, sourceRoot, fakeCodex.env);

    const inspect = JSON.parse(fs.readFileSync(fakeCodex.inspectPath, "utf8"));
    assert.equal(
      inspect.managedHooksPresentAtUninstallCall,
      false,
      "managed hooks should be removed before plugin/uninstall deactivates the plugin config"
    );
  });

  it("self-cleans managed hooks after a Codex-side plugin uninstall", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createFakeCodex(homeDir);
    copyFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, fakeCodex.env);

    const codexDir = path.join(homeDir, ".codex");
    const installDir = path.join(codexDir, "plugins", "cc");
    const cacheDir = path.join(codexDir, "plugins", "cache", "local-plugins", "cc", "local");
    const configFile = path.join(codexDir, "config.toml");
    const hooksFile = path.join(codexDir, "hooks.json");
    const fallbackSkillPath = path.join(codexDir, "skills", "cc-review", "SKILL.md");
    const fallbackPromptPath = path.join(codexDir, "prompts", "cc-review.md");

    fs.mkdirSync(path.dirname(fallbackSkillPath), { recursive: true });
    fs.writeFileSync(fallbackSkillPath, "stale fallback skill\n", "utf8");
    fs.mkdirSync(path.dirname(fallbackPromptPath), { recursive: true });
    fs.writeFileSync(fallbackPromptPath, "stale fallback prompt\n", "utf8");

    fs.writeFileSync(
      configFile,
      fs
        .readFileSync(configFile, "utf8")
        .replace(/\n?\[plugins\."cc@local-plugins"\][\s\S]*?(?=\n\[|$)/, "\n"),
      "utf8"
    );
    fs.rmSync(cacheDir, { recursive: true, force: true });

    const result = spawnSync(
      process.execPath,
      [path.join(installDir, "hooks", "session-lifecycle-hook.mjs"), "SessionStart"],
      {
        cwd: installDir,
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
        },
        input: JSON.stringify({
          cwd: installDir,
          session_id: "session-cleanup-test",
          hook_event_name: "SessionStart",
        }),
        encoding: "utf8",
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const cleanedConfig = fs.readFileSync(configFile, "utf8");
    assert.ok(!fs.existsSync(hooksFile), "cleanup should remove managed global hooks once the plugin is uninstalled");
    assert.ok(!fs.existsSync(fallbackSkillPath), "cleanup should also remove managed fallback skill wrappers");
    assert.ok(!fs.existsSync(fallbackPromptPath), "cleanup should also remove managed fallback prompt wrappers");

    const marketplace = JSON.parse(
      fs.readFileSync(path.join(homeDir, ".agents", "plugins", "marketplace.json"), "utf8")
    );
    assert.equal(
      marketplace.plugins.filter((plugin) => plugin.name === "cc").length,
      1,
      "cleanup should keep the personal marketplace entry so Codex can reinstall the plugin later"
    );
  });

  it("does not self-clean managed hooks when only the Codex cache disappears", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createFakeCodex(homeDir);
    copyFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, fakeCodex.env);

    const codexDir = path.join(homeDir, ".codex");
    const installDir = path.join(codexDir, "plugins", "cc");
    const cacheDir = path.join(codexDir, "plugins", "cache", "local-plugins", "cc", "local");
    const hooksFile = path.join(codexDir, "hooks.json");
    fs.rmSync(cacheDir, { recursive: true, force: true });

    const result = spawnSync(
      process.execPath,
      [path.join(installDir, "hooks", "session-lifecycle-hook.mjs"), "SessionStart"],
      {
        cwd: installDir,
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
        },
        input: JSON.stringify({
          cwd: installDir,
          session_id: "session-cache-miss-test",
          hook_event_name: "SessionStart",
        }),
        encoding: "utf8",
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(
      fs.existsSync(hooksFile),
      "cache loss alone should not remove managed hooks while the plugin remains enabled"
    );
  });

  it("keeps install/update idempotent while refreshing the installed copy", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    const fakeCodex = createFakeCodex(homeDir);
    copyFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, fakeCodex.env);
    runInstaller("install", homeDir, sourceRoot, fakeCodex.env);

    const readmePath = path.join(sourceRoot, "README.md");
    fs.appendFileSync(
      readmePath,
      "\n<!-- installer-cli update regression marker -->\n",
      "utf8"
    );

    runInstaller("update", homeDir, sourceRoot, fakeCodex.env);

    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const installedReadme = fs.readFileSync(path.join(installDir, "README.md"), "utf8");
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(homeDir, ".agents", "plugins", "marketplace.json"), "utf8")
    );
    const config = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");
    const hooks = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "hooks.json"), "utf8"));
    const sessionStartCommands = hooks.hooks.SessionStart.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command)
    );
    const sessionEndCommands = hooks.hooks.SessionEnd.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command)
    );

    assert.match(installedReadme, /installer-cli update regression marker/);
    assert.equal(
      marketplace.plugins.filter((plugin) => plugin.name === "cc").length,
      1,
      "installer should not duplicate marketplace registrations across install/update runs"
    );
    assert.equal(
      countOccurrences(config, /\[plugins\."cc@local-plugins"\]/g),
      1,
      "installer should keep exactly one local plugin enablement block"
    );
    assert.equal(
      sessionStartCommands.filter((command) => command.includes("session-lifecycle-hook.mjs")).length,
      1,
      "installer should keep a single SessionStart lifecycle hook"
    );
    assert.equal(
      sessionEndCommands.filter((command) => command.includes("session-lifecycle-hook.mjs")).length,
      1,
      "installer should keep a single SessionEnd lifecycle hook"
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
    const fakeCodex = createFakeCodex(homeDir);
    copyFixture(sourceRoot);

    runShellWrapper("install.sh", homeDir, sourceRoot, fakeCodex.env);

    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const cacheDir = path.join(homeDir, ".codex", "plugins", "cache", "local-plugins", "cc", "local");
    const configFile = path.join(homeDir, ".codex", "config.toml");
    const marketplaceFile = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    assert.ok(fs.existsSync(path.join(installDir, "scripts", "installer-cli.mjs")));
    assert.ok(fs.existsSync(path.join(cacheDir, "skills", "review", "SKILL.md")));
    assert.ok(fs.existsSync(configFile));
    assert.ok(fs.existsSync(marketplaceFile));

    runShellWrapper("uninstall.sh", homeDir, sourceRoot, fakeCodex.env);

    const config = fs.readFileSync(configFile, "utf8");
    assert.ok(!fs.existsSync(installDir), "shell uninstall should remove the installed plugin copy");
    assert.ok(!fs.existsSync(cacheDir), "shell uninstall should remove the warmed local plugin cache");
    assert.doesNotMatch(config, /\[plugins\."cc@local-plugins"\]/);
    if (fs.existsSync(marketplaceFile)) {
      const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
      assert.equal(
        marketplace.plugins.filter((plugin) => plugin.name === "cc").length,
        0,
        "shell uninstall should remove the marketplace registration"
      );
    }
  });
});
