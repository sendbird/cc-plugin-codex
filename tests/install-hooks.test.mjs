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

function runInstallHooksRaw(homeDir, scriptPath = SCRIPT_PATH, cwd = PROJECT_ROOT) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
    encoding: "utf8",
  });
}

function copyInstallFixture(pluginRoot) {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, "hooks"), path.join(pluginRoot, "hooks"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(pluginRoot, "scripts"), { recursive: true });
  fs.cpSync(
    path.join(PROJECT_ROOT, "scripts", "lib"),
    path.join(pluginRoot, "scripts", "lib"),
    { recursive: true }
  );
  fs.copyFileSync(
    path.join(PROJECT_ROOT, "scripts", "install-hooks.mjs"),
    path.join(pluginRoot, "scripts", "install-hooks.mjs")
  );
  fs.copyFileSync(
    path.join(PROJECT_ROOT, "scripts", "claude-companion.mjs"),
    path.join(pluginRoot, "scripts", "claude-companion.mjs")
  );
}

const tempHomes = [];

afterEach(() => {
  while (tempHomes.length > 0) {
    const homeDir = tempHomes.pop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

describe("install-hooks.mjs", () => {
  it("installs hooks into an empty Codex home", () => {
    const homeDir = makeTempHome();
    tempHomes.push(homeDir);

    const result = runInstallHooks(homeDir);

    const hooksFile = path.join(homeDir, ".codex", "hooks.json");
    const configFile = path.join(homeDir, ".codex", "config.toml");

    assert.ok(fs.existsSync(hooksFile));
    assert.ok(fs.existsSync(configFile));

    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    const config = fs.readFileSync(configFile, "utf8");
    const sessionStartCommand =
      hooks.hooks.SessionStart[0].hooks[0].command;
    assert.ok(sessionStartCommand.includes(`${PROJECT_ROOT}/hooks/session-lifecycle-hook.mjs`));
    const sessionEndCommand =
      hooks.hooks.SessionEnd[0].hooks[0].command;
    assert.ok(
      sessionEndCommand.includes(
        `${PROJECT_ROOT}/hooks/session-lifecycle-hook.mjs' SessionEnd`
      )
    );
    const userPromptCommand =
      hooks.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(userPromptCommand.includes(`${PROJECT_ROOT}/hooks/unread-result-hook.mjs`));
    assert.match(config, /\[features\]/);
    assert.match(config, /codex_hooks = true/);
    assert.ok(result.stdout.includes("Codex hooks installation complete."));
  });

  it("upgrades an existing false codex_hooks setting to true", () => {
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
    assert.match(config, /codex_hooks = true/);
    assert.doesNotMatch(config, /codex_hooks = false/);
    assert.match(result.stdout, /Enabled codex_hooks/i);
  });

  it("does not duplicate semantically identical hook commands when quoting changes", () => {
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

    const hooks = JSON.parse(
      fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8")
    );
    assert.equal(hooks.hooks.SessionStart.length, 1);
  });

  it("shell-escapes installed hook commands when the plugin path contains command substitution syntax", () => {
    const homeDir = makeTempHome();
    tempHomes.push(homeDir);

    const pluginRoot = path.join(homeDir, "plugin $(touch injected-marker)");
    copyInstallFixture(pluginRoot);

    const scriptPath = path.join(pluginRoot, "scripts", "install-hooks.mjs");
    runInstallHooks(homeDir, scriptPath, pluginRoot);

    const hooksFile = path.join(homeDir, ".codex", "hooks.json");
    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    const sessionStartCommand =
      hooks.hooks.SessionStart[0].hooks[0].command;

    assert.match(
      sessionStartCommand,
      /node '\S.*\$\(touch injected-marker\).*session-lifecycle-hook\.mjs'/
    );

    fs.mkdirSync(
      path.join(homeDir, ".codex", "plugins", "cache", "local-plugins", "cc", "local"),
      { recursive: true }
    );
    fs.writeFileSync(
      path.join(homeDir, ".codex", "config.toml"),
      '[plugins."cc@local-plugins"]\nenabled = true\n',
      "utf8"
    );

    const runResult = spawnSync("sh", ["-lc", sessionStartCommand], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      encoding: "utf8",
    });

    assert.equal(runResult.status, 0, runResult.stderr || runResult.stdout);
    assert.ok(
      !fs.existsSync(path.join(pluginRoot, "injected-marker")),
      "hook command should not execute command substitution from the plugin path"
    );

  });

  it("rejects hook templates that resolve outside the plugin root", () => {
    const homeDir = makeTempHome();
    tempHomes.push(homeDir);

    const pluginRoot = path.join(homeDir, "plugin-outside-path");
    copyInstallFixture(pluginRoot);

    const hooksFile = path.join(pluginRoot, "hooks", "hooks.json");
    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    hooks.hooks.SessionStart[0].hooks[0].command = 'node "$PLUGIN_ROOT/../evil.sh"';
    fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2) + "\n", "utf8");

    const scriptPath = path.join(pluginRoot, "scripts", "install-hooks.mjs");
    const result = runInstallHooksRaw(homeDir, scriptPath, pluginRoot);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr || result.stdout, /outside the plugin root/i);
  });
});
