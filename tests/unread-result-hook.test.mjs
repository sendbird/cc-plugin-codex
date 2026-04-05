/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("../", import.meta.url))
);
const HOOK_SCRIPT = path.join(PROJECT_ROOT, "hooks", "unread-result-hook.mjs");

function createEnv() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-unread-hook-"));
  const homeDir = path.join(rootDir, "home");
  const workspaceDir = path.join(rootDir, "workspace");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { rootDir, homeDir, workspaceDir };
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

function cleanupEnv(testEnv) {
  fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
}

function stateDirFor(testEnv) {
  const realWorkspace = fs.realpathSync.native(testEnv.workspaceDir);
  const workspaceHash = createHash("sha256").update(realWorkspace).digest("hex").slice(0, 12);
  return path.join(
    testEnv.homeDir,
    ".codex",
    "plugins",
    "data",
    "cc",
    "state",
    workspaceHash
  );
}

function writeJob(testEnv, job) {
  const jobsDir = path.join(stateDirFor(testEnv), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, `${job.id}.json`),
    JSON.stringify(job, null, 2) + "\n",
    "utf8"
  );
}

function readJob(testEnv, jobId) {
  return JSON.parse(
    fs.readFileSync(path.join(stateDirFor(testEnv), "jobs", `${jobId}.json`), "utf8")
  );
}

function runHook(testEnv, payload) {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: testEnv.homeDir,
      USERPROFILE: testEnv.homeDir,
    },
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function readTurnBaseline(testEnv, sessionId) {
  return JSON.parse(
    fs.readFileSync(
      path.join(stateDirFor(testEnv), `turn-baseline.${sessionId}.json`),
      "utf8"
    )
  );
}

function turnBaselinePath(testEnv, sessionId) {
  return path.join(stateDirFor(testEnv), `turn-baseline.${sessionId}.json`);
}

test("injects one-shot context for same-session completed unread jobs and marks them notified", () => {
  const testEnv = createEnv();
  try {
    writeJob(testEnv, {
      id: "task-a",
      sessionId: "session-a",
      status: "completed",
      kindLabel: "rescue",
      summary: "fix A",
      createdAt: "2026-04-03T10:00:00Z",
      updatedAt: "2026-04-03T10:01:00Z",
      completedAt: "2026-04-03T10:01:00Z",
    });
    writeJob(testEnv, {
      id: "task-b",
      sessionId: "session-a",
      status: "completed",
      kindLabel: "review",
      summary: "review B",
      createdAt: "2026-04-03T10:02:00Z",
      updatedAt: "2026-04-03T10:03:00Z",
      completedAt: "2026-04-03T10:03:00Z",
    });
    writeJob(testEnv, {
      id: "task-c",
      sessionId: "session-b",
      status: "completed",
      kindLabel: "rescue",
      summary: "other session",
      createdAt: "2026-04-03T10:04:00Z",
      updatedAt: "2026-04-03T10:05:00Z",
      completedAt: "2026-04-03T10:05:00Z",
    });

    const output = runHook(testEnv, {
      hook_event_name: "UserPromptSubmit",
      cwd: testEnv.workspaceDir,
      session_id: "session-a",
      prompt: "please continue with my next request",
    });

    assert.match(output, /2 Claude Code background jobs/);
    assert.match(output, /task-a/);
    assert.match(output, /task-b/);
    assert.doesNotMatch(output, /task-c/);
    assert.match(readJob(testEnv, "task-a").notifiedAt, /\d{4}-\d{2}-\d{2}T/);
    assert.match(readJob(testEnv, "task-b").notifiedAt, /\d{4}-\d{2}-\d{2}T/);
    assert.equal(readJob(testEnv, "task-c").notifiedAt, undefined);

    const second = runHook(testEnv, {
      hook_event_name: "UserPromptSubmit",
      cwd: testEnv.workspaceDir,
      session_id: "session-a",
      prompt: "another request",
    });
    assert.equal(second, "");
  } finally {
    cleanupEnv(testEnv);
  }
});

