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
import { spawnSync } from "node:child_process";
import { resolveCodexHome } from "./lib/codex-paths.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const CODEX_HOME = resolveCodexHome();
const INSTALL_DIR = path.join(CODEX_HOME, "plugins", "cc");
const INCLUDED_PATHS = [
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

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function ensureEmptyDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDistribution(sourceRoot, destinationRoot) {
  ensureEmptyDir(destinationRoot);
  for (const relativePath of INCLUDED_PATHS) {
    const sourcePath = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    const destinationPath = path.join(destinationRoot, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
  }
}

function stageInstall(sourceRoot, installDir) {
  if (samePath(sourceRoot, installDir)) {
    return;
  }

  const stagingParent = path.dirname(installDir);
  fs.mkdirSync(stagingParent, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(stagingParent, ".cc-staging-"));

  try {
    copyDistribution(sourceRoot, stagingDir);
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, installDir);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function runLocalInstaller(installDir, command) {
  const installerPath = path.join(installDir, "scripts", "local-plugin-install.mjs");
  const result = spawnSync(process.execPath, [installerPath, command, "--plugin-root", installDir], {
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: process.env.HOME || os.homedir(),
      USERPROFILE: process.env.USERPROFILE || process.env.HOME || os.homedir(),
    },
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function installOrUpdate() {
  stageInstall(PACKAGE_ROOT, INSTALL_DIR);
  runLocalInstaller(INSTALL_DIR, "install");
  console.log(`Plugin files installed to ${INSTALL_DIR}`);
}

function uninstall() {
  if (fs.existsSync(path.join(INSTALL_DIR, "scripts", "local-plugin-install.mjs"))) {
    runLocalInstaller(INSTALL_DIR, "uninstall");
  } else if (fs.existsSync(PACKAGE_ROOT)) {
    // Uninstall can still run from a package tarball even if the installed tree is gone.
    stageInstall(PACKAGE_ROOT, INSTALL_DIR);
    runLocalInstaller(INSTALL_DIR, "uninstall");
  }

  fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
  const pluginsDir = path.dirname(INSTALL_DIR);
  if (fs.existsSync(pluginsDir) && fs.readdirSync(pluginsDir).length === 0) {
    fs.rmdirSync(pluginsDir);
  }
  console.log(`Plugin files removed from ${INSTALL_DIR}`);
}

const { command } = parseArgs(process.argv.slice(2));

if (command === "install" || command === "update") {
  installOrUpdate();
} else {
  uninstall();
}
