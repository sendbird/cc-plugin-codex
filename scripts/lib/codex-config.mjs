/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

function normalizeTrailingNewline(text) {
  return `${String(text).replace(/\s*$/, "")}\n`;
}

export function ensureCodexHooksEnabled(content) {
  const lines = String(content ?? "").split("\n");
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