test("records a turn baseline for the current session on UserPromptSubmit", () => {
  const testEnv = createEnv();
  try {
    initGitRepo(testEnv.workspaceDir);
    fs.mkdirSync(stateDirFor(testEnv), { recursive: true });
    fs.writeFileSync(
      path.join(stateDirFor(testEnv), "config.json"),
      JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(testEnv.workspaceDir, "tracked.txt"), "base\nedit\n", "utf8");

    const output = runHook(testEnv, {
      hook_event_name: "UserPromptSubmit",
      cwd: testEnv.workspaceDir,
      session_id: "session-a",
      prompt: "continue working",
    });

    assert.equal(output, "");
    const baseline = readTurnBaseline(testEnv, "session-a");
    assert.equal(baseline.sessionId, "session-a");
    assert.equal(baseline.cwd, testEnv.workspaceDir);
    assert.ok(typeof baseline.fingerprint?.signature === "string");
    assert.ok(typeof baseline.fingerprint?.unstagedDiffHash === "string");
  } finally {
    cleanupEnv(testEnv);
  }
});

test("does not record a turn baseline when the review gate is disabled", () => {
  const testEnv = createEnv();
  try {
    initGitRepo(testEnv.workspaceDir);

    const output = runHook(testEnv, {
      hook_event_name: "UserPromptSubmit",
      cwd: testEnv.workspaceDir,
      session_id: "session-a",
      prompt: "continue working",
    });

    assert.equal(output, "");
    assert.ok(!fs.existsSync(turnBaselinePath(testEnv, "session-a")));
  } finally {
    cleanupEnv(testEnv);
  }
});

test("skips explicit status/result prompts and viewed jobs", () => {
  const testEnv = createEnv();
  try {
    writeJob(testEnv, {
      id: "task-a",
      sessionId: "session-a",
      status: "completed",
      kindLabel: "rescue",
      summary: "fix A",
      resultViewedAt: "2026-04-03T10:06:00Z",
      createdAt: "2026-04-03T10:00:00Z",
      updatedAt: "2026-04-03T10:01:00Z",
      completedAt: "2026-04-03T10:01:00Z",
    });

    const viewedOutput = runHook(testEnv, {
      hook_event_name: "UserPromptSubmit",
      cwd: testEnv.workspaceDir,
      session_id: "session-a",
      prompt: "keep going",
    });
    assert.equal(viewedOutput, "");

    writeJob(testEnv, {
      id: "task-b",
      sessionId: "session-a",
      status: "completed",
      kindLabel: "rescue",
      summary: "fix B",
      createdAt: "2026-04-03T10:02:00Z",
      updatedAt: "2026-04-03T10:03:00Z",
      completedAt: "2026-04-03T10:03:00Z",
    });

    const explicitOutput = runHook(testEnv, {
      hook_event_name: "UserPromptSubmit",
      cwd: testEnv.workspaceDir,
      session_id: "session-a",
      prompt: "$cc:status",
    });
    assert.equal(explicitOutput, "");
    assert.equal(readJob(testEnv, "task-b").notifiedAt, undefined);
  } finally {
    cleanupEnv(testEnv);
  }
});

test("skips unread-result announcements when nested-session hook suppression is enabled", () => {
  const testEnv = createEnv();
  try {
    writeJob(testEnv, {
      id: "task-a",
      sessionId: "child-session",
      status: "completed",
      kindLabel: "rescue",
      summary: "fix A",
      createdAt: "2026-04-03T10:00:00Z",
      updatedAt: "2026-04-03T10:01:00Z",
      completedAt: "2026-04-03T10:01:00Z",
    });

    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: testEnv.homeDir,
        USERPROFILE: testEnv.homeDir,
        CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS: "1",
      },
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: testEnv.workspaceDir,
        session_id: "child-session",
        prompt: "continue",
      }),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "");
    assert.equal(readJob(testEnv, "task-a").notifiedAt, undefined);
  } finally {
    cleanupEnv(testEnv);
  }
});
