/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureCodexWritableRoot,
  ensureNativePluginHooksEnabled,
  nativePluginHooksStatus,
} from "../scripts/lib/codex-config.mjs";

const originalExecutable = process.env.CC_PLUGIN_CODEX_EXECUTABLE;
const originalArgs = process.env.CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON;
const tempRoots = [];

afterEach(() => {
  if (originalExecutable === undefined) {
    delete process.env.CC_PLUGIN_CODEX_EXECUTABLE;
  } else {
    process.env.CC_PLUGIN_CODEX_EXECUTABLE = originalExecutable;
  }
  if (originalArgs === undefined) {
    delete process.env.CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON;
  } else {
    process.env.CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON = originalArgs;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

it("retries writable-root updates without losing a concurrent config change", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-config-"));
  tempRoots.push(root);
  const statePath = path.join(root, "state.json");
  const serverPath = path.join(root, "fake-app-server.mjs");
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      writableRoots: ["/existing", 42],
      version: "sha256:0",
      conflictInjected: false,
    }),
    "utf8"
  );
  fs.writeFileSync(
    serverPath,
    `import fs from "node:fs";
import readline from "node:readline";
const statePath = ${JSON.stringify(statePath)};
const expectedCwd = ${JSON.stringify(root)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (message.method === "config/read") {
    if (message.params.cwd !== expectedCwd) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "config/read cwd mismatch" },
      });
      return;
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        config: {
          sandbox_workspace_write: {
            writable_roots: [...state.writableRoots, "/project-only"],
          },
        },
        origins: {},
        layers: [{
          name: { type: "user", file: "/tmp/config.toml", profile: null },
          version: state.version,
          config: {
            sandbox_workspace_write: {
              writable_roots: state.writableRoots,
            },
          },
        }],
      },
    });
    return;
  }
  if (message.method === "config/batchWrite") {
    if (
      message.params.expectedVersion !== state.version ||
      message.params.filePath !== "/tmp/config.toml"
    ) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32600,
          message: "ConfigVersionConflict: Configuration was modified since last read",
        },
      });
      return;
    }
  }
  if (message.method === "config/batchWrite" && !state.conflictInjected) {
    fs.writeFileSync(statePath, JSON.stringify({
      writableRoots: [...state.writableRoots, "/concurrent"],
      version: "sha256:1",
      conflictInjected: true,
    }), "utf8");
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32600,
        message: "ConfigVersionConflict: Configuration was modified since last read",
      },
    });
    return;
  }
  if (message.method === "config/batchWrite") {
    const edit = message.params.edits.find(
      (candidate) => candidate.keyPath === "sandbox_workspace_write.writable_roots"
    );
    fs.writeFileSync(statePath, JSON.stringify({
      writableRoots: edit.value,
      version: "sha256:2",
      conflictInjected: true,
    }), "utf8");
    write({ jsonrpc: "2.0", id: message.id, result: { status: "ok" } });
  }
});
`,
    "utf8"
  );

  process.env.CC_PLUGIN_CODEX_EXECUTABLE = process.execPath;
  process.env.CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON = JSON.stringify([serverPath]);

  assert.equal(await ensureCodexWritableRoot(root, "/target"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).writableRoots, [
    "/existing",
    "/concurrent",
    "/target",
  ]);
  assert.equal(await ensureCodexWritableRoot(root, "/target"), false);
});

it("requires only [features].hooks and strips the retired plugin_hooks gate", () => {
  const enabled = ensureNativePluginHooksEnabled(
    "[features]\nhooks = true\nplugin_hooks = true\n"
  );

  assert.equal(enabled.changed, true);
  assert.match(enabled.content, /hooks = true/);
  assert.doesNotMatch(enabled.content, /plugin_hooks/);
  assert.equal(nativePluginHooksStatus(enabled.content).installed, true);

  const clean = ensureNativePluginHooksEnabled(enabled.content);
  assert.equal(clean.changed, false);
});

it("reports native hook status from [features].hooks alone", () => {
  assert.deepEqual(nativePluginHooksStatus("[features]\nhooks = true\n"), {
    installed: true,
    missing: [],
  });
  assert.deepEqual(nativePluginHooksStatus("[features]\nplugin_hooks = true\n"), {
    installed: false,
    missing: ["hooks"],
  });
});
