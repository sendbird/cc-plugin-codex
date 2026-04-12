/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import path from "node:path";

import { normalizePathSlashes } from "./codex-paths.mjs";

export function materializeInstalledSkillPaths(skillTreeRoot, installedRoot = skillTreeRoot) {
  const normalizedPluginRoot = normalizePathSlashes(installedRoot);
  const skillsRoot = path.join(skillTreeRoot, "skills");
  if (!fs.existsSync(skillsRoot)) {
    return;
  }

  for (const skillName of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!skillName.isDirectory()) {
      continue;
    }
    const skillPath = path.join(skillsRoot, skillName.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      continue;
    }
    const original = fs.readFileSync(skillPath, "utf8");
    const rewritten = original.replaceAll("<installed-plugin-root>", normalizedPluginRoot);
    if (rewritten !== original) {
      fs.writeFileSync(skillPath, rewritten, "utf8");
    }
  }
}
