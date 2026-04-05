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

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

const tempHomes = [];
const tempSources = [];

function makeTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-installer-home-"));
  tempHomes.push(homeDir);
  return homeDir;
}

function makeTempSource() {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-installer-src-"));
  tempSources.push(sourceDir);
  return sourceDir;
}

function copyFixture(sourceRoot) {
  const includePaths = [
    ".codex-plugin",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "README.md",
    "agents",
    "hooks",
    "internal-skills",
    "package.json",
    "scripts",
  ];

  for (const relativePath of includePaths) {
    const sourcePath = path.join(PROJECT_ROOT, relativePath);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    const destinationPath = path.join(sourceRoot, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
  }
}

function runInstaller(command, homeDir, sourceRoot, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(sourceRoot, "scripts", "installer-cli.mjs"), command],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        ...extraEnv,
      },
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

afterEach(() => {
  while (tempHomes.length > 0) {
    fs.rmSync(tempHomes.pop(), { recursive: true, force: true });
  }
  while (tempSources.length > 0) {
    fs.rmSync(tempSources.pop(), { recursive: true, force: true });
  }
});

describe("installer-cli", () => {
  it("installs into ~/.codex/plugins/cc and registers the plugin in the personal marketplace", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    copyFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot);

    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const marketplaceFile = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    const configFile = path.join(homeDir, ".codex", "config.toml");
    const hooksFile = path.join(homeDir, ".codex", "hooks.json");
    const agentFile = path.join(homeDir, ".codex", "agents", "cc-rescue.toml");

    assert.ok(fs.existsSync(path.join(installDir, "scripts", "installer-cli.mjs")));

    const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
    assert.equal(marketplace.plugins[0].name, "cc");
    assert.equal(marketplace.plugins[0].source.path, "./.codex/plugins/cc");

    const config = fs.readFileSync(configFile, "utf8");
    assert.match(config, /\[plugins\."cc@local-plugins"\]/);
    assert.match(config, /enabled = true/);
    assert.match(config, /\[features\]/);
    assert.match(config, /codex_hooks = true/);
    assert.match(config, /\[agents\."cc-rescue"\]/);

    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    const sessionStartCommand = hooks.hooks.SessionStart[0].hooks[0].command;
    assert.ok(sessionStartCommand.includes(`${installDir}/hooks/session-lifecycle-hook.mjs`));
    assert.ok(!sessionStartCommand.includes(sourceRoot));

    const agent = fs.readFileSync(agentFile, "utf8");
    assert.ok(agent.includes(`${installDir}/scripts/claude-companion.mjs`));
    assert.ok(!agent.includes(sourceRoot));
  });

  it("installs successfully when CODEX_HOME is outside the user's home directory", () => {
    const homeDir = makeTempHome();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-external-codex-home-"));
    tempHomes.push(codexHome);
    const sourceRoot = makeTempSource();
    copyFixture(sourceRoot);

    runInstaller("install", homeDir, sourceRoot, { CODEX_HOME: codexHome });

    const installDir = path.join(codexHome, "plugins", "cc");
    const marketplaceFile = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
    const expectedPath = `./${path.relative(homeDir, installDir).replace(/\\/g, "/")}`;

    assert.ok(fs.existsSync(path.join(installDir, "scripts", "installer-cli.mjs")));
    assert.equal(marketplace.plugins[0].source.path, expectedPath);
    assert.ok(expectedPath.includes(".."));
  });

  it("uninstalls cleanly while preserving unrelated user config", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    copyFixture(sourceRoot);

    const marketplaceDir = path.join(homeDir, ".agents", "plugins");
    fs.mkdirSync(marketplaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, "marketplace.json"),
      JSON.stringify(
        {
          name: "local-plugins",
          interface: { displayName: "Local Plugins" },
          plugins: [
            {
              name: "other",
              source: { source: "local", path: "./.codex/plugins/other" },
              policy: { installation: "AVAILABLE", authentication: "ON_USE" },
              category: "Coding",
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      [
        '[plugins."github@openai-curated"]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8"
    );
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

    runInstaller("install", homeDir, sourceRoot);
    runInstaller("uninstall", homeDir, sourceRoot);

    const installDir = path.join(homeDir, ".codex", "plugins", "cc");
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(homeDir, ".agents", "plugins", "marketplace.json"), "utf8")
    );
    const config = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");
    const hooks = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "hooks.json"), "utf8"));

    assert.ok(!fs.existsSync(installDir));
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, "other");
    assert.match(config, /\[plugins\."github@openai-curated"\]/);
    assert.doesNotMatch(config, /\[plugins\."cc@local-plugins"\]/);
    assert.doesNotMatch(config, /\[agents\."cc-rescue"\]/);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, "echo custom-hook");
    assert.ok(!fs.existsSync(path.join(homeDir, ".codex", "agents", "cc-rescue.toml")));
  });

  it("preserves a user-managed cc-rescue config block on uninstall", () => {
    const homeDir = makeTempHome();
    const sourceRoot = makeTempSource();
    copyFixture(sourceRoot);

    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      [
        '[agents."cc-rescue"]',
        'description = "Custom rescue agent"',
        'config_file = "agents/custom-cc-rescue.toml"',
        "",
      ].join("\n"),
      "utf8"
    );

    runInstaller("install", homeDir, sourceRoot);
    runInstaller("uninstall", homeDir, sourceRoot);

    const config = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");
    assert.match(config, /\[agents\."cc-rescue"\]/);
    assert.match(config, /description = "Custom rescue agent"/);
    assert.match(config, /config_file = "agents\/custom-cc-rescue\.toml"/);
    assert.doesNotMatch(config, /\[plugins\."cc@local-plugins"\]/);
  });

  it("shell installer wrappers parse cleanly", () => {
    for (const scriptName of ["install.sh", "uninstall.sh"]) {
      const result = spawnSync("bash", ["-n", path.join(PROJECT_ROOT, "scripts", scriptName)], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  });
});
