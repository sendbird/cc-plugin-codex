/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

function normalizeTrailingNewline(text) {
  return `${String(text).replace(/\s*$/, "")}\n`;
}

const REQUIRED_NATIVE_HOOK_FEATURES = ["hooks", "plugin_hooks"];

export function ensureNativePluginHooksEnabled(content) {
  const lines = String(content ?? "").split("\n");
  const next = [];
  let inFeatures = false;
  let foundFeatures = false;
  const found = new Set();
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (inFeatures) {
        for (const key of REQUIRED_NATIVE_HOOK_FEATURES) {
          if (!found.has(key)) {
            next.push(`${key} = true`);
            found.add(key);
            changed = true;
          }
        }
      }
      inFeatures = trimmed === "[features]";
      foundFeatures ||= inFeatures;
      next.push(line);
      continue;
    }

    if (inFeatures) {
      const featureMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/);
      const featureKey = featureMatch?.[1] ?? null;
      if (featureKey === "codex_hooks") {
        changed = true;
        continue;
      }
      if (REQUIRED_NATIVE_HOOK_FEATURES.includes(featureKey)) {
        found.add(featureKey);
        if (trimmed !== `${featureKey} = true`) {
          next.push(`${featureKey} = true`);
          changed = true;
        } else {
          next.push(line);
        }
        continue;
      }
    }

    next.push(line);
  }

  if (inFeatures) {
    for (const key of REQUIRED_NATIVE_HOOK_FEATURES) {
      if (!found.has(key)) {
        next.push(`${key} = true`);
        changed = true;
      }
    }
  }

  if (!foundFeatures) {
    if (next.length > 0 && next[next.length - 1].trim() !== "") {
      next.push("");
    }
    next.push("[features]", ...REQUIRED_NATIVE_HOOK_FEATURES.map((key) => `${key} = true`));
    changed = true;
  }

  return {
    changed,
    content: normalizeTrailingNewline(next.join("\n").replace(/\n{3,}/g, "\n\n")),
  };
}

export function nativePluginHooksStatus(content) {
  const enabled = new Map(REQUIRED_NATIVE_HOOK_FEATURES.map((key) => [key, false]));
  let inFeatures = false;

  for (const line of String(content ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inFeatures = trimmed === "[features]";
      continue;
    }
    if (!inFeatures) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(true|false)\s*(?:#.*)?$/i);
    if (!match) {
      continue;
    }
    const key = match[1] === "codex_hooks" ? "hooks" : match[1];
    if (enabled.has(key)) {
      enabled.set(key, match[2].toLowerCase() === "true");
    }
  }

  const missing = [...enabled.entries()]
    .filter(([, value]) => !value)
    .map(([key]) => key);
  return {
    installed: missing.length === 0,
    missing,
  };
}
