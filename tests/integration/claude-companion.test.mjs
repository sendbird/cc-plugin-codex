/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SESSION_ID_ENV } from "../../scripts/lib/tracked-jobs.mjs";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url))
);
const COMPANION_SCRIPT = path.join(PROJECT_ROOT, "scripts", "claude-companion.mjs");

function createFakeClaudeBinary(binDir) {
  const claudePath = path.join(binDir, "claude");
  const stubSource = `#!/usr/bin/env node
const args = process.argv.slice(2);

function getValue(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index === args.length - 1) {
    return null;
  }
  return args[index + 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(value) {
  return String(value || "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "session";
}

async function main() {
  if (args[0] === "--version") {
    process.stdout.write("2.1.90 (Claude Code)\\n");
    return;
  }

  if (args[0] === "auth" && args[1] === "status") {
    process.stdout.write("authenticated\\n");
    return;
  }

  if (args[0] !== "-p") {
    process.stderr.write("unexpected arguments: " + JSON.stringify(args) + "\\n");
    process.exitCode = 2;
    return;
  }

  const promptIndex = args.lastIndexOf("--");
  const prompt =
    promptIndex >= 0
      ? args.slice(promptIndex + 1).join(" ")
      : "";
  const delay = Number((prompt.match(/\\bdelay=(\\d+)\\b/) || [])[1] || 80);
  if (process.env.CLAUDE_ARGS_FILE) {
    require("node:fs").writeFileSync(
      process.env.CLAUDE_ARGS_FILE,
      JSON.stringify(args, null, 2) + "\\n",
      "utf8"
    );
  }
  const resumeId = getValue("--resume");
  const jsonSchema = getValue("--json-schema");
  const sessionId =
    resumeId ||
    getValue("--session-id") ||
    \`stub-\${sanitize(prompt)}-\${process.pid}\`;
  const emitUnknownNoTerminal = /\\bunknown-no-terminal\\b/.test(prompt);
  const resultText = \`completed:\${prompt}\`;
  const structuredResult = jsonSchema
    ? {
        verdict: "approve",
        summary: "Structured output path works.",
        findings: [],
        next_steps: [],
      }
    : null;

  process.stdout.write(
    JSON.stringify({
      type: "stream_event",
      session_id: sessionId,
      event: {
        delta: {
          type: "text_delta",
          text: resultText,
        },
      },
    }) + "\\n"
  );

  if (process.env.CLAUDE_INVOCATION_FILE) {
    require("node:fs").writeFileSync(
      process.env.CLAUDE_INVOCATION_FILE,
      JSON.stringify({ args, prompt, sessionId }, null, 2) + "\\n",
      "utf8"
    );
  }

  await sleep(delay);

  if (emitUnknownNoTerminal) {
    return;
  }

  process.stdout.write(
    JSON.stringify({
      type: "result",
      session_id: sessionId,
      result: structuredResult ? "" : resultText,
      ...(structuredResult
        ? { structured_output: structuredResult }
        : {}),
    }) + "\\n"
  );
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + "\\n");
  process.exitCode = 1;
});
`;

  fs.writeFileSync(claudePath, stubSource, "utf8");
  fs.chmodSync(claudePath, 0o755);
}

function createTestEnvironment() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-companion-int-"));
  const homeDir = path.join(rootDir, "home");
  const binDir = path.join(rootDir, "bin");
  const workspaceDir = path.join(rootDir, "workspace");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  createFakeClaudeBinary(binDir);

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

function cleanupTestEnvironment(testEnv) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19 || !["ENOTEMPTY", "EBUSY"].includes(error?.code)) {
        throw error;
      }
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) {
        // brief sync backoff for detached process cleanup on macOS
      }
    }
  }
}

function writeSessionScopedJob(testEnv, jobId, payload) {
  const realWorkspace = fs.realpathSync.native(testEnv.workspaceDir);
  const workspaceHash = createHash("sha256").update(realWorkspace).digest("hex").slice(0, 12);
  const stateDir = path.join(
    testEnv.homeDir,
    ".codex",
    "plugins",
    "data",
    "cc",
    "state",
    workspaceHash
  );
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, `${jobId}.json`),
    JSON.stringify({ ...payload, updatedAt: payload.updatedAt ?? payload.createdAt }, null, 2) + "\n",
    "utf8"
  );
  return { stateDir, jobsDir };
}

function writeCurrentSessionMarker(testEnv, sessionId) {
  const realWorkspace = fs.realpathSync.native(testEnv.workspaceDir);
  const workspaceHash = createHash("sha256").update(realWorkspace).digest("hex").slice(0, 12);
  const stateDir = path.join(
    testEnv.homeDir,
    ".codex",
    "plugins",
    "data",
    "cc",
    "state",
    workspaceHash
  );
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "current-session.json"),
    JSON.stringify({ sessionId, updatedAt: "2026-04-03T12:00:00Z" }, null, 2) + "\n",
    "utf8"
  );
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

function reservationPathFor(testEnv, jobId) {
  return path.join(stateDirFor(testEnv), "jobs", `${jobId}.reserve`);
}

function listStoredJobs(testEnv) {
  const jobsDir = path.join(stateDirFor(testEnv), "jobs");
  if (!fs.existsSync(jobsDir)) {
    return [];
  }
  return fs
    .readdirSync(jobsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8"))
    );
}

function readStoredJobById(testEnv, jobId) {
  return JSON.parse(
    fs.readFileSync(path.join(stateDirFor(testEnv), "jobs", `${jobId}.json`), "utf8")
  );
}

function runCompanion(args, options = {}) {
  const result = spawnSync(
    process.execPath,
    [COMPANION_SCRIPT, ...args],
    {
      cwd: PROJECT_ROOT,
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 30_000,
    }
  );

  assert.equal(
    result.status,
    0,
    `Command failed: node scripts/claude-companion.mjs ${args.join(" ")}\n${result.stderr}`
  );
  return result;
}

function runCompanionJson(args, options = {}) {
  const result = runCompanion(args, options);
  return JSON.parse(result.stdout);
}

function runCompanionExpectFailure(args, options = {}) {
  const result = spawnSync(
    process.execPath,
    [COMPANION_SCRIPT, ...args],
    {
      cwd: PROJECT_ROOT,
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 30_000,
    }
  );

  assert.notEqual(
    result.status,
    0,
    `Expected command to fail: node scripts/claude-companion.mjs ${args.join(" ")}`
  );
  return result;
}

function runCompanionAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [COMPANION_SCRIPT, ...args],
      {
        cwd: PROJECT_ROOT,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out running node scripts/claude-companion.mjs ${args.join(" ")}`
        )
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `Command failed: node scripts/claude-companion.mjs ${args.join(" ")}\n${stderr}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runCompanionAsyncJson(args, options = {}) {
  const result = await runCompanionAsync(args, options);
  return JSON.parse(result.stdout);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed in ${cwd}\n${result.stderr}`
  );
  return result.stdout.trim();
}

function setupGitWorkspace(workspaceDir) {
  runGit(workspaceDir, ["init", "--initial-branch=main"]);
  runGit(workspaceDir, ["config", "user.name", "Codex Test"]);
  runGit(workspaceDir, ["config", "user.email", "codex@example.com"]);

  fs.writeFileSync(
    path.join(workspaceDir, "app.js"),
    "export function value() {\n  return 1;\n}\n",
    "utf8"
  );
  runGit(workspaceDir, ["add", "app.js"]);
  runGit(workspaceDir, ["commit", "-m", "initial"]);
}

function seedWorkingTreeDiff(workspaceDir) {
  fs.writeFileSync(
    path.join(workspaceDir, "app.js"),
    "export function value() {\n  return 2;\n}\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspaceDir, "notes.md"),
    "# pending\n\nreview this change\n",
    "utf8"
  );
}

async function waitForJobState(testEnv, jobId, env, predicate, description, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastPayload = null;

  while (Date.now() < deadline) {
    lastPayload = runCompanionJson(
      ["result", "--cwd", testEnv.workspaceDir, "--json", jobId],
      { env }
    );
    if (predicate(lastPayload)) {
      return lastPayload;
    }
    await sleep(pollIntervalMs);
  }

  assert.fail(
    `Timed out waiting for ${description} on ${jobId}. Last payload: ${JSON.stringify(lastPayload)}`
  );
}

async function waitForTerminalResult(testEnv, jobId, env, options = {}) {
  return waitForJobState(
    testEnv,
    jobId,
    env,
    (payload) => payload.state === "terminal",
    "terminal result",
    options
  );
}

async function waitForTerminalStatus(testEnv, jobId, env, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastPayload = null;

  while (Date.now() < deadline) {
    lastPayload = runCompanionJson(
      ["status", "--cwd", testEnv.workspaceDir, "--json", jobId],
      { env }
    );
    if (lastPayload?.job?.status === "completed" || lastPayload?.job?.status === "failed") {
      return lastPayload;
    }
    await sleep(pollIntervalMs);
  }

  assert.fail(
    `Timed out waiting for terminal status on ${jobId}. Last payload: ${JSON.stringify(lastPayload)}`
  );
}

function collectCompletedJobIds(statusPayload) {
  return [
    statusPayload.latestFinished?.id ?? null,
    ...(statusPayload.recent ?? []).map((job) => job.id),
  ].filter(Boolean);
}

function collectSnapshotJobIds(statusPayload) {
  return [
    ...(statusPayload.running ?? []).map((job) => job.id),
    statusPayload.latestFinished?.id ?? null,
    ...(statusPayload.recent ?? []).map((job) => job.id),
  ].filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertCompletedTaskPayload(payload, prompt) {
  assert.equal(payload.state, "terminal");
  assert.equal(payload.job.status, "completed");
  assert.ok(payload.storedJob);
  assert.ok(payload.storedJob.result);
  assert.match(
    payload.storedJob.result.rawOutput,
    new RegExp(`completed:${escapeRegExp(prompt)}`)
  );
}

function assertCompletedReviewPayload(payload) {
  assert.equal(payload.state, "terminal");
  assert.equal(payload.job.status, "completed");
  assert.ok(payload.storedJob);
  assert.equal(payload.storedJob.result.review, "Review");
  assert.equal(payload.storedJob.result.target.mode, "working-tree");
  assert.equal(payload.storedJob.result.codex.status, "completed");
  assert.match(payload.storedJob.rendered, /# Claude Code Review/);
}

describe("claude-companion integration", () => {
  it("setup toggles the review gate on and off for the current workspace", () => {
    const testEnv = createTestEnvironment();

    try {
      const initial = runCompanionJson(
        ["setup", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.equal(initial.reviewGateEnabled, false);

      const enabled = runCompanion(
        ["setup", "--cwd", testEnv.workspaceDir, "--enable-review-gate"],
        { env: testEnv.env }
      );
      assert.match(enabled.stdout, /review gate: enabled/i);

      const afterEnable = runCompanionJson(
        ["setup", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.equal(afterEnable.reviewGateEnabled, true);

      const disabled = runCompanion(
        ["setup", "--cwd", testEnv.workspaceDir, "--disable-review-gate"],
        { env: testEnv.env }
      );
      assert.match(disabled.stdout, /review gate: disabled/i);

      const afterDisable = runCompanionJson(
        ["setup", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.equal(afterDisable.reviewGateEnabled, false);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("forwards task model, effort, prompt-file, and write mode to Claude", () => {
    const testEnv = createTestEnvironment();

    try {
      const promptFile = path.join(testEnv.workspaceDir, "task-prompt.txt");
      const argsFile = path.join(testEnv.rootDir, "task-args.json");
      fs.writeFileSync(promptFile, "prompt-file body delay=20", "utf8");

      const result = runCompanion(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--write",
          "--model",
          "haiku",
          "--effort",
          "high",
          "--prompt-file",
          promptFile,
          "--quiet-progress",
        ],
        {
          env: {
            ...testEnv.env,
            CLAUDE_ARGS_FILE: argsFile,
          },
        }
      );

      assert.match(result.stdout, /completed:prompt-file body delay=20/);

      const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
      assert.equal(args[0], "-p");
      assert.ok(args.includes("--model"));
      assert.equal(args[args.indexOf("--model") + 1], "claude-haiku-4-5");
      assert.ok(args.includes("--effort"));
      assert.equal(args[args.indexOf("--effort") + 1], "high");
      assert.ok(args.includes("--permission-mode"));
      assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
      assert.ok(!args.includes("--allowedTools"));
      assert.ok(!args.includes("--prompt-file"));
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("uses --resume to continue the latest session and keeps --fresh from injecting a resume id", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-resume-flags",
    };

    try {
      const completed = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "resume-seed delay=20",
        ],
        { env: sessionEnv }
      );
      await waitForTerminalResult(testEnv, completed.jobId, sessionEnv);

      const resumeArgsFile = path.join(testEnv.rootDir, "resume-args.json");
      runCompanion(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--resume",
          "--quiet-progress",
          "resume-follow-up delay=20",
        ],
        {
          env: {
            ...sessionEnv,
            CLAUDE_ARGS_FILE: resumeArgsFile,
          },
        }
      );

      const resumeArgs = JSON.parse(fs.readFileSync(resumeArgsFile, "utf8"));
      assert.ok(resumeArgs.includes("--resume"));
      const resumedSessionId = resumeArgs[resumeArgs.indexOf("--resume") + 1];
      assert.ok(typeof resumedSessionId === "string" && resumedSessionId.length > 0);

      const freshArgsFile = path.join(testEnv.rootDir, "fresh-args.json");
      runCompanion(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--fresh",
          "--quiet-progress",
          "fresh-follow-up delay=20",
        ],
        {
          env: {
            ...sessionEnv,
            CLAUDE_ARGS_FILE: freshArgsFile,
          },
        }
      );

      const freshArgs = JSON.parse(fs.readFileSync(freshArgsFile, "utf8"));
      assert.ok(!freshArgs.includes("--resume"));
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("forwards review model and honors explicit target selection inputs", () => {
    const testEnv = createTestEnvironment();

    try {
      setupGitWorkspace(testEnv.workspaceDir);
      seedWorkingTreeDiff(testEnv.workspaceDir);

      const reviewInvocationFile = path.join(testEnv.rootDir, "review-invocation.json");
      const reviewResult = runCompanion(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--scope",
          "working-tree",
          "--model",
          "haiku",
        ],
        {
          env: {
            ...testEnv.env,
            CLAUDE_INVOCATION_FILE: reviewInvocationFile,
          },
        }
      );

      const reviewInvocation = JSON.parse(
        fs.readFileSync(reviewInvocationFile, "utf8")
      );
      assert.equal(
        reviewInvocation.args[reviewInvocation.args.indexOf("--model") + 1],
        "claude-haiku-4-5"
      );
      assert.match(reviewInvocation.prompt, /working tree diff/i);
      assert.match(reviewResult.stdout, /Claude Code Review/);

      const branchInvocationFile = path.join(testEnv.rootDir, "branch-review-invocation.json");
      runCompanion(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--base",
          "main",
        ],
        {
          env: {
            ...testEnv.env,
            CLAUDE_INVOCATION_FILE: branchInvocationFile,
          },
        }
      );

      const branchInvocation = JSON.parse(
        fs.readFileSync(branchInvocationFile, "utf8")
      );
      assert.match(branchInvocation.prompt, /branch diff against main/i);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("forwards adversarial-review model and focus text into the prompt", () => {
    const testEnv = createTestEnvironment();

    try {
      setupGitWorkspace(testEnv.workspaceDir);
      seedWorkingTreeDiff(testEnv.workspaceDir);
      const invocationFile = path.join(testEnv.rootDir, "adversarial-invocation.json");

      const result = runCompanion(
        [
          "adversarial-review",
          "--cwd",
          testEnv.workspaceDir,
          "--scope",
          "working-tree",
          "--model",
          "haiku",
          "focus on command injection",
        ],
        {
          env: {
            ...testEnv.env,
            CLAUDE_INVOCATION_FILE: invocationFile,
          },
        }
      );

      const invocation = JSON.parse(fs.readFileSync(invocationFile, "utf8"));
      assert.equal(
        invocation.args[invocation.args.indexOf("--model") + 1],
        "claude-haiku-4-5"
      );
      assert.match(invocation.prompt, /focus on command injection/i);
      assert.match(result.stdout, /Adversarial Review/);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("status --wait honors timeout and poll interval options for a specific job id", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-status-wait",
    };

    try {
      const launch = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "status-wait delay=80",
        ],
        { env: sessionEnv }
      );

      const waited = runCompanionJson(
        [
          "status",
          "--cwd",
          testEnv.workspaceDir,
          "--json",
          "--wait",
          "--timeout-ms",
          "5000",
          "--poll-interval-ms",
          "10",
          launch.jobId,
        ],
        { env: sessionEnv }
      );

      assert.equal(waited.job.id, launch.jobId);
      assert.equal(waited.waitTimedOut, false);
      assert.equal(waited.job.status, "completed");
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("filters status overview to the current session marker when env is unavailable", () => {
    const testEnv = createTestEnvironment();

    try {
      writeSessionScopedJob(testEnv, "status-fallback-a", {
        id: "status-fallback-a",
        status: "completed",
        jobClass: "task",
        sessionId: "session-a",
        createdAt: "2026-04-03T10:00:00Z",
        completedAt: "2026-04-03T10:00:01Z",
        updatedAt: "2026-04-03T10:00:01Z",
      });
      writeSessionScopedJob(testEnv, "status-fallback-b", {
        id: "status-fallback-b",
        status: "completed",
        jobClass: "task",
        sessionId: "session-b",
        createdAt: "2026-04-03T11:00:00Z",
        completedAt: "2026-04-03T11:00:01Z",
        updatedAt: "2026-04-03T11:00:01Z",
      });

      writeCurrentSessionMarker(testEnv, "session-a");
      const statusPayload = runCompanionJson(
        ["status", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );

      assert.equal(statusPayload.latestFinished.id, "status-fallback-a");
      const recentIds = statusPayload.recent.map((job) => job.id);
      assert.ok(!recentIds.includes("status-fallback-b"));
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("uses an explicit owner session id so rescue-launched jobs stay visible to the parent session", async () => {
    const testEnv = createTestEnvironment();
    const childSessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "child-session",
    };

    try {
      writeCurrentSessionMarker(testEnv, "parent-session");

      const launch = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "--owner-session-id",
          "parent-session",
          "owner-session-visible delay=20",
        ],
        { env: childSessionEnv }
      );
      await waitForTerminalStatus(testEnv, launch.jobId, childSessionEnv);

      const storedJob = readStoredJobById(testEnv, launch.jobId);
      assert.equal(storedJob.sessionId, "parent-session");
      assert.equal(
        JSON.parse(
          fs.readFileSync(path.join(stateDirFor(testEnv), "current-session.json"), "utf8")
        ).sessionId,
        "parent-session"
      );

      const statusPayload = runCompanionJson(
        ["status", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.equal(statusPayload.latestFinished?.id, launch.jobId);

      const resumeCandidate = runCompanionJson(
        ["task-resume-candidate", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.equal(resumeCandidate.available, true);
      assert.equal(resumeCandidate.sessionId, "parent-session");
      assert.equal(resumeCandidate.candidate?.id, launch.jobId);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("uses an explicit owner session id so background review jobs stay visible to the parent session", async () => {
    const testEnv = createTestEnvironment();
    const childSessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "child-review-session",
    };

    try {
      setupGitWorkspace(testEnv.workspaceDir);
      seedWorkingTreeDiff(testEnv.workspaceDir);
      writeCurrentSessionMarker(testEnv, "parent-review-session");

      const launch = await runCompanionAsyncJson(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "--scope",
          "working-tree",
          "--owner-session-id",
          "parent-review-session",
        ],
        { env: childSessionEnv }
      );
      await waitForTerminalStatus(testEnv, launch.jobId, childSessionEnv);

      const storedJob = readStoredJobById(testEnv, launch.jobId);
      assert.equal(storedJob.sessionId, "parent-review-session");
      assert.equal(
        JSON.parse(
          fs.readFileSync(path.join(stateDirFor(testEnv), "current-session.json"), "utf8")
        ).sessionId,
        "parent-review-session"
      );

      const statusPayload = runCompanionJson(
        ["status", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.equal(statusPayload.latestFinished?.id, launch.jobId);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("rejects invalid owner session ids before creating a background review job", () => {
    const testEnv = createTestEnvironment();

    try {
      setupGitWorkspace(testEnv.workspaceDir);
      seedWorkingTreeDiff(testEnv.workspaceDir);

      const result = runCompanionExpectFailure(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "--scope",
          "working-tree",
          "--owner-session-id",
          "invalid session id",
        ],
        { env: testEnv.env }
      );

      assert.match(result.stderr, /Invalid session ID/);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("rejects a missing owner session id before the next routing flag is consumed", () => {
    const testEnv = createTestEnvironment();

    try {
      setupGitWorkspace(testEnv.workspaceDir);
      seedWorkingTreeDiff(testEnv.workspaceDir);

      const result = runCompanionExpectFailure(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "--scope",
          "working-tree",
          "--owner-session-id",
          "--job-id",
          "review-bad-owner-session",
        ],
        { env: testEnv.env }
      );

      assert.match(result.stderr, /Missing value for --owner-session-id/);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("reports session routing context from env and current-session marker", () => {
    const testEnv = createTestEnvironment();

    try {
      writeCurrentSessionMarker(testEnv, "marker-session");
      const payload = runCompanionJson(
        ["session-routing-context", "--cwd", testEnv.workspaceDir, "--json"],
        {
          env: {
            ...testEnv.env,
            [SESSION_ID_ENV]: "env-session",
            CODEX_THREAD_ID: "thread-123",
          },
        }
      );

      assert.equal(payload.ownerSessionId, "env-session");
      assert.equal(payload.parentThreadId, "thread-123");
      assert.equal(payload.workspaceRoot, testEnv.workspaceDir);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("drops invalid parent thread ids from session routing context", () => {
    const testEnv = createTestEnvironment();

    try {
      const payload = runCompanionJson(
        ["session-routing-context", "--cwd", testEnv.workspaceDir, "--json"],
        {
          env: {
            ...testEnv.env,
            [SESSION_ID_ENV]: "env-session",
            CODEX_THREAD_ID: "--bad-thread-id",
          },
        }
      );

      assert.equal(payload.ownerSessionId, "env-session");
      assert.equal(payload.parentThreadId, null);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("reports background routing context with a reserved review job id", () => {
    const testEnv = createTestEnvironment();

    try {
      writeCurrentSessionMarker(testEnv, "marker-session");
      const payload = runCompanionJson(
        ["background-routing-context", "--kind", "review", "--cwd", testEnv.workspaceDir, "--json"],
        {
          env: {
            ...testEnv.env,
            [SESSION_ID_ENV]: "env-session",
            CODEX_THREAD_ID: "thread-123",
          },
        }
      );

      assert.equal(payload.ownerSessionId, "env-session");
      assert.equal(payload.parentThreadId, "thread-123");
      assert.match(payload.jobId, /^review-/);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("keeps completed resume candidates session-scoped and ignores active tasks", async () => {
    const testEnv = createTestEnvironment();
    const sessionAEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-a",
    };
    const sessionBEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-b",
    };
    const sessionCEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-c",
    };

    try {
      const completedA = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "resume-a-finished delay=40",
        ],
        { env: sessionAEnv }
      );
      await waitForTerminalResult(testEnv, completedA.jobId, sessionAEnv);

      const completedB = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "resume-b-finished delay=40",
        ],
        { env: sessionBEnv }
      );
      await waitForTerminalResult(testEnv, completedB.jobId, sessionBEnv);

      const activeA = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "resume-a-active delay=3000",
        ],
        { env: sessionAEnv }
      );

      const candidateA = runCompanionJson(
        ["task-resume-candidate", "--cwd", testEnv.workspaceDir, "--json"],
        { env: sessionAEnv }
      );
      assert.equal(candidateA.available, true);
      assert.equal(candidateA.sessionId, "session-a");
      assert.equal(candidateA.candidate.id, completedA.jobId);
      assert.notEqual(candidateA.candidate.id, activeA.jobId);

      const candidateB = runCompanionJson(
        ["task-resume-candidate", "--cwd", testEnv.workspaceDir, "--json"],
        { env: sessionBEnv }
      );
      assert.equal(candidateB.available, true);
      assert.equal(candidateB.sessionId, "session-b");
      assert.equal(candidateB.candidate.id, completedB.jobId);

      const candidateC = runCompanionJson(
        ["task-resume-candidate", "--cwd", testEnv.workspaceDir, "--json"],
        { env: sessionCEnv }
      );
      assert.equal(candidateC.available, false);
      assert.equal(candidateC.candidate, null);

      const noSessionContextCandidate = runCompanionJson(
        ["task-resume-candidate", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.equal(noSessionContextCandidate.available, false);
      assert.equal(noSessionContextCandidate.sessionId, null);
      assert.equal(noSessionContextCandidate.candidate, null);

      writeCurrentSessionMarker(testEnv, "session-a");
      const markerCandidateA = runCompanionJson(
        ["task-resume-candidate", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.equal(markerCandidateA.available, true);
      assert.equal(markerCandidateA.sessionId, "session-a");
      assert.equal(markerCandidateA.candidate.id, completedA.jobId);

      writeCurrentSessionMarker(testEnv, "session-c");
      const markerCandidateC = runCompanionJson(
        ["task-resume-candidate", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.equal(markerCandidateC.available, false);
      assert.equal(markerCandidateC.sessionId, "session-c");
      assert.equal(markerCandidateC.candidate, null);

      await waitForTerminalResult(testEnv, activeA.jobId, sessionAEnv);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("marks foreground task results as viewed and marks status/result retrievals as viewed", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-viewed",
    };

    try {
      runCompanion(
        ["task", "--cwd", testEnv.workspaceDir, "foreground-viewed delay=20"],
        { env: sessionEnv }
      );

      const foregroundJob = listStoredJobs(testEnv).find(
        (job) => job.sessionId === "session-viewed" && job.status === "completed"
      );
      assert.ok(foregroundJob, "expected one completed foreground job");
      assert.match(
        foregroundJob.resultViewedAt ?? "",
        /\d{4}-\d{2}-\d{2}T/,
        "foreground completion should mark the result as viewed"
      );

      const backgroundLaunch = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "background-viewed delay=40",
        ],
        { env: sessionEnv }
      );
      await (async () => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const storedJob = readStoredJobById(testEnv, backgroundLaunch.jobId);
          if (storedJob.status === "completed" || storedJob.status === "failed") {
            return;
          }
          await sleep(25);
        }
        assert.fail(`Timed out waiting for stored terminal job on ${backgroundLaunch.jobId}`);
      })();

      const beforeResult = readStoredJobById(testEnv, backgroundLaunch.jobId);
      assert.equal(
        beforeResult.resultViewedAt ?? null,
        null,
        "background completion should remain unread until result is fetched"
      );

      const statusPayload = runCompanionJson(
        ["status", "--cwd", testEnv.workspaceDir, backgroundLaunch.jobId, "--json"],
        { env: sessionEnv }
      );
      assert.equal(
        statusPayload.job.id,
        backgroundLaunch.jobId,
        "status --json should return the finished background job"
      );

      const afterStatus = readStoredJobById(testEnv, backgroundLaunch.jobId);
      assert.match(
        afterStatus.resultViewedAt ?? "",
        /\d{4}-\d{2}-\d{2}T/,
        "fetching finished job details through status --json should mark the job as viewed"
      );

      runCompanion(["result", "--cwd", testEnv.workspaceDir, backgroundLaunch.jobId], {
        env: sessionEnv,
      });

      const afterResult = readStoredJobById(testEnv, backgroundLaunch.jobId);
      assert.match(
        afterResult.resultViewedAt ?? "",
        /\d{4}-\d{2}-\d{2}T/,
        "fetching result should keep the job marked as viewed"
      );
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("does not expose managed log paths in JSON-facing commands", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-redacted-log",
    };

    try {
      const launch = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "redacted-log delay=40",
        ],
        { env: sessionEnv }
      );

      assert.equal("logFile" in launch, false, "background launch payload should not expose logFile");

      await waitForTerminalStatus(testEnv, launch.jobId, sessionEnv);

      const statusPayload = runCompanionJson(
        ["status", "--cwd", testEnv.workspaceDir, launch.jobId, "--json"],
        { env: sessionEnv }
      );
      assert.equal("logFile" in statusPayload.job, false, "status --json should not expose logFile");

      const resultPayload = runCompanionJson(
        ["result", "--cwd", testEnv.workspaceDir, launch.jobId, "--json"],
        { env: sessionEnv }
      );
      assert.equal("logFile" in resultPayload.job, false, "result --json should not expose logFile on job");
      assert.equal("logFile" in (resultPayload.storedJob ?? {}), false, "result --json should not expose logFile on stored job");
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("records PID identity for background worker jobs before they start running", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-background-pid-identity",
    };

    try {
      const launch = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "background-pid-identity delay=200",
        ],
        { env: sessionEnv }
      );

      const storedJob = readStoredJobById(testEnv, launch.jobId);
      assert.ok(storedJob, "expected queued background job to be persisted");
      assert.equal(storedJob.status, "queued");
      assert.equal(typeof storedJob.pid, "number");
      assert.equal(typeof storedJob.pidIdentity, "string");
      assert.ok(storedJob.pidIdentity.length > 0);

      await waitForTerminalResult(testEnv, launch.jobId, sessionEnv);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("suppresses stderr progress chatter when task runs with --quiet-progress", () => {
    const testEnv = createTestEnvironment();

    try {
      const result = runCompanion(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--quiet-progress",
          "quiet-progress delay=20",
        ],
        { env: testEnv.env }
      );

      assert.match(result.stdout, /completed:quiet-progress delay=20/);
      assert.equal(result.stderr.trim(), "");
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("treats task runs with unknown Claude completion state as failed", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-unknown-task",
    };

    try {
      const launch = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "unknown-no-terminal delay=20",
        ],
        { env: sessionEnv }
      );

      const statusPayload = await waitForTerminalStatus(
        testEnv,
        launch.jobId,
        sessionEnv
      );
      assert.equal(statusPayload.job.status, "failed");

      const storedJob = readStoredJobById(testEnv, launch.jobId);
      assert.equal(storedJob.status, "failed");
      assert.equal(storedJob.result.status, "unknown");
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("treats review runs with unknown Claude completion state as failed", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-unknown-review",
    };

    try {
      setupGitWorkspace(testEnv.workspaceDir);
      fs.writeFileSync(
        path.join(testEnv.workspaceDir, "notes.md"),
        "unknown-no-terminal\n",
        "utf8"
      );

      const launch = await runCompanionAsyncJson(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
        ],
        { env: sessionEnv }
      );

      const statusPayload = await waitForTerminalStatus(
        testEnv,
        launch.jobId,
        sessionEnv
      );
      assert.equal(statusPayload.job.status, "failed");

      const storedJob = readStoredJobById(testEnv, launch.jobId);
      assert.equal(storedJob.status, "failed");
      assert.equal(storedJob.result.codex.status, "unknown");
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("accepts terminal structured_output for adversarial reviews when result text is empty", () => {
    const testEnv = createTestEnvironment();

    try {
      setupGitWorkspace(testEnv.workspaceDir);
      fs.writeFileSync(
        path.join(testEnv.workspaceDir, "notes.md"),
        "structured output review\n",
        "utf8"
      );

      const result = runCompanion(
        [
          "adversarial-review",
          "--cwd",
          testEnv.workspaceDir,
        ],
        { env: testEnv.env }
      );

      assert.match(result.stdout, /Verdict|Findings|Next steps/);
      assert.doesNotMatch(result.stdout, /Could not parse structured JSON output/);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("respects explicit view-state override when companion itself still runs in the foreground", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-override",
    };

    try {
      runCompanion(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--view-state",
          "defer",
          "foreground-but-deferred delay=20",
        ],
        { env: sessionEnv }
      );

      const deferredForegroundJob = listStoredJobs(testEnv).find(
        (job) => job.sessionId === "session-override" && job.status === "completed"
      );
      assert.ok(deferredForegroundJob, "expected one completed foreground job with deferred view-state");
      assert.equal(
        deferredForegroundJob.resultViewedAt ?? null,
        null,
        "explicit defer should keep the result unread even when companion ran in foreground"
      );
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("can reserve a task job id and reuse it for a foreground task", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-reserved-foreground",
    };

    try {
      const reserved = runCompanionJson(
        ["task-reserve-job", "--cwd", testEnv.workspaceDir, "--json"],
        { env: sessionEnv }
      );
      assert.match(reserved.jobId ?? "", /^task-/);

      runCompanion(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--job-id",
          reserved.jobId,
          "reserved-foreground delay=20",
        ],
        { env: sessionEnv }
      );

      const storedJob = readStoredJobById(testEnv, reserved.jobId);
      assert.equal(storedJob.id, reserved.jobId);
      assert.equal(storedJob.status, "completed");
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("can reserve a task job id and reuse it for a background task", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-reserved-background",
    };

    try {
      const reserved = runCompanionJson(
        ["task-reserve-job", "--cwd", testEnv.workspaceDir, "--json"],
        { env: sessionEnv }
      );
      assert.match(reserved.jobId ?? "", /^task-/);

      const launch = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "--job-id",
          reserved.jobId,
          "reserved-background delay=40",
        ],
        { env: sessionEnv }
      );
      assert.equal(launch.jobId, reserved.jobId);

      const result = await waitForTerminalResult(testEnv, reserved.jobId, sessionEnv);
      assert.equal(result.job.id, reserved.jobId);
      assert.equal(result.job.status, "completed");
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("releases a reserved task job id even when the background task fails", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-reserved-task-failure",
    };

    try {
      const reserved = runCompanionJson(
        ["task-reserve-job", "--cwd", testEnv.workspaceDir, "--json"],
        { env: sessionEnv }
      );
      const reservePath = reservationPathFor(testEnv, reserved.jobId);
      assert.equal(fs.existsSync(reservePath), true);

      const launch = await runCompanionAsyncJson(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "--job-id",
          reserved.jobId,
          "unknown-no-terminal delay=20",
        ],
        { env: sessionEnv }
      );
      assert.equal(launch.jobId, reserved.jobId);

      const statusPayload = await waitForTerminalStatus(
        testEnv,
        reserved.jobId,
        sessionEnv
      );
      assert.equal(statusPayload.job.status, "failed");
      assert.equal(fs.existsSync(reservePath), false);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("rejects an explicit task job id that was never reserved", () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-unreserved-task",
    };

    try {
      const result = runCompanionExpectFailure(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--job-id",
          "task-manual-unreserved",
          "hello",
        ],
        { env: sessionEnv }
      );

      assert.match(
        result.stderr,
        /is not reserved\. Reserve one with the companion reserve-job helper/i
      );
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("releases a reserved task job id when resume validation fails before execution", () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-reserved-task-resume-miss",
    };

    try {
      const reserved = runCompanionJson(
        ["task-reserve-job", "--cwd", testEnv.workspaceDir, "--json"],
        { env: sessionEnv }
      );
      const reservePath = reservationPathFor(testEnv, reserved.jobId);
      assert.equal(fs.existsSync(reservePath), true);

      const result = runCompanionExpectFailure(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--resume",
          "--job-id",
          reserved.jobId,
        ],
        { env: sessionEnv }
      );

      assert.match(result.stderr, /No previous Claude Code task session was found/i);
      assert.equal(fs.existsSync(reservePath), false);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("can reserve a review job id and reuse it for a foreground review", async () => {
    const testEnv = createTestEnvironment();
    setupGitWorkspace(testEnv.workspaceDir);
    seedWorkingTreeDiff(testEnv.workspaceDir);

    try {
      const reserved = runCompanionJson(
        ["review-reserve-job", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.match(reserved.jobId ?? "", /^review-/);

      runCompanion(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--scope",
          "working-tree",
          "--job-id",
          reserved.jobId,
        ],
        { env: testEnv.env }
      );

      const storedJob = readStoredJobById(testEnv, reserved.jobId);
      assert.equal(storedJob.id, reserved.jobId);
      assert.equal(storedJob.status, "completed");
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("can reserve a review job id and reuse it for a background review", async () => {
    const testEnv = createTestEnvironment();
    setupGitWorkspace(testEnv.workspaceDir);
    seedWorkingTreeDiff(testEnv.workspaceDir);

    try {
      const reserved = runCompanionJson(
        ["review-reserve-job", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      assert.match(reserved.jobId ?? "", /^review-/);

      const launch = await runCompanionAsyncJson(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "--scope",
          "working-tree",
          "--job-id",
          reserved.jobId,
        ],
        { env: testEnv.env }
      );
      assert.equal(launch.jobId, reserved.jobId);

      const result = await waitForTerminalResult(testEnv, reserved.jobId, testEnv.env);
      assert.equal(result.job.id, reserved.jobId);
      assert.equal(result.job.status, "completed");
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("releases a reserved review job id even when the background review fails", async () => {
    const testEnv = createTestEnvironment();
    const sessionEnv = {
      ...testEnv.env,
      [SESSION_ID_ENV]: "session-reserved-review-failure",
    };

    try {
      setupGitWorkspace(testEnv.workspaceDir);
      fs.writeFileSync(
        path.join(testEnv.workspaceDir, "notes.md"),
        "unknown-no-terminal\n",
        "utf8"
      );

      const reserved = runCompanionJson(
        ["review-reserve-job", "--cwd", testEnv.workspaceDir, "--json"],
        { env: sessionEnv }
      );
      const reservePath = reservationPathFor(testEnv, reserved.jobId);
      assert.equal(fs.existsSync(reservePath), true);

      const launch = await runCompanionAsyncJson(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--background",
          "--json",
          "--job-id",
          reserved.jobId,
        ],
        { env: sessionEnv }
      );
      assert.equal(launch.jobId, reserved.jobId);

      const statusPayload = await waitForTerminalStatus(
        testEnv,
        reserved.jobId,
        sessionEnv
      );
      assert.equal(statusPayload.job.status, "failed");
      assert.equal(fs.existsSync(reservePath), false);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("rejects an explicit review job id that was never reserved", () => {
    const testEnv = createTestEnvironment();
    setupGitWorkspace(testEnv.workspaceDir);
    seedWorkingTreeDiff(testEnv.workspaceDir);

    try {
      const result = runCompanionExpectFailure(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--scope",
          "working-tree",
          "--job-id",
          "review-manual-unreserved",
        ],
        { env: testEnv.env }
      );

      assert.match(
        result.stderr,
        /is not reserved\. Reserve one with the companion reserve-job helper/i
      );
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("releases a reserved review job id when standard review validation fails before execution", () => {
    const testEnv = createTestEnvironment();
    setupGitWorkspace(testEnv.workspaceDir);
    seedWorkingTreeDiff(testEnv.workspaceDir);

    try {
      const reserved = runCompanionJson(
        ["review-reserve-job", "--cwd", testEnv.workspaceDir, "--json"],
        { env: testEnv.env }
      );
      const reservePath = reservationPathFor(testEnv, reserved.jobId);
      assert.equal(fs.existsSync(reservePath), true);

      const result = runCompanionExpectFailure(
        [
          "review",
          "--cwd",
          testEnv.workspaceDir,
          "--scope",
          "working-tree",
          "--job-id",
          reserved.jobId,
          "extra focus text",
        ],
        { env: testEnv.env }
      );

      assert.match(result.stderr, /Standard review does not support custom focus text/i);
      assert.equal(fs.existsSync(reservePath), false);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("rejects unsafe explicit task job ids before touching reservation files", () => {
    const testEnv = createTestEnvironment();

    try {
      const result = runCompanionExpectFailure(
        [
          "task",
          "--cwd",
          testEnv.workspaceDir,
          "--job-id",
          "../../escape",
          "hello",
        ],
        { env: testEnv.env }
      );

      assert.match(result.stderr, /Invalid job ID/i);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("completes concurrent background tasks independently and keeps both results addressable", async () => {
    const testEnv = createTestEnvironment();

    try {
      const [launchA, launchB] = await Promise.all([
        runCompanionAsyncJson(
          [
            "task",
            "--cwd",
            testEnv.workspaceDir,
            "--background",
            "--json",
            "concurrent-alpha delay=250",
          ],
          { env: testEnv.env }
        ),
        runCompanionAsyncJson(
          [
            "task",
            "--cwd",
            testEnv.workspaceDir,
            "--background",
            "--json",
            "concurrent-beta delay=260",
          ],
          { env: testEnv.env }
        ),
      ]);

      assert.notEqual(launchA.jobId, launchB.jobId);

      const [resultA, resultB] = await Promise.all([
        waitForTerminalResult(testEnv, launchA.jobId, testEnv.env),
        waitForTerminalResult(testEnv, launchB.jobId, testEnv.env),
      ]);

      assert.equal(resultA.job.status, "completed");
      assert.equal(resultB.job.status, "completed");
      assert.match(resultA.storedJob.result.rawOutput, /completed:concurrent-alpha delay=250/);
      assert.match(resultB.storedJob.result.rawOutput, /completed:concurrent-beta delay=260/);

      const statusPayload = runCompanionJson(
        ["status", "--cwd", testEnv.workspaceDir, "--json", "--all"],
        { env: testEnv.env }
      );
      const completedJobIds = collectCompletedJobIds(statusPayload);
      assert.ok(completedJobIds.includes(launchA.jobId));
      assert.ok(completedJobIds.includes(launchB.jobId));

      const renderedResult = runCompanion(
        ["result", "--cwd", testEnv.workspaceDir, launchA.jobId],
        { env: testEnv.env }
      ).stdout;
      assert.match(renderedResult, /completed:concurrent-alpha delay=250/);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("survives aggressive concurrent polling while many background tasks finish", async () => {
    const testEnv = createTestEnvironment();
    const prompts = [
      "race-alpha delay=420",
      "race-beta delay=470",
      "race-gamma delay=520",
      "race-delta delay=570",
      "race-epsilon delay=620",
    ];
    let waitSnapshotsPromise = Promise.resolve([]);

    try {
      const launches = await Promise.all(
        prompts.map((prompt) =>
          runCompanionAsyncJson(
            [
              "task",
              "--cwd",
              testEnv.workspaceDir,
              "--background",
              "--json",
              prompt,
            ],
            { env: testEnv.env }
          ).then((payload) => ({ ...payload, prompt }))
        )
      );

      waitSnapshotsPromise = Promise.all(
        launches.slice(0, 2).map((launch) =>
          runCompanionAsyncJson(
            [
              "status",
              "--cwd",
              testEnv.workspaceDir,
              "--json",
              "--wait",
              "--timeout-ms",
              "20000",
              "--poll-interval-ms",
              "25",
              launch.jobId,
            ],
            { env: testEnv.env, timeoutMs: 25_000 }
          )
        )
      );

      const terminalPayloads = new Map();
      const deadline = Date.now() + 10_000;

      while (terminalPayloads.size < launches.length && Date.now() < deadline) {
        const overview = runCompanionJson(
          ["status", "--cwd", testEnv.workspaceDir, "--json", "--all"],
          { env: testEnv.env }
        );
        const snapshotIds = collectSnapshotJobIds(overview);
        assert.equal(snapshotIds.length, new Set(snapshotIds).size);

        for (const launch of launches) {
          const payload = runCompanionJson(
            ["result", "--cwd", testEnv.workspaceDir, "--json", launch.jobId],
            { env: testEnv.env }
          );

          if (payload.state === "active") {
            assert.ok(
              payload.job.status === "queued" || payload.job.status === "running",
              `Expected active job ${launch.jobId} to be queued/running, got ${payload.job.status}`
            );
            continue;
          }

          assertCompletedTaskPayload(payload, launch.prompt);
          terminalPayloads.set(launch.jobId, payload);
        }

        if (terminalPayloads.size < launches.length) {
          await sleep(15);
        }
      }

      const unresolvedLaunches = launches.filter(
        (launch) => !terminalPayloads.has(launch.jobId)
      );
      for (const launch of unresolvedLaunches) {
        const payload = await waitForTerminalResult(
          testEnv,
          launch.jobId,
          testEnv.env,
          { timeoutMs: 20_000 }
        );
        assertCompletedTaskPayload(payload, launch.prompt);
        terminalPayloads.set(launch.jobId, payload);
      }

      const waitSnapshots = await waitSnapshotsPromise;
      for (const snapshot of waitSnapshots) {
        assert.equal(snapshot.job.status, "completed");
        assert.ok(snapshot.job.duration);
      }

      const finalOverview = runCompanionJson(
        ["status", "--cwd", testEnv.workspaceDir, "--json", "--all"],
        { env: testEnv.env }
      );
      const completedJobIds = collectCompletedJobIds(finalOverview);
      for (const launch of launches) {
        assert.ok(completedJobIds.includes(launch.jobId));
      }
    } finally {
      await Promise.allSettled([waitSnapshotsPromise]);
      cleanupTestEnvironment(testEnv);
    }
  });

  it("cancels one background task cleanly while sibling tasks continue to completion", async () => {
    const testEnv = createTestEnvironment();
    const prompts = [
      "cancel-me delay=2500",
      "finish-fast delay=650",
      "finish-mid delay=1100",
    ];

    try {
      const launches = await Promise.all(
        prompts.map((prompt) =>
          runCompanionAsyncJson(
            [
              "task",
              "--cwd",
              testEnv.workspaceDir,
              "--background",
              "--json",
              prompt,
            ],
            { env: testEnv.env }
          ).then((payload) => ({ ...payload, prompt }))
        )
      );

      await Promise.all(
        launches.map((launch) =>
          waitForJobState(
            testEnv,
            launch.jobId,
            testEnv.env,
            (payload) =>
              payload.state === "active" &&
              (payload.job.status === "queued" || payload.job.status === "running"),
            "active task snapshot"
          )
        )
      );

      const cancelTarget = launches[0];
      const waitCancelledPromise = runCompanionAsyncJson(
        [
          "status",
          "--cwd",
          testEnv.workspaceDir,
          "--json",
          "--wait",
          "--timeout-ms",
          "20000",
          "--poll-interval-ms",
          "25",
          cancelTarget.jobId,
        ],
        { env: testEnv.env, timeoutMs: 25_000 }
      );

      const cancelPayload = runCompanionJson(
        ["cancel", "--cwd", testEnv.workspaceDir, "--json", cancelTarget.jobId],
        { env: testEnv.env }
      );
      assert.equal(cancelPayload.status, "cancelled");

      const [cancelledSnapshot, cancelledResult, siblingAResult, siblingBResult] = await Promise.all([
        waitCancelledPromise,
        waitForTerminalResult(testEnv, cancelTarget.jobId, testEnv.env),
        waitForTerminalResult(testEnv, launches[1].jobId, testEnv.env),
        waitForTerminalResult(testEnv, launches[2].jobId, testEnv.env),
      ]);

      assert.equal(cancelledSnapshot.job.status, "cancelled");
      assert.equal(cancelledResult.job.status, "cancelled");
      assert.match(cancelledResult.storedJob.errorMessage, /Cancelled by user/);
      assertCompletedTaskPayload(siblingAResult, launches[1].prompt);
      assertCompletedTaskPayload(siblingBResult, launches[2].prompt);

      const finalOverview = runCompanionJson(
        ["status", "--cwd", testEnv.workspaceDir, "--json", "--all"],
        { env: testEnv.env }
      );
      const snapshotIds = collectSnapshotJobIds(finalOverview);
      for (const launch of launches) {
        assert.ok(snapshotIds.includes(launch.jobId));
      }
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });

  it("runs multiple background reviews against a live working tree without mixing job state", async () => {
    const testEnv = createTestEnvironment();
    setupGitWorkspace(testEnv.workspaceDir);
    seedWorkingTreeDiff(testEnv.workspaceDir);

    try {
      const launches = await Promise.all(
        [1, 2, 3].map(() =>
          runCompanionAsyncJson(
            [
              "review",
              "--cwd",
              testEnv.workspaceDir,
              "--scope",
              "working-tree",
              "--background",
              "--json",
            ],
            { env: testEnv.env }
          )
        )
      );

      const waitSnapshotPromise = runCompanionAsyncJson(
        [
          "status",
          "--cwd",
          testEnv.workspaceDir,
          "--json",
          "--wait",
          "--timeout-ms",
          "20000",
          "--poll-interval-ms",
          "25",
          launches[0].jobId,
        ],
        { env: testEnv.env, timeoutMs: 25_000 }
      );

      const terminalPayloads = await Promise.all(
        launches.map((launch) =>
          waitForTerminalResult(testEnv, launch.jobId, testEnv.env)
        )
      );

      const waitedSnapshot = await waitSnapshotPromise;
      assert.equal(waitedSnapshot.job.status, "completed");

      for (const payload of terminalPayloads) {
        assertCompletedReviewPayload(payload);
      }

      const finalOverview = runCompanionJson(
        ["status", "--cwd", testEnv.workspaceDir, "--json", "--all"],
        { env: testEnv.env }
      );
      const completedJobIds = collectCompletedJobIds(finalOverview);
      for (const launch of launches) {
        assert.ok(completedJobIds.includes(launch.jobId));
      }

      const rendered = runCompanion(
        ["result", "--cwd", testEnv.workspaceDir, launches[0].jobId],
        { env: testEnv.env }
      ).stdout;
      assert.match(rendered, /# Claude Code Review/);
      assert.match(rendered, /Target: working tree diff/);
    } finally {
      cleanupTestEnvironment(testEnv);
    }
  });
});
