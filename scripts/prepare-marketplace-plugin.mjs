#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : null;

if (!DEST) {
  console.error("Usage: node scripts/prepare-marketplace-plugin.mjs <output-dir>");
  process.exit(1);
}

const INCLUDED_PATHS = [
  ".codex-plugin",
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

const EXCLUDED_SUBPATHS = new Set([
  ".agents",
  ".claude",
  ".githooks",
  ".github",
  "node_modules",
  "package-lock.json",
  "tasks",
  "tests",
]);

function emptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyPath(relativePath) {
  if (EXCLUDED_SUBPATHS.has(relativePath)) {
    return;
  }
  const source = path.join(ROOT, relativePath);
  const target = path.join(DEST, relativePath);
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
  });
}

emptyDir(DEST);
for (const relativePath of INCLUDED_PATHS) {
  copyPath(relativePath);
}

console.log(`Prepared marketplace plugin bundle at ${DEST}`);
