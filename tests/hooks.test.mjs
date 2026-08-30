/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REVIEW_MCP_ALLOWED_TOOLS,
  REVIEW_MCP_SERVER_NAME,
  SANDBOX_STOP_REVIEW_TOOLS,
} from "../scripts/lib/claude-cli.mjs";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("../", import.meta.url))
);
const PROJECT_VERSION = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")
).version;
const SESSION_HOOK = path.join(
  PROJECT_ROOT,
  "hooks",
  "session-lifecycle-hook.mjs"
);
const STOP_HOOK = path.join(
  PROJECT_ROOT,
  "hooks",
  "stop-review-gate-hook.mjs"
);
const UNREAD_HOOK = path.join(
  PROJECT_ROOT,
  "hooks",
  "unread-result-hook.mjs"
);
const HOOKS_JSON = path.join(PROJECT_ROOT, "hooks", "hooks.json");
const PLUGIN_CONFIG_BLOCK = '[plugins."cc@local-plugins"]\nenabled = true\n';

function createFakeClaudeBinary(binDir) {
  const claudePath = path.join(binDir, "claude");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);

if (process.env.CLAUDE_ARGS_FILE) {
  fs.writeFileSync(process.env.CLAUDE_ARGS_FILE, JSON.stringify(args, null, 2) + "\\n", "utf8");
}
if (process.env.CLAUDE_MCP_CONFIG_FILE) {
  const mcpConfigIndex = args.indexOf("--mcp-config");
  if (mcpConfigIndex >= 0 && args[mcpConfigIndex + 1]) {
    fs.copyFileSync(args[mcpConfigIndex + 1], process.env.CLAUDE_MCP_CONFIG_FILE);
  }
}

  if (args[0] === "-p") {
  if (process.env.CLAUDE_SILENT_FAIL === "1") {
    process.exit(7);
  }
  if (process.env.CLAUDE_PREFIXED_ALLOW_RESULT === "1") {
    process.stdout.write(JSON.stringify({
      type: "stream_event",
      session_id: "hook-session-result",
      event: {
        delta: {
          type: "text_delta",
          text: "Let me verify the actual code changes from that turn.ALLOW: hook ok"
        }
      }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "hook-session-result",
      result: "ALLOW: hook ok"
    }) + "\\n");
    process.exit(0);
  }
  if (process.env.CLAUDE_UNEXPECTED_RESULT === "1") {
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "hook-session-result",
      result: "MAYBE: hook unsure"
    }) + "\\n");
    process.exit(0);
  }
  if (process.env.CLAUDE_UNKNOWN_NO_TERMINAL === "1") {
    process.stdout.write(JSON.stringify({
      type: "stream_event",
      session_id: "hook-session-result",
      event: {
        delta: {
          type: "text_delta",
          text: "ALLOW: partial"
        }
      }
    }) + "\\n");
    process.exit(0);
  }
  if (process.env.CLAUDE_LONG_BLOCK_RESULT === "1") {
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "hook-session-result",
      result: "BLOCK: " + "x".repeat(3000)
    }) + "\\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    type: "result",
    session_id: "hook-session-result",
    result: "ALLOW: hook ok"
  }) + "\\n");
  process.exit(0);
}

