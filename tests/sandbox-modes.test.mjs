/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildArgs,
  SANDBOX_READ_ONLY_BASH_TOOLS,
  SANDBOX_READ_ONLY_TOOLS,
  SANDBOX_TEMP_DIR,
  SANDBOX_SETTINGS,
  createSandboxSettings,
  cleanupSandboxSettings,
} from "../scripts/lib/claude-cli.mjs";
import { resolvePluginRuntimeRoot } from "../scripts/lib/codex-paths.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function argsHas(args, flag, value) {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  return value === undefined || args[idx + 1] === value;
}

function argsAllowedTools(args) {
  const tools = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allowedTools") tools.push(args[i + 1]);
  }
  return tools;
}

function withTempCodexHome(run) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodexHome = process.env.CODEX_HOME;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sandbox-home-"));
  const codexHome = path.join(homeDir, ".codex");
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.CODEX_HOME = codexHome;
  try {
    return run({ homeDir, codexHome });
  } finally {
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. buildArgs — read-only mode
// ---------------------------------------------------------------------------

describe("buildArgs read-only mode", () => {
  const settingsFile = "/tmp/test-sandbox.json";
  const args = buildArgs("test prompt", {
    outputFormat: "stream-json",
    permissionMode: "dontAsk",
    allowedTools: SANDBOX_READ_ONLY_TOOLS,
    settingsFile,
  });

  it("includes --permission-mode dontAsk", () => {
    assert.ok(argsHas(args, "--permission-mode", "dontAsk"));
  });

  it("includes --settings with file path", () => {
    assert.ok(argsHas(args, "--settings", settingsFile));
  });

  it("includes every read-only tool via --allowedTools", () => {
    const tools = argsAllowedTools(args);
    assert.deepEqual(tools, SANDBOX_READ_ONLY_TOOLS);
    assert.equal(tools.length, SANDBOX_READ_ONLY_TOOLS.length);
  });

  it("includes read-only Git Bash patterns instead of a wildcard git shell", () => {
    const tools = argsAllowedTools(args);
    assert.ok(tools.includes("Read"));
    assert.ok(tools.includes("Glob"));
    assert.ok(tools.includes("Grep"));
    for (const pattern of SANDBOX_READ_ONLY_BASH_TOOLS) {
      assert.ok(tools.includes(pattern), `missing ${pattern}`);
    }
    assert.ok(!tools.includes("Bash(git:*)"));
    assert.ok(tools.includes("WebSearch"));
    assert.ok(tools.includes("WebFetch"));
    assert.ok(tools.includes("Agent(explore,plan)"));
  });

  it("does NOT include Write, Edit, Bash (unrestricted), Agent (unrestricted), Skill, MCP", () => {
    const tools = argsAllowedTools(args);
    assert.ok(!tools.includes("Write"));
    assert.ok(!tools.includes("Edit"));
    assert.ok(!tools.includes("Bash"));
    assert.ok(!tools.includes("Agent"));
    assert.ok(!tools.includes("Skill"));
    assert.ok(!tools.some((t) => t.startsWith("mcp__")));
  });

  it("includes stream-json format flags", () => {
    assert.ok(argsHas(args, "--output-format", "stream-json"));
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--include-partial-messages"));
  });
});

// ---------------------------------------------------------------------------
// 2. buildArgs — workspace-write mode
// ---------------------------------------------------------------------------

describe("buildArgs workspace-write mode", () => {
  const settingsFile = "/tmp/test-sandbox-write.json";
  const args = buildArgs("test prompt", {
    outputFormat: "stream-json",
    permissionMode: "bypassPermissions",
    settingsFile,
    // NO allowedTools — workspace-write allows everything
  });

  it("includes --permission-mode bypassPermissions", () => {
    assert.ok(argsHas(args, "--permission-mode", "bypassPermissions"));
  });

  it("includes --settings with file path", () => {
    assert.ok(argsHas(args, "--settings", settingsFile));
  });

  it("does NOT include any --allowedTools (all tools allowed)", () => {
    const tools = argsAllowedTools(args);
    assert.equal(tools.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Sandbox settings file lifecycle
// ---------------------------------------------------------------------------

describe("sandbox settings lifecycle", () => {
  it("createSandboxSettings('read-only') creates valid JSON file", () => {
    withTempCodexHome(() => {
      const f = createSandboxSettings("read-only");
      assert.ok(f);
      assert.ok(fs.existsSync(f));
      assert.ok(
        f.startsWith(path.join(resolvePluginRuntimeRoot(), "sandbox") + path.sep),
        `expected sandbox settings under ${resolvePluginRuntimeRoot()}`
      );
      const content = JSON.parse(fs.readFileSync(f, "utf8"));
      assert.deepEqual(content, SANDBOX_SETTINGS["read-only"]);
      cleanupSandboxSettings(f);
    });
  });

  it("createSandboxSettings('workspace-write') creates valid JSON file", () => {
    withTempCodexHome(() => {
      const f = createSandboxSettings("workspace-write");
      assert.ok(f);
      assert.ok(fs.existsSync(f));
      assert.ok(
        f.startsWith(path.join(resolvePluginRuntimeRoot(), "sandbox") + path.sep),
        `expected sandbox settings under ${resolvePluginRuntimeRoot()}`
      );
      const content = JSON.parse(fs.readFileSync(f, "utf8"));
      assert.deepEqual(content, SANDBOX_SETTINGS["workspace-write"]);
      cleanupSandboxSettings(f);
    });
  });

  it("createSandboxSettings('invalid') returns null", () => {
    assert.equal(createSandboxSettings("invalid"), null);
  });

  it("cleanupSandboxSettings removes the file", () => {
    withTempCodexHome(() => {
      const f = createSandboxSettings("read-only");
      assert.ok(fs.existsSync(f));
      cleanupSandboxSettings(f);
      assert.ok(!fs.existsSync(f));
    });
  });

  it("cleanupSandboxSettings(null) does not throw", () => {
    assert.doesNotThrow(() => cleanupSandboxSettings(null));
  });
});

// ---------------------------------------------------------------------------
// 4. Sandbox settings content validation
// ---------------------------------------------------------------------------

describe("sandbox settings content", () => {
  it("read-only: sandbox enabled, allowWrite temp dir only, no network", () => {
    const s = SANDBOX_SETTINGS["read-only"];
    assert.equal(s.sandbox.enabled, true);
    assert.equal(s.sandbox.autoAllowBashIfSandboxed, true);
    assert.deepEqual(s.sandbox.filesystem.allowWrite, [SANDBOX_TEMP_DIR]);
    assert.deepEqual(s.sandbox.network.allowedDomains, []);
  });

  it("workspace-write: sandbox enabled, allowWrite cwd+temp dir, no network", () => {
    const s = SANDBOX_SETTINGS["workspace-write"];
    assert.equal(s.sandbox.enabled, true);
    assert.equal(s.sandbox.autoAllowBashIfSandboxed, true);
    assert.deepEqual(s.sandbox.filesystem.allowWrite, [".", SANDBOX_TEMP_DIR]);
    assert.deepEqual(s.sandbox.network.allowedDomains, []);
  });

  it("workspace-write has broader write access than read-only", () => {
    assert.notDeepEqual(
      SANDBOX_SETTINGS["read-only"].sandbox.filesystem,
      SANDBOX_SETTINGS["workspace-write"].sandbox.filesystem
    );
    assert.deepEqual(
      SANDBOX_SETTINGS["read-only"].sandbox.network,
      SANDBOX_SETTINGS["workspace-write"].sandbox.network
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Mode consistency — read-only is the same for task/review/adversarial
// ---------------------------------------------------------------------------

describe("mode consistency", () => {
  it("SANDBOX_READ_ONLY_TOOLS includes the explicit read-only git Bash subset", () => {
    for (const pattern of SANDBOX_READ_ONLY_BASH_TOOLS) {
      assert.ok(SANDBOX_READ_ONLY_TOOLS.includes(pattern));
    }
  });

  it("read-only tools are read-only (no Write, Edit, Bash full)", () => {
    const writeTools = ["Write", "Edit", "Bash", "NotebookEdit", "Skill"];
    for (const t of writeTools) {
      assert.ok(
        !SANDBOX_READ_ONLY_TOOLS.includes(t),
        `${t} should not be in read-only tools`
      );
    }
  });

  it("workspace-write mode uses no allowedTools (verified via buildArgs)", () => {
    const args = buildArgs("p", { permissionMode: "bypassPermissions" });
    assert.equal(argsAllowedTools(args).length, 0);
  });
});
