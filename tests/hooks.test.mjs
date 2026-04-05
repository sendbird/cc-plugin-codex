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

import { SANDBOX_STOP_REVIEW_TOOLS } from "../scripts/lib/claude-cli.mjs";
import { SESSION_ID_ENV } from "../scripts/lib/tracked-jobs.mjs";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("../", import.meta.url))
);
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

function createFakeClaudeBinary(binDir) {
  const claudePath = path.join(binDir, "claude");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);

if (process.env.CLAUDE_ARGS_FILE) {
  fs.writeFileSync(process.env.CLAUDE_ARGS_FILE, JSON.stringify(args, null, 2) + "\\n", "utf8");
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

function cleanupHookEnvironment(testEnv) {
  fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
}

function stateDirFor(homeDir, workspaceDir) {
  const realWorkspace = fs.realpathSync.native(workspaceDir);
  const workspaceHash = createHash("sha256")
    .update(realWorkspace)
    .digest("hex")
    .slice(0, 12);
  return path.join(
    homeDir,
    ".codex",
    "plugins",
    "data",
    "cc",
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

describe("hooks", () => {
  it("stop-review hook uses read-only sandbox settings when review gate is enabled", () => {
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
          last_assistant_message: "review me",
        },
        {
          ...testEnv.env,
          CLAUDE_ARGS_FILE: argsFile,
        }
      );

      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /stop-time review passed/i);
      const snapshot = readStopReviewSnapshot(testEnv);
      assert.equal(snapshot.status, "allow");
      assert.equal(snapshot.claudeInvoked, true);
      assert.equal(snapshot.sessionId, null);
      assert.equal(snapshot.hasLastAssistantMessage, true);
      const claudeArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
      const permissionModeIndex = claudeArgs.indexOf("--permission-mode");
      assert.ok(permissionModeIndex >= 0);
      assert.equal(claudeArgs[permissionModeIndex + 1], "dontAsk");
      assert.ok(claudeArgs.includes("--settings"));

      const allowedTools = [];
      for (let i = 0; i < claudeArgs.length; i++) {
        if (claudeArgs[i] === "--allowedTools") {
          allowedTools.push(claudeArgs[i + 1]);
        }
      }
      assert.deepEqual(allowedTools, SANDBOX_STOP_REVIEW_TOOLS);
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

  it("session lifecycle hook resolves queued session jobs on SessionEnd", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "queued-hook-job", {
        id: "queued-hook-job",
        status: "queued",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
        },
        testEnv.env
      );

      const job = readStateJob(testEnv, "queued-hook-job");
      assert.equal(job.status, "cancelled");
      assert.equal(job.phase, "cancelled");
      assert.equal(job.pid, null);
      assert.match(job.errorMessage ?? "", /session ended/i);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session lifecycle hook refuses to kill a stored PID without a matching identity", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "untrusted-running-job", {
        id: "untrusted-running-job",
        status: "running",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        startedAt: "2026-04-04T01:00:01Z",
        pid: process.pid,
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
          session_id: "hook-session",
        },
        testEnv.env
      );

      const job = readStateJob(testEnv, "untrusted-running-job");
      assert.equal(job.status, "cancel_failed");
      assert.equal(job.phase, "cancel_failed");
      assert.equal(job.pid, process.pid);
      assert.match(job.errorMessage ?? "", /without a matching PID identity/i);
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
      assert.match(payload.reason ?? "", /stop-time Claude Code review failed/i);

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
      assert.match(result.stderr, /stop-time review passed/i);

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
      assert.match(result.stderr, /stop-time review passed/i);
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

  it("session lifecycle hook falls back to the current-session marker on SessionEnd", () => {
    const testEnv = createHookEnvironment();

    try {
      const stateDir = stateDirFor(testEnv.homeDir, testEnv.workspaceDir);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "current-session.json"),
        JSON.stringify(
          { sessionId: "hook-session", updatedAt: "2026-04-04T01:00:00Z" },
          null,
          2
        ) + "\n",
        "utf8"
      );
      writeStateJob(testEnv, "queued-hook-job", {
        id: "queued-hook-job",
        status: "queued",
        sessionId: "hook-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
        },
        testEnv.env
      );

      const job = readStateJob(testEnv, "queued-hook-job");
      assert.equal(job.status, "cancelled");
      assert.ok(
        !fs.existsSync(path.join(stateDir, "current-session.json")),
        "SessionEnd fallback should clear the current-session marker"
      );
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("session lifecycle hook ignores fallback lookup errors on SessionEnd", () => {
    const testEnv = createHookEnvironment();

    try {
      const missingDir = path.join(testEnv.rootDir, "missing-workspace");
      const result = runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: missingDir,
        },
        testEnv.env
      );

      assert.equal(result.stdout.trim(), "");
      assert.equal(result.stderr.trim(), "");
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });

  it("nested SessionEnd does not cancel jobs owned by the parent session", () => {
    const testEnv = createHookEnvironment();

    try {
      writeStateJob(testEnv, "parent-owned-job", {
        id: "parent-owned-job",
        status: "running",
        sessionId: "parent-session",
        workspaceRoot: testEnv.workspaceDir,
        createdAt: "2026-04-04T01:00:00Z",
        startedAt: "2026-04-04T01:00:01Z",
        pid: 999999,
      });

      runHook(
        SESSION_HOOK,
        ["SessionEnd"],
        {
          cwd: testEnv.workspaceDir,
          session_id: "child-session",
        },
        {
          ...testEnv.env,
          [SESSION_ID_ENV]: "parent-session",
        }
      );

      const job = readStateJob(testEnv, "parent-owned-job");
      assert.equal(job.status, "running");
      assert.equal(job.sessionId, "parent-session");
      assert.equal(job.pid, 999999);
    } finally {
      cleanupHookEnvironment(testEnv);
    }
  });
});