if (args[0] === "--version") {
  process.stdout.write("2.1.90 (Claude Code)\\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write("authenticated\\n");
  process.exit(0);
}

process.stderr.write("unexpected args: " + JSON.stringify(args) + "\\n");
process.exit(2);
`;

  fs.writeFileSync(claudePath, source, "utf8");
  fs.chmodSync(claudePath, 0o755);
}

function runGitChecked(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function initGitRepo(workspaceDir) {
  runGitChecked(["init"], workspaceDir);
  runGitChecked(["config", "user.name", "Codex Test"], workspaceDir);
  runGitChecked(["config", "user.email", "codex@example.com"], workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, "tracked.txt"), "base\n", "utf8");
  runGitChecked(["add", "tracked.txt"], workspaceDir);
  runGitChecked(["commit", "-m", "init"], workspaceDir);
}

function createHookEnvironment(options = {}) {
  const {
    createClaude = true,
    initGit = true,
  } = options;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-hooks-test-"));
  const homeDir = path.join(rootDir, "home");
  const binDir = path.join(rootDir, "bin");
  const workspaceDir = path.join(rootDir, "workspace");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".codex", "plugins", "cache", "local-plugins", "cc", "local"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), PLUGIN_CONFIG_BLOCK, "utf8");
  if (createClaude) {
    createFakeClaudeBinary(binDir);
  }
  if (initGit) {
    initGitRepo(workspaceDir);
  }

  return {
    rootDir,
    homeDir,
    workspaceDir,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  };
}

function installCachedPlugin(testEnv) {
  const pluginRoot = path.join(
    testEnv.homeDir,
    ".codex",
    "plugins",
    "cache",
    "sendbird",
    "cc",
    PROJECT_VERSION
  );
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const entry of ["hooks", "prompts", "scripts"]) {
    fs.cpSync(path.join(PROJECT_ROOT, entry), path.join(pluginRoot, entry), {
      recursive: true,
    });
  }
  fs.writeFileSync(
    path.join(testEnv.homeDir, ".codex", "config.toml"),
    '[plugins."cc@sendbird"]\nenabled = true\n',
    "utf8"
  );
  return {
    pluginDataRoot: path.join(
      testEnv.homeDir,
      ".codex",
      "plugins",
      "data",
      "cc-sendbird"
    ),
    stopHook: path.join(pluginRoot, "hooks", "stop-review-gate-hook.mjs"),
  };
}

function cleanupHookEnvironment(testEnv) {
  fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
}

function stateDirFor(homeDir, workspaceDir, pluginDataRoot = null) {
  const realWorkspace = fs.realpathSync.native(workspaceDir);
  const workspaceHash = createHash("sha256")
    .update(realWorkspace)
    .digest("hex")
    .slice(0, 12);
  return path.join(
    pluginDataRoot ?? path.join(homeDir, ".codex", "plugins", "data", "cc"),
    "state",
    workspaceHash
  );
}

function runHook(scriptPath, args, input, env) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: PROJECT_ROOT,
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function readCurrentSessionMarker(testEnv) {
  return JSON.parse(
    fs.readFileSync(
      path.join(stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "current-session.json"),
      "utf8"
    )
  );
}

function writeStateJob(testEnv, jobId, payload) {
  const jobsDir = path.join(stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, `${jobId}.json`),
    JSON.stringify({ ...payload, updatedAt: payload.updatedAt ?? payload.createdAt }, null, 2) + "\n",
    "utf8"
  );
}

function readStateJob(testEnv, jobId) {
  return JSON.parse(
    fs.readFileSync(
      path.join(stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "jobs", `${jobId}.json`),
      "utf8"
    )
  );
}

function readStopReviewSnapshot(testEnv) {
  return JSON.parse(
    fs.readFileSync(
      path.join(stateDirFor(testEnv.homeDir, testEnv.workspaceDir), "stop-review-last.json"),
      "utf8"
    )
  );
}

function writeTurnBaselineSnapshot(testEnv, sessionId, fingerprint) {
  const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `turn-baseline.${sessionId}.json`),
    JSON.stringify(
      {
        sessionId,
        cwd: testEnv.workspaceDir,
        workspaceRoot: testEnv.workspaceDir,
        capturedAt: "2026-04-04T01:00:00Z",
        fingerprint,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function writeStaleTurnBaseline(testEnv, sessionId) {
  writeTurnBaselineSnapshot(testEnv, sessionId, { signature: "stale-baseline" });
}

describe("hooks", () => {
  it("native plugin hook events stay within upstream Codex hook event names", () => {
    // codex-rs/hooks/src/lib.rs HOOK_EVENT_NAMES
    const upstreamHookEventNames = new Set([
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop",
      "Interrupt",
    ]);
    const hooksConfig = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf8"));
    const pluginHookEvents = Object.keys(hooksConfig.hooks ?? {});

    assert.ok(pluginHookEvents.length > 0);
    for (const eventName of pluginHookEvents) {
      assert.ok(
        upstreamHookEventNames.has(eventName),
        `${eventName} is not an upstream Codex hook event`
      );
    }
  });

  it("stop-review hook uses read-only sandbox and git MCP when review gate is enabled", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );

      const argsFile = path.join(testEnv.rootDir, "claude-args.json");
      const mcpConfigCaptureFile = path.join(testEnv.rootDir, "claude-mcp-config.json");
      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_ARGS_FILE: argsFile,
          CLAUDE_MCP_CONFIG_FILE: mcpConfigCaptureFile,
        }
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /turn-end review passed/i);
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "allow");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.sessionId, null);
      assert.equal(snapshot.hasLastAssistantMessage, true);
      const claudeArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
      assert.equal(claudeArgs.includes("--model"), false);
      assert.equal(claudeArgs.includes("--effort"), false);
      const permissionModeIndex = claudeArgs.indexOf("--permission-mode");
      assert.ok(permissionModeIndex >= 0);
      assert.equal(claudeArgs[permissionModeIndex + 1], "dontAsk");
      assert.ok(claudeArgs.includes("--settings"));
      assert.ok(claudeArgs.includes("--mcp-config"));
      assert.ok(claudeArgs.includes("--strict-mcp-config"));

      const allowedTools = [];
      for (let i = 0; i < claudeArgs.length; i++) {
        if (claudeArgs[i] === "--allowedTools") {
          allowedTools.push(claudeArgs[i + 1]);
        }
      }
      assert.deepEqual(
        allowedTools,
        ["Read", "Glob", "Grep", ...REVIEW_MCP_ALLOWED_TOOLS],
        "stop review must expose only read tools and the bundled read-only git MCP"
      );

      const mcpConfigIndex = claudeArgs.indexOf("--mcp-config");
      const mcpConfigPath = claudeArgs[mcpConfigIndex + 1];
      assert.equal(fs.existsSync(mcpConfigPath), false);
      const capturedMcpConfig = JSON.parse(fs.readFileSync(mcpConfigCaptureFile, "utf8"));
      const server = capturedMcpConfig.mcpServers[REVIEW_MCP_SERVER_NAME];
      assert.ok(server);
      assert.equal(
        fs.realpathSync.native(server.env.CC_GIT_ROOT),
        fs.realpathSync.native(testEnv.workspaceDir)
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook records a skipped snapshot when the review gate is disabled", () => {
    const testEnv = createHookEnvironment({
      createClaude: false,
      initGit: false,
    });

    try {
      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        testEnv.env
      );

      assert.equal(result.stdout.trim(), "");
      assert.equal(result.stderr.trim(), "");

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "skipped_config_disabled");
      assert.equal(snapshot.claudeInvoked, false);
      assert.equal(snapshot.sessionId, "hook-session");
      assert.equal(snapshot.hasLastAssistantMessage, true);
      assert.match(snapshot.reason ?? "", /disabled/i);
      assert.equal(snapshot.runningTaskNote, undefined);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("writes cached marketplace hook state under Codex's injected PLUGIN_DATA root", () => {
    const testEnv = createHookEnvironment({
      createClaude: false,
      initGit: false,
    });

    try {
      const { pluginDataRoot, stopHook } = installCachedPlugin(testEnv);
      runHook(
        stopHook,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          PLUGIN_DATA: pluginDataRoot,
        }
      );

      const snapshotFile = path.join(
        stateDirFor(testEnv.homeDir, testEnv.workspaceDir, pluginDataRoot),
        "stop-review-last.json"
      );
      assert.equal(fs.existsSync(snapshotFile), true);
      assert.equal(
        fs.existsSync(
          path.join(
            stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
            "stop-review-last.json"
          )
        ),
        false
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("ignores a PLUGIN_DATA root that does not match the installed marketplace", () => {
    const testEnv = createHookEnvironment({
      createClaude: false,
      initGit: false,
    });

    try {
      const { pluginDataRoot, stopHook } = installCachedPlugin(testEnv);
      const unexpectedRoot = path.join(testEnv.rootDir, "unexpected-plugin-data");
      runHook(
        stopHook,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          PLUGIN_DATA: unexpectedRoot,
        }
      );

      assert.equal(
        fs.existsSync(
          path.join(
            stateDirFor(testEnv.homeDir, testEnv.workspaceDir, pluginDataRoot),
            "stop-review-last.json"
          )
        ),
        true
      );
      assert.equal(fs.existsSync(unexpectedRoot), false);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook skips Claude when the latest turn made no net edits", async () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );

      const { getWorkingTreeFingerprint } = await import("../scripts/lib/git.mjs");
      const fingerprint = getWorkingTreeFingerprint(testEnv.workspaceDir);
      writeTurnBaselineSnapshot(testEnv, "hook-session", fingerprint);

      const argsFile = path.join(testEnv.rootDir, "claude-args.json");
      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_ARGS_FILE: argsFile,
        }
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /most recent turn made no net edits/i);
      assert.ok(!fs.existsSync(argsFile), "no-edit turn should skip Claude invocation");

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "skipped_no_turn_edits");
      assert.equal(snapshot.claudeInvoked, false);
      assert.equal(
        snapshot.baselineFingerprint?.signature,
        snapshot.currentFingerprint?.signature
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook skips Claude when no user turn was recorded for the session", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );

      // No turn-baseline snapshot: UserPromptSubmit never ran for this session,
      // which is what a headless Codex thread driven by another host looks like.
      const argsFile = path.join(testEnv.rootDir, "claude-args.json");
      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "headless-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_ARGS_FILE: argsFile,
        }
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /no user turn was recorded/i);
      assert.ok(
        !fs.existsSync(argsFile),
        "a session with no recorded user turn should skip Claude invocation"
      );

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "skipped_no_turn_baseline");
      assert.equal(snapshot.claudeInvoked, false);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("unread-result hook reaps stale running jobs on UserPromptSubmit", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "stale-running-job", {
        id: "stale-running-job",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        startedAt: "2026-04-04T01:00:01Z",
        pid: 99999999,
      });

      runHook(
        UNREAD_HOOK,
        [],
        {
          hook_event_name: "UserPromptSubmit",
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          prompt: "continue",
        },
        testEnv.env
      );

      const job = readStateJob(testEnv, "stale-running-job");
      assert.equal(job.status, "failed");
      assert.equal(job.phase, "failed");
      assert.equal(job.pid, null);
      assert.match(job.errorMessage ?? "", /Auto-reaped/i);
      assert.equal(readCurrentSessionMarker(testEnv).sessionId, "hook-session");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("unread-result hook does not cancel live jobs during UserPromptSubmit", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "live-running-job", {
        id: "live-running-job",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        startedAt: "2026-04-04T01:00:01Z",
        pid: process.pid,
      });

      runHook(
        UNREAD_HOOK,
        [],
        {
          hook_event_name: "UserPromptSubmit",
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          prompt: "continue",
        },
        testEnv.env
      );

      const job = readStateJob(testEnv, "live-running-job");
      assert.equal(job.status, "running");
      assert.equal(job.pid, process.pid);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session start preserves the parent marker for nested sessions and exports hook suppression", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "current-session.json"),
        JSON.stringify(
          { sessionId: "parent-session", updatedAt: "2026-04-04T01:00:00Z" },
          null,
          2
        ) + "\n",
        "utf8"
      );

      const envFile = path.join(testEnv.rootDir, "child-session.env");
      runHook(
        SESSION_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "child-session",
        },
        {
          ...testEnv.env,
          CLAUDE_ENV_FILE: envFile,
          CLAUDE_COMPANION_SESSION_ID: "parent-session",
        }
      );

      assert.equal(readCurrentSessionMarker(testEnv).sessionId, "parent-session");

      const exportedEnv = fs.readFileSync(envFile, "utf8");
      assert.match(exportedEnv, /CLAUDE_COMPANION_SESSION_ID='child-session'/);
      assert.match(exportedEnv, /CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS='1'/);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session start stamps hostOrigin when the app-server was spawned under Claude Code", () => {
    const testEnv = createHookEnvironment();

    try {
      const env = { ...testEnv.env, CLAUDECODE: "1" };
      delete env.CLAUDE_COMPANION_SESSION_ID;
      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "cc-thread" },
        env
      );
      assert.equal(readCurrentSessionMarker(testEnv).hostOrigin, "claude-code");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session start leaves hostOrigin unset for plain Codex sessions", () => {
    const testEnv = createHookEnvironment();

    try {
      const env = { ...testEnv.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      delete env.CLAUDE_COMPANION_SESSION_ID;
      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "plain-session" },
        env
      );
      const marker = readCurrentSessionMarker(testEnv);
      assert.equal(marker.sessionId, "plain-session");
      assert.equal("hostOrigin" in marker, false);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session end reaps dead background jobs, keeps live ones, and drops the session marker", () => {
    const testEnv = createHookEnvironment();

    try {
      const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
      // Older than REAP_GRACE_MS so the reaper actually inspects the PID.
      const createdAt = "2026-04-04T01:00:00Z";
      writeStateJob(testEnv, "dead-job", {
        id: "dead-job",
        status: "running",
        sessionId: "ending-session",
        pid: deadPid,
        createdAt,
      });
      writeStateJob(testEnv, "live-job", {
        id: "live-job",
        status: "running",
        sessionId: "ending-session",
        pid: process.pid,
        createdAt,
      });
      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "ending-session" },
        testEnv.env
      );

      runHook(
        SESSION_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "ending-session",
          hook_event_name: "SessionEnd",
          reason: "other",
        },
        testEnv.env
      );

      assert.equal(readStateJob(testEnv, "dead-job").status, "failed");
      const liveJob = readStateJob(testEnv, "live-job");
      assert.equal(liveJob.status, "running");
      assert.equal(liveJob.pid, process.pid);
      assert.equal(
        fs.existsSync(
          path.join(
            stateDirFor(testEnv.homeDir, testEnv.workspaceDir),
            "current-session.json"
          )
        ),
        false
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session end from another session leaves the current session marker alone", () => {
    const testEnv = createHookEnvironment();

    try {
      runHook(
        SESSION_HOOK,
        [],
        { cwd: testEnv.workspaceDir, session_id: "active-session" },
        testEnv.env
      );

      runHook(
        SESSION_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "other-session",
          hook_event_name: "SessionEnd",
          reason: "other",
        },
        testEnv.env
      );

      assert.equal(readCurrentSessionMarker(testEnv).sessionId, "active-session");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook blocks unknown Claude completion states even if partial output looks like ALLOW", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_UNKNOWN_NO_TERMINAL: "1",
        }
      );

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.decision, "block");
      assert.match(payload.reason ?? "", /No terminal result event received|unexpected answer|failed/i);
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "blocked");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.claudeStatus, "unknown");
      assert.equal(snapshot.claudeExitCode, 0);
      assert.match(snapshot.claudeWarning ?? "", /No terminal result event received/i);
      assert.equal(snapshot.claudeStderr, "");
      assert.equal(snapshot.claudeSessionId, "hook-session-result");
      assert.equal(typeof snapshot.promptBytes, "number");
      assert.ok(snapshot.promptBytes > 0);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook records silent non-zero Claude failures with exit context", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_SILENT_FAIL: "1",
        }
      );

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.decision, "block");
      assert.match(payload.reason ?? "", /turn-end Claude Code review failed/i);

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "blocked");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.claudeStatus, "failed");
      assert.equal(snapshot.claudeExitCode, 7);
      assert.equal(snapshot.claudeWarning, null);
      assert.equal(snapshot.claudeStderr, "");
      assert.equal(snapshot.claudeSessionId, null);
      assert.equal(typeof snapshot.lastAssistantMessageChars, "number");
      assert.ok(snapshot.lastAssistantMessageChars > 0);
      assert.equal(typeof snapshot.promptBytes, "number");
      assert.ok(snapshot.promptBytes > 0);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook records the raw Claude output for unexpected answers", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_UNEXPECTED_RESULT: "1",
        }
      );

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.decision, "block");
      assert.match(payload.reason ?? "", /unexpected answer/i);

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "blocked");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.firstLine, "MAYBE: hook unsure");
      assert.equal(snapshot.rawOutput, "MAYBE: hook unsure");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook caps emitted block reasons while preserving raw output", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_LONG_BLOCK_RESULT: "1",
        }
      );

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.decision, "block");
      assert.ok(
        payload.reason.length <= 1_600,
        `expected bounded reason, got ${payload.reason.length} chars`
      );
      assert.match(payload.reason, /Full stop-review output was saved/);

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "blocked");
      assert.ok(snapshot.reason.length > payload.reason.length);
      assert.equal(snapshot.rawOutput, `BLOCK: ${"x".repeat(3000)}`);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook accepts an ALLOW contract after streamed prefix chatter", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_PREFIXED_ALLOW_RESULT: "1",
        }
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /turn-end review passed/i);

      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "allow");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.firstLine, "ALLOW: hook ok");
      assert.match(snapshot.rawOutput, /^Let me verify the actual code changes/);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook allows stop to continue while noting a running same-session job", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      writeStaleTurnBaseline(testEnv, "hook-session");
      writeStateJob(testEnv, "running-review-job", {
        id: "running-review-job",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        updatedAt: "2026-04-04T01:00:01Z",
      });

      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          last_assistant_message: "review me",
        },
        testEnv.env
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /turn-end review passed/i);
      assert.match(result.stderr, /running-review-job/);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("stop-review hook skips nested subagent sessions marked for hook suppression", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );

      const argsFile = path.join(testEnv.rootDir, "claude-args.json");
      const result = runHook(
        STOP_HOOK,
        [],
        {
          cwd: testEnv.workspaceDir,
          session_id: "child-session",
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_ARGS_FILE: argsFile,
          CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS: "1",
        }
      );

      assert.equal(result.stdout.trim(), "");
      assert.equal(result.stderr.trim(), "");
      assert.ok(!fs.existsSync(argsFile), "nested stop hook should not invoke Claude");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("hook input parser rejects oversized JSON payloads", () => {
    const testEnv = createHookEnvironment();

    try {
      const result = spawnSync(process.execPath, [UNREAD_HOOK], {
        cwd: PROJECT_ROOT,
        env: {
          ...testEnv.env,
          CLAUDE_HOOK_INPUT_MAX_BYTES: "128",
        },
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
          prompt: "x".repeat(1024),
        }),
        encoding: "utf8",
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Hook input exceeds/i);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

});
