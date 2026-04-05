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
  fs.mkdirSync(path.join(pluginRoot, "agents"), { recursive: true });
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
  fs.copyFileSync(
    path.join(PROJECT_ROOT, "agents", "cc-rescue.toml"),
    path.join(pluginRoot, "agents", "cc-rescue.toml")
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
  it("installs hooks, the global rescue agent, and agent config into an empty Codex home", () => {
    const homeDir = makeTempHome();
    tempHomes.push(homeDir);

    const result = runInstallHooks(homeDir);

    const hooksFile = path.join(homeDir, ".codex", "hooks.json");
    const configFile = path.join(homeDir, ".codex", "config.toml");
    const agentFile = path.join(homeDir, ".codex", "agents", "cc-rescue.toml");

    assert.ok(fs.existsSync(hooksFile));
    assert.ok(fs.existsSync(configFile));
    assert.ok(fs.existsSync(agentFile));

    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
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

    const config = fs.readFileSync(configFile, "utf8");
    assert.match(config, /\[agents\."cc-rescue"\]/);
    assert.match(config, /config_file = "agents\/cc-rescue\.toml"/);

    const agent = fs.readFileSync(agentFile, "utf8");
    assert.ok(agent.includes(`${PROJECT_ROOT}/scripts/claude-companion.mjs`));
    assert.ok(agent.includes(`${PROJECT_ROOT}/internal-skills/cli-runtime/SKILL.md`));
    assert.ok(result.stdout.includes('Global "cc-rescue" agent is installed and registered.'));
  });

  it("backs up an unmanaged existing cc-rescue agent before overwriting it", () => {
    const homeDir = makeTempHome();
    tempHomes.push(homeDir);

    const codexDir = path.join(homeDir, ".codex");
    const agentsDir = path.join(codexDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "cc-rescue.toml"),
      'developer_instructions = "custom"\n',
      "utf8"
    );

    runInstallHooks(homeDir);

    const backups = fs
      .readdirSync(agentsDir)
      .filter((name) => name.startsWith("cc-rescue.toml.bak-"));
    assert.equal(backups.length, 1);

    const backupContent = fs.readFileSync(path.join(agentsDir, backups[0]), "utf8");
    assert.equal(backupContent, 'developer_instructions = "custom"\n');

    const installedAgent = fs.readFileSync(
      path.join(agentsDir, "cc-rescue.toml"),
      "utf8"
    );
    assert.match(installedAgent, /Managed by cc-plugin-codex/);
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

    const agent = fs.readFileSync(
      path.join(homeDir, ".codex", "agents", "cc-rescue.toml"),
      "utf8"
    );
    assert.match(
      agent,
      /node '.*\$\(touch injected-marker\).*\/scripts\/claude-companion\.mjs' task/
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
