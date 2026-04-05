#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE_ROOT = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : null;

if (!MARKETPLACE_ROOT) {
  console.error("Usage: node scripts/sync-marketplace-release.mjs <marketplace-repo-dir>");
  process.exit(1);
}

const pluginDir = path.join(MARKETPLACE_ROOT, "plugins", "cc");
fs.mkdirSync(path.join(MARKETPLACE_ROOT, ".agents", "plugins"), { recursive: true });

const manifest = {
  name: "sendbird-codex",
  interface: {
    displayName: "Sendbird Codex",
  },
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
};

fs.writeFileSync(
  path.join(MARKETPLACE_ROOT, ".agents", "plugins", "marketplace.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8"
);

fs.writeFileSync(
  path.join(MARKETPLACE_ROOT, "README.md"),
  [
    "# Sendbird Codex Marketplace",
    "",
    "Repo marketplace for Sendbird Codex plugins.",
    "",
    "Install:",
    "",
    "```text",
    "cc@sendbird-codex",
    "```",
    "",
  ].join("\n"),
  "utf8"
);

for (const fileName of ["LICENSE", "NOTICE"]) {
  fs.copyFileSync(
    path.join(ROOT, fileName),
    path.join(MARKETPLACE_ROOT, fileName)
  );
}

const prepare = spawnSync(
  process.execPath,
  [path.join(ROOT, "scripts", "prepare-marketplace-plugin.mjs"), pluginDir],
  {
    cwd: ROOT,
    stdio: "inherit",
  }
);

if (prepare.status !== 0) {
  process.exit(prepare.status ?? 1);
}

console.log(`Marketplace repo synced in ${MARKETPLACE_ROOT}`);
