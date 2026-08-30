/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { callCodexAppServer } from "./codex-app-server.mjs";
import { samePath } from "./codex-paths.mjs";

function normalizeTrailingNewline(text) {
  return `${String(text).replace(/\s*$/, "")}\n`;
}

const REQUIRED_NATIVE_HOOK_FEATURES = ["hooks"];
// Upstream Codex retired these feature flags; `codex_hooks` became `hooks` and
// `plugin_hooks` folded into it. Leaving them set keeps dead keys in user config.
const OBSOLETE_NATIVE_HOOK_FEATURES = ["codex_hooks", "plugin_hooks"];
const WRITABLE_ROOTS_KEY = "sandbox_workspace_write.writable_roots";
const MAX_CONFIG_WRITE_ATTEMPTS = 3;

function validPathStrings(paths) {
  return paths.filter(
    (value) => typeof value === "string" && value.trim() !== ""
  );
}

function includesPath(paths, candidate) {
  return validPathStrings(paths).some((value) => samePath(value, candidate));
}

function uniquePaths(paths) {
  const validPaths = validPathStrings(paths);
  return validPaths.filter(
    (candidate, index) =>
      !validPaths
        .slice(0, index)
        .some((previous) => samePath(previous, candidate))
  );
}

function selectWritableUserLayer(layers) {
  const userLayers = (layers ?? []).filter((layer) => layer?.name?.type === "user");
  return (
    userLayers.find(
      (layer) =>
        layer.name.profile != null &&
        Array.isArray(layer?.config?.sandbox_workspace_write?.writable_roots)
    ) ??
    userLayers.find(
      (layer) => layer.name.profile === null || layer.name.profile === undefined
    ) ??
    null
  );
}

async function readCodexConfig(cwd, includeLayers) {
  return callCodexAppServer({
    cwd,
    method: "config/read",
    params: {
      includeLayers,
      cwd,
    },
  });
}

export async function ensureCodexWritableRoots(cwd, writableRoots) {
  const requestedRoots = uniquePaths(writableRoots);
  if (requestedRoots.length === 0) {
    return false;
  }

  for (let attempt = 0; attempt < MAX_CONFIG_WRITE_ATTEMPTS; attempt++) {
    const response = await readCodexConfig(cwd, true);
    const effectiveRoots = Array.isArray(
      response?.config?.sandbox_workspace_write?.writable_roots
    )
      ? response.config.sandbox_workspace_write.writable_roots
      : [];
    const userLayer = selectWritableUserLayer(response?.layers);
    const userRoots = Array.isArray(
      userLayer?.config?.sandbox_workspace_write?.writable_roots
    )
      ? userLayer.config.sandbox_workspace_write.writable_roots
      : [];
    const persisted = requestedRoots.every((root) => includesPath(userRoots, root));
    const effective = requestedRoots.every((root) => includesPath(effectiveRoots, root));
    if (persisted && effective) {
      return false;
    }
    if (persisted) {
      throw new Error(
        "Plugin data roots are present in user config but are overridden by a higher-precedence Codex config layer."
      );
    }

    try {
      await callCodexAppServer({
        cwd,
        method: "config/batchWrite",
        params: {
          edits: [
            {
              keyPath: WRITABLE_ROOTS_KEY,
              value: uniquePaths([...userRoots, ...requestedRoots]),
              mergeStrategy: "replace",
            },
          ],
          filePath: userLayer?.name?.file ?? null,
          expectedVersion: userLayer?.version ?? null,
          reloadUserConfig: true,
        },
      });
      const verifiedResponse = await readCodexConfig(cwd, false);
      const verifiedRoots = Array.isArray(
        verifiedResponse?.config?.sandbox_workspace_write?.writable_roots
      )
        ? verifiedResponse.config.sandbox_workspace_write.writable_roots
        : [];
      if (!requestedRoots.every((root) => includesPath(verifiedRoots, root))) {
        throw new Error(
          "Codex accepted the user-config update, but a higher-precedence config layer still overrides the required plugin data roots."
        );
      }
      return true;
    } catch (error) {
      const conflict =
        /ConfigVersionConflict|modified since last read/i.test(
          error instanceof Error ? error.message : String(error)
        );
      if (!conflict || attempt === MAX_CONFIG_WRITE_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  return false;
}

export async function ensureCodexWritableRoot(cwd, writableRoot) {
  return ensureCodexWritableRoots(cwd, [writableRoot]);
}

export async function removeCodexWritableRoots(cwd, writableRoots) {
  const requestedRoots = uniquePaths(writableRoots);
  if (requestedRoots.length === 0) {
    return false;
  }

  for (let attempt = 0; attempt < MAX_CONFIG_WRITE_ATTEMPTS; attempt++) {
    const response = await readCodexConfig(cwd, true);
    const userLayer = selectWritableUserLayer(response?.layers);
    const userRoots = Array.isArray(
      userLayer?.config?.sandbox_workspace_write?.writable_roots
    )
      ? validPathStrings(
          userLayer.config.sandbox_workspace_write.writable_roots
        )
      : [];
    const nextRoots = userRoots.filter(
      (candidate) =>
        !requestedRoots.some((requested) => samePath(candidate, requested))
    );
    if (nextRoots.length === userRoots.length) {
      return false;
    }

    try {
      await callCodexAppServer({
        cwd,
        method: "config/batchWrite",
        params: {
          edits: [
            {
              keyPath: WRITABLE_ROOTS_KEY,
              value: nextRoots,
              mergeStrategy: "replace",
            },
          ],
          filePath: userLayer?.name?.file ?? null,
          expectedVersion: userLayer?.version ?? null,
          reloadUserConfig: true,
        },
      });
      return true;
    } catch (error) {
      const conflict =
        /ConfigVersionConflict|modified since last read/i.test(
          error instanceof Error ? error.message : String(error)
        );
      if (!conflict || attempt === MAX_CONFIG_WRITE_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  return false;
}

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
      if (OBSOLETE_NATIVE_HOOK_FEATURES.includes(featureKey)) {
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
