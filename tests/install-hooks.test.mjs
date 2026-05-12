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

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("../", import.meta.url))
);
const SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "install-hooks.mjs");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-install-hooks-"));
}

function runInstallHooks(homeDir, scriptPath = SCRIPT_PATH, cwd = PROJECT_ROOT) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

const tempHomes = [];

afterEach(() => {
  while (tempHomes.length > 0) {
    const homeDir = tempHomes.pop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

describe("install-hooks.mjs", () => {
  it("enables native plugin hooks in an empty Codex home", () => {
    const homeDir = makeTempHome();
    tempHomes.push(homeDir);

    const result = runInstallHooks(homeDir);

    const hooksFile = path.join(homeDir, ".codex", "hooks.json");
    const configFile = path.join(homeDir, ".codex", "config.toml");

    assert.ok(!fs.existsSync(hooksFile), "native plugin hooks should not write global hooks.json");
    assert.ok(fs.existsSync(configFile));

    const config = fs.readFileSync(configFile, "utf8");
    assert.match(config, /\[features\]/);
    assert.match(config, /hooks = true/);
    assert.match(config, /plugin_hooks = true/);
    assert.match(result.stdout, /native Codex plugin hooks/i);
  });

  it("upgrades legacy codex_hooks to native hook feature gates", () => {
    const homeDir = makeTempHome();
    tempHomes.push(homeDir);

    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      "[features]\ncodex_hooks = false\n",
      "utf8"
    );

    const result = runInstallHooks(homeDir);
    const config = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");

    assert.match(config, /\[features\]/);
    assert.match(config, /hooks = true/);
    assert.match(config, /plugin_hooks = true/);
    assert.doesNotMatch(config, /codex_hooks/);
    assert.match(result.stdout, /Enabled native Codex plugin hooks/i);
  });

  it("removes stale managed global hook commands", () => {
    const homeDir = makeTempHome();
    tempHomes.push(homeDir);

    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
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
                    command: `node "${PROJECT_ROOT}/hooks/session-lifecycle-hook.mjs"`,
                    statusMessage: "Initializing Claude Code bridge",
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

    runInstallHooks(homeDir);

    assert.ok(!fs.existsSync(path.join(codexDir, "hooks.json")));
  });

  it("does not remove unrelated global hook commands", () => {
    const homeDir = makeTempHome();
    tempHomes.push(homeDir);

    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
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

    runInstallHooks(homeDir);

    const hooks = JSON.parse(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8"));
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, "echo custom-hook");
  });
});
