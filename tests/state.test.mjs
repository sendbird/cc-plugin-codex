/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// State paths are workspace-hash based and resolveWorkspaceRoot() shells out to
// git, so most tests use a real git repo cwd. A dedicated subprocess test below
// covers the HOME/CODEX_HOME-specific migration path.

import {
  MAX_STOP_REVIEW_HISTORY_ENTRIES,
  resolveWorkspaceHash,
  resolveStateDir,
  resolveJobsDir,
  ensureStateDir,
  loadConfig,
  saveConfig,
  setConfig,
  getConfig,
  generateJobId,
  writeJobFile,
  readJobFile,
  listJobs,
  upsertJob,
  patchJob,
  transitionJob,
  casJobStatus,
  setCurrentSession,
  getCurrentSession,
  clearCurrentSession,
  cleanupOldJobs,
  reapStaleJobs,
  appendStopReviewHistory,
  resolveJobLogFile,
  nowIso,
} from "../scripts/lib/state.mjs";

// We'll use the project root as a known git-repo cwd for workspace resolution.
const PROJECT_CWD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_MODULE_URL = new URL("../scripts/lib/state.mjs", import.meta.url).href;

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-test-"));
  const result = spawnSync("git", ["init", "-q"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git init failed: ${result.stderr || result.stdout}`);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// resolveWorkspaceHash
// ---------------------------------------------------------------------------

describe("resolveWorkspaceHash", () => {
  it("returns a 12-character hex string", () => {
    const hash = resolveWorkspaceHash(PROJECT_CWD);
    assert.match(hash, /^[0-9a-f]{12}$/);
  });

  it("is deterministic for the same path", () => {
    const h1 = resolveWorkspaceHash(PROJECT_CWD);
    const h2 = resolveWorkspaceHash(PROJECT_CWD);
    assert.equal(h1, h2);
  });
});

// ---------------------------------------------------------------------------
// generateJobId
// ---------------------------------------------------------------------------

describe("generateJobId", () => {
  it("starts with the given prefix", () => {
    const id = generateJobId("review");
    assert.ok(id.startsWith("review-"), `Expected prefix 'review-', got '${id}'`);
  });

  it("defaults to 'job' prefix", () => {
    const id = generateJobId();
    assert.ok(id.startsWith("job-"));
  });

  it("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateJobId()));
    assert.equal(ids.size, 20);
  });

  it("matches the expected format (prefix-base36ts-base36rand)", () => {
    const id = generateJobId("task");
    // prefix-<base36>-<base36>
    assert.match(id, /^task-[a-z0-9]+-[a-z0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// nowIso
// ---------------------------------------------------------------------------

describe("nowIso", () => {
  it("returns a valid ISO 8601 timestamp", () => {
    const ts = nowIso();
    const parsed = new Date(ts);
    assert.ok(!isNaN(parsed.getTime()));
    assert.ok(ts.endsWith("Z"));
  });
});

// ---------------------------------------------------------------------------
// Config round-trip (uses real state dir for current project)
// ---------------------------------------------------------------------------

describe("loadConfig / saveConfig", () => {
  // We use the real project cwd. saveConfig creates dirs under STATE_ROOT.
  // We clean up after.

  let stateDir;

  before(() => {
    stateDir = resolveStateDir(PROJECT_CWD);
  });

  afterEach(() => {
    // Remove config file if it was created by the test
    const configFile = path.join(stateDir, "config.json");
    try { fs.unlinkSync(configFile); } catch {}
  });

  it("loadConfig returns defaults when no file exists", () => {
    // Make sure no config file
    const configFile = path.join(stateDir, "config.json");
    try { fs.unlinkSync(configFile); } catch {}

    const cfg = loadConfig(PROJECT_CWD);
    assert.equal(cfg.version, 1);
    assert.equal(cfg.stopReviewGate, false);
  });

  it("saveConfig round-trips with loadConfig", () => {
    saveConfig(PROJECT_CWD, { stopReviewGate: true, customKey: "hello" });
    const cfg = loadConfig(PROJECT_CWD);
    assert.equal(cfg.version, 1);
    assert.equal(cfg.stopReviewGate, true);
    assert.equal(cfg.customKey, "hello");
  });

  it("setConfig updates a single key", () => {
    saveConfig(PROJECT_CWD, { stopReviewGate: false });
    setConfig(PROJECT_CWD, "stopReviewGate", true);
    const cfg = getConfig(PROJECT_CWD);
    assert.equal(cfg.stopReviewGate, true);
  });

  it("migrates legacy claude-code plugin state into the cc plugin namespace and prunes old armed markers", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-state-migrate-"));
    const codexHome = path.join(homeDir, ".codex");
    const repoDir = createTempGitRepo();

    try {
      const realWorkspace = fs.realpathSync.native(repoDir);
      const workspaceHash = createHash("sha256")
        .update(realWorkspace)
        .digest("hex")
        .slice(0, 12);
      const legacyStateDir = path.join(
        codexHome,
        "plugins",
        "data",
        "claude-code",
        "state",
        workspaceHash
      );
      const nextStateDir = path.join(
        codexHome,
        "plugins",
        "data",
        "cc",
        "state",
        workspaceHash
      );

      fs.mkdirSync(legacyStateDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyStateDir, "config.json"),
        JSON.stringify({ version: 1, stopReviewGate: true }, null, 2) + "\n",
        "utf8"
      );
      fs.writeFileSync(path.join(legacyStateDir, "armed-old-session"), "", "utf8");

      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            const mod = await import(${JSON.stringify(STATE_MODULE_URL)});
            const cwd = ${JSON.stringify(repoDir)};
            console.log(JSON.stringify({
              stateDir: mod.resolveStateDir(cwd),
              config: mod.getConfig(cwd)
            }));
          `,
        ],
        {
          env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
            CODEX_HOME: codexHome,
          },
          encoding: "utf8",
        }
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.stateDir, nextStateDir);
      assert.equal(payload.config.stopReviewGate, true);
      assert.equal(fs.existsSync(path.join(nextStateDir, "config.json")), true);
      assert.equal(fs.existsSync(path.join(legacyStateDir, "config.json")), false);
      assert.equal(fs.existsSync(path.join(nextStateDir, "armed-old-session")), false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stop review history retention
// ---------------------------------------------------------------------------

describe("appendStopReviewHistory", () => {
  it("retains only the newest configured number of history entries", () => {
    const repoDir = createTempGitRepo();
    const historyFile = path.join(resolveStateDir(repoDir), "stop-review-history.jsonl");

    try {
      for (let i = 0; i < MAX_STOP_REVIEW_HISTORY_ENTRIES + 25; i++) {
        appendStopReviewHistory(repoDir, {
          seq: i,
          verdict: i % 2 === 0 ? "allow" : "block",
        });
      }

      const lines = fs
        .readFileSync(historyFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      assert.equal(lines.length, MAX_STOP_REVIEW_HISTORY_ENTRIES);
      assert.equal(lines[0].seq, 25);
      assert.equal(lines.at(-1).seq, MAX_STOP_REVIEW_HISTORY_ENTRIES + 24);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Job CRUD
// ---------------------------------------------------------------------------

describe("writeJobFile / readJobFile / listJobs", () => {
  const jobId = "test-crud-job";

  afterEach(() => {
    // Clean up
    try {
      const jobFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json`);
      fs.unlinkSync(jobFile);
    } catch {}
  });

  it("writeJobFile creates a file and readJobFile reads it back", () => {
    const payload = { id: jobId, status: "running", title: "test" };
    writeJobFile(PROJECT_CWD, jobId, payload);
    const read = readJobFile(PROJECT_CWD, jobId);
    assert.equal(read.id, jobId);
    assert.equal(read.status, "running");
    assert.equal(read.title, "test");
    assert.ok(read.updatedAt); // writeJobFile adds updatedAt
  });

  it("readJobFile returns null for non-existent job", () => {
    assert.equal(readJobFile(PROJECT_CWD, "nonexistent-job-xyz"), null);
  });

  it("listJobs returns array containing written job", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "completed", createdAt: nowIso() });
    const jobs = listJobs(PROJECT_CWD);
    assert.ok(Array.isArray(jobs));
    const found = jobs.find((j) => j.id === jobId);
    assert.ok(found, "Expected to find the written job in listJobs");
  });

  it("listJobs returns recent entries without error", () => {
    // Write 5 jobs, verify they all appear (we won't actually write 51)
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = `test-list-${i}`;
      ids.push(id);
      writeJobFile(PROJECT_CWD, id, { id, status: "completed", createdAt: new Date(Date.now() - i * 1000).toISOString() });
    }
    try {
      const jobs = listJobs(PROJECT_CWD);
      // Should include all 5
      for (const id of ids) {
        assert.ok(jobs.some((j) => j.id === id), `Expected ${id} in listJobs`);
      }
    } finally {
      for (const id of ids) {
        try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`)); } catch {}
      }
    }
  });

  it("listJobs sorts newest first", () => {
    const ids = ["test-sort-a", "test-sort-b"];
    writeJobFile(PROJECT_CWD, ids[0], { id: ids[0], status: "completed", createdAt: "2020-01-01T00:00:00Z" });
    writeJobFile(PROJECT_CWD, ids[1], { id: ids[1], status: "completed", createdAt: "2025-01-01T00:00:00Z" });
    try {
      const jobs = listJobs(PROJECT_CWD);
      const idxA = jobs.findIndex((j) => j.id === ids[0]);
      const idxB = jobs.findIndex((j) => j.id === ids[1]);
      assert.ok(idxB < idxA, "Newer job should come first");
    } finally {
      for (const id of ids) {
        try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`)); } catch {}
      }
    }
  });
});

// ---------------------------------------------------------------------------
// upsertJob
// ---------------------------------------------------------------------------

describe("upsertJob", () => {
  const jobId = "test-upsert-job";

  afterEach(() => {
    try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json`)); } catch {}
  });

  it("inserts a new job when it does not exist", () => {
    const job = upsertJob(PROJECT_CWD, { id: jobId, status: "running", title: "new" });
    assert.equal(job.id, jobId);
    assert.equal(job.status, "running");
    assert.ok(job.createdAt);
    assert.ok(job.updatedAt);
  });

  it("updates an existing job preserving original fields", () => {
    upsertJob(PROJECT_CWD, { id: jobId, status: "running", title: "orig", extra: "keep" });
    const updated = upsertJob(PROJECT_CWD, { id: jobId, status: "completed" });
    assert.equal(updated.status, "completed");
    assert.equal(updated.title, "orig");
    assert.equal(updated.extra, "keep");
  });
});

// ---------------------------------------------------------------------------
// patchJob
// ---------------------------------------------------------------------------

describe("patchJob", () => {
  const jobId = "test-patch-job";

  afterEach(() => {
    try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json`)); } catch {}
  });

  it("updates an existing job without changing unrelated fields", () => {
    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "running",
      title: "orig",
      extra: "keep",
      createdAt: nowIso(),
    });
    const updated = patchJob(PROJECT_CWD, jobId, { status: "completed" });
    assert.equal(updated.status, "completed");
    assert.equal(updated.title, "orig");
    assert.equal(updated.extra, "keep");
  });

  it("returns null when the job does not exist", () => {
    assert.equal(patchJob(PROJECT_CWD, jobId, { status: "completed" }), null);
  });
});

// ---------------------------------------------------------------------------
// transitionJob
// ---------------------------------------------------------------------------

describe("transitionJob", () => {
  const jobId = "test-transition-job";

  afterEach(() => {
    try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json`)); } catch {}
  });

  it("transitions when the current status matches one of the expected statuses", () => {
    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "queued",
      createdAt: nowIso(),
    });
    const result = transitionJob(
      PROJECT_CWD,
      jobId,
      ["running", "queued"],
      "cancelling",
      { phase: "cancelling" }
    );
    assert.equal(result.transitioned, true);
    assert.equal(result.previousStatus, "queued");
    assert.equal(result.job.status, "cancelling");
    assert.equal(result.job.phase, "cancelling");
  });

  it("returns the current job without transitioning when the status does not match", () => {
    writeJobFile(PROJECT_CWD, jobId, {
      id: jobId,
      status: "completed",
      createdAt: nowIso(),
    });
    const result = transitionJob(
      PROJECT_CWD,
      jobId,
      ["running", "queued"],
      "cancelling"
    );
    assert.equal(result.transitioned, false);
    assert.equal(result.previousStatus, "completed");
    assert.equal(result.job.status, "completed");
  });
});

// ---------------------------------------------------------------------------
// casJobStatus
// ---------------------------------------------------------------------------

describe("casJobStatus", () => {
  const jobId = "test-cas-job";

  afterEach(() => {
    try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json`)); } catch {}
    try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`)); } catch {}
  });

  it("succeeds when current status matches expected", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    const ok = casJobStatus(PROJECT_CWD, jobId, "running", "completed", { summary: "done" });
    assert.equal(ok, true);
    const job = readJobFile(PROJECT_CWD, jobId);
    assert.equal(job.status, "completed");
    assert.equal(job.summary, "done");
  });

  it("fails when current status does not match expected", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "completed" });
    const ok = casJobStatus(PROJECT_CWD, jobId, "running", "cancelled");
    assert.equal(ok, false);
    const job = readJobFile(PROJECT_CWD, jobId);
    assert.equal(job.status, "completed"); // unchanged
  });

  it("cleans up lock file after operation", () => {
    writeJobFile(PROJECT_CWD, jobId, { id: jobId, status: "running" });
    casJobStatus(PROJECT_CWD, jobId, "running", "completed");
    const lockFile = path.join(resolveJobsDir(PROJECT_CWD), `${jobId}.json.lock`);
    assert.ok(!fs.existsSync(lockFile), "Lock file should be removed after CAS");
  });
});

// ---------------------------------------------------------------------------
// current session marker
// ---------------------------------------------------------------------------

describe("current session marker", () => {
  const sessionId = "test-current-session";
  let repoDir;

  beforeEach(() => {
    repoDir = createTempGitRepo();
  });

  afterEach(() => {
    clearCurrentSession(repoDir);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("stores and reads the current session id", () => {
    setCurrentSession(repoDir, sessionId);
    assert.equal(getCurrentSession(repoDir), sessionId);
  });

  it("clears the current session id", () => {
    setCurrentSession(repoDir, sessionId);
    clearCurrentSession(repoDir, sessionId);
    assert.equal(getCurrentSession(repoDir), null);
  });

  it("does not clear a newer session marker when ids differ", () => {
    setCurrentSession(repoDir, "newer-session");
    clearCurrentSession(repoDir, sessionId);
    assert.equal(getCurrentSession(repoDir), "newer-session");
  });
});

// ---------------------------------------------------------------------------
// sanitizeId (tested indirectly via job functions)
// ---------------------------------------------------------------------------

describe("sanitizeId (via writeJobFile / readJobFile)", () => {
  it("accepts valid alphanumeric-dash-dot-underscore IDs", () => {
    const validIds = ["abc-123", "job_01", "review.v2", "a-b_c.d"];
    for (const id of validIds) {
      assert.doesNotThrow(() => {
        writeJobFile(PROJECT_CWD, id, { id, status: "test" });
      }, `Expected '${id}' to be accepted`);
      // Clean up
      try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`)); } catch {}
    }
  });

  it("rejects path traversal attempts", () => {
    assert.throws(() => writeJobFile(PROJECT_CWD, "../etc", {}), /Invalid/);
    assert.throws(() => readJobFile(PROJECT_CWD, "../../passwd"), /Invalid/);
    assert.throws(() => writeJobFile(PROJECT_CWD, "/tmp/evil", {}), /Invalid/);
  });

  it("rejects IDs with spaces or special characters", () => {
    assert.throws(() => writeJobFile(PROJECT_CWD, "has space", {}), /Invalid/);
    assert.throws(() => writeJobFile(PROJECT_CWD, "semi;colon", {}), /Invalid/);
  });
});

// ---------------------------------------------------------------------------
// cleanupOldJobs
// ---------------------------------------------------------------------------

describe("cleanupOldJobs", () => {
  it("runs without error on an empty jobs directory", () => {
    assert.doesNotThrow(() => cleanupOldJobs(PROJECT_CWD));
  });

  it("does not remove non-terminal jobs", () => {
    const id = "test-cleanup-running";
    writeJobFile(PROJECT_CWD, id, { id, status: "running", createdAt: "2020-01-01T00:00:00Z" });
    try {
      cleanupOldJobs(PROJECT_CWD);
      const job = readJobFile(PROJECT_CWD, id);
      assert.ok(job, "Running job should not be cleaned up");
    } finally {
      try { fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`)); } catch {}
    }
  });

  it("keeps the newest 100 terminal jobs per session", () => {
    const repoDir = createTempGitRepo();
    try {
      for (let i = 0; i < 105; i++) {
        const sessionAId = `test-retain-session-a-${i}`;
        writeJobFile(repoDir, sessionAId, {
          id: sessionAId,
          status: "completed",
          sessionId: "session-a",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        });

        const sessionBId = `test-retain-session-b-${i}`;
        writeJobFile(repoDir, sessionBId, {
          id: sessionBId,
          status: "completed",
          sessionId: "session-b",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        });
      }

      cleanupOldJobs(repoDir);

      const jobs = listJobs(repoDir);
      const terminalJobs = jobs.filter((job) => job.status === "completed");
      const sessionAJobs = terminalJobs.filter((job) => job.sessionId === "session-a");
      const sessionBJobs = terminalJobs.filter((job) => job.sessionId === "session-b");

      assert.equal(terminalJobs.length, 200);
      assert.equal(sessionAJobs.length, 100);
      assert.equal(sessionBJobs.length, 100);
      assert.ok(sessionAJobs.some((job) => job.id === "test-retain-session-a-0"));
      assert.ok(sessionAJobs.some((job) => job.id === "test-retain-session-a-99"));
      assert.ok(!sessionAJobs.some((job) => job.id === "test-retain-session-a-100"));
      assert.ok(!sessionAJobs.some((job) => job.id === "test-retain-session-a-104"));
      assert.ok(sessionBJobs.some((job) => job.id === "test-retain-session-b-0"));
      assert.ok(sessionBJobs.some((job) => job.id === "test-retain-session-b-99"));
      assert.ok(!sessionBJobs.some((job) => job.id === "test-retain-session-b-100"));
      assert.ok(!sessionBJobs.some((job) => job.id === "test-retain-session-b-104"));
    } finally {
      fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("preserves active jobs while pruning old terminal job files and logs per session", () => {
    const repoDir = createTempGitRepo();
    try {
      const runningId = "test-retain-running";
      writeJobFile(repoDir, runningId, {
        id: runningId,
        status: "running",
        sessionId: "session-a",
        createdAt: new Date(Date.now() - 200_000).toISOString(),
      });

      const prunedId = "test-retain-pruned";
      writeJobFile(repoDir, prunedId, {
        id: prunedId,
        status: "completed",
        sessionId: "session-a",
        createdAt: new Date(Date.now() - 300_000).toISOString(),
        logFile: resolveJobLogFile(repoDir, prunedId),
      });
      fs.writeFileSync(resolveJobLogFile(repoDir, prunedId), "old log\n", "utf8");

      for (let i = 0; i < 100; i++) {
        const sessionAId = `test-retain-session-a-keep-${i}`;
        writeJobFile(repoDir, sessionAId, {
          id: sessionAId,
          status: "completed",
          sessionId: "session-a",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        });

        const sessionBId = `test-retain-session-b-keep-${i}`;
        writeJobFile(repoDir, sessionBId, {
          id: sessionBId,
          status: "completed",
          sessionId: "session-b",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        });
      }

      cleanupOldJobs(repoDir);

      const terminalJobs = listJobs(repoDir).filter((job) => job.status === "completed");
      const sessionAJobs = terminalJobs.filter((job) => job.sessionId === "session-a");
      const sessionBJobs = terminalJobs.filter((job) => job.sessionId === "session-b");

      assert.ok(readJobFile(repoDir, runningId), "running job should be preserved");
      assert.equal(readJobFile(repoDir, prunedId), null);
      assert.equal(fs.existsSync(resolveJobLogFile(repoDir, prunedId)), false);
      assert.equal(sessionAJobs.length, 100);
      assert.equal(sessionBJobs.length, 100);
      assert.ok(sessionBJobs.some((job) => job.id === "test-retain-session-b-keep-99"));
    } finally {
      fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not unlink an arbitrary tampered logFile path while pruning old jobs", () => {
    const repoDir = createTempGitRepo();
    const outsideFile = path.join(os.tmpdir(), `claude-state-outside-${Date.now()}.log`);
    try {
      fs.writeFileSync(outsideFile, "keep me\n", "utf8");

      const prunedId = "test-retain-tampered-log";
      writeJobFile(repoDir, prunedId, {
        id: prunedId,
        status: "completed",
        sessionId: "session-a",
        createdAt: new Date(Date.now() - 300_000).toISOString(),
        logFile: outsideFile,
      });

      for (let i = 0; i < 100; i++) {
        const keepId = `test-retain-session-a-safe-${i}`;
        writeJobFile(repoDir, keepId, {
          id: keepId,
          status: "completed",
          sessionId: "session-a",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        });
      }

      cleanupOldJobs(repoDir);

      assert.equal(readJobFile(repoDir, prunedId), null);
      assert.equal(fs.existsSync(outsideFile), true);
    } finally {
      try {
        fs.unlinkSync(outsideFile);
      } catch {}
      fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("removes stale reserved job marker files", () => {
    const repoDir = createTempGitRepo();
    try {
      const jobsDir = resolveJobsDir(repoDir);
      fs.mkdirSync(jobsDir, { recursive: true });
      const staleReservation = path.join(jobsDir, "review-stale.reserve");
      const freshReservation = path.join(jobsDir, "review-fresh.reserve");
      fs.writeFileSync(staleReservation, "{}", "utf8");
      fs.writeFileSync(freshReservation, "{}", "utf8");

      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      fs.utimesSync(staleReservation, twoHoursAgo / 1000, twoHoursAgo / 1000);

      cleanupOldJobs(repoDir);

      assert.equal(fs.existsSync(staleReservation), false);
      assert.equal(fs.existsSync(freshReservation), true);
    } finally {
      fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("continues cleaning later reserved markers when one entry errors", () => {
    const repoDir = createTempGitRepo();
    const originalStatSync = fs.statSync;
    try {
      const jobsDir = resolveJobsDir(repoDir);
      fs.mkdirSync(jobsDir, { recursive: true });
      const badReservation = path.join(jobsDir, "review-bad.reserve");
      const staleReservation = path.join(jobsDir, "review-stale.reserve");
      fs.writeFileSync(badReservation, "{}", "utf8");
      fs.writeFileSync(staleReservation, "{}", "utf8");

      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      fs.utimesSync(badReservation, twoHoursAgo / 1000, twoHoursAgo / 1000);
      fs.utimesSync(staleReservation, twoHoursAgo / 1000, twoHoursAgo / 1000);

      fs.statSync = (targetPath, ...args) => {
        if (targetPath === badReservation) {
          const error = new Error("synthetic stat failure");
          error.code = "EIO";
          throw error;
        }
        return originalStatSync(targetPath, ...args);
      };

      cleanupOldJobs(repoDir);

      assert.equal(fs.existsSync(badReservation), true);
      assert.equal(fs.existsSync(staleReservation), false);
    } finally {
      fs.statSync = originalStatSync;
      fs.rmSync(resolveStateDir(repoDir), { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// reapStaleJobs
// ---------------------------------------------------------------------------

describe("reapStaleJobs", () => {
  const staleTimestamp = () => new Date(Date.now() - 5_000).toISOString();
  const backdateJob = (id, timestamp) => {
    const jobFile = path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`);
    const current = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    fs.writeFileSync(
      jobFile,
      JSON.stringify(
        {
          ...current,
          createdAt: timestamp,
          startedAt: timestamp,
          updatedAt: timestamp,
        },
        null,
        2
      ),
      "utf8"
    );
  };

  afterEach(() => {
    // Clean up test job files
    const jobsDir = resolveJobsDir(PROJECT_CWD);
    for (const f of fs.readdirSync(jobsDir)) {
      if (f.startsWith("test-reap-")) {
        try { fs.unlinkSync(path.join(jobsDir, f)); } catch {}
      }
    }
  });

  it("transitions running job with dead PID to failed", () => {
    const id = "test-reap-dead";
    const deadPid = 99999999; // Almost certainly not running
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: deadPid,
      pidIdentity: "bogus-identity",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const jobs = [readJobFile(PROJECT_CWD, id)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result.length, 1);
    assert.equal(result[0].status, "failed");
    assert.ok(result[0].errorMessage.includes("Auto-reaped"));
    assert.equal(result[0].pid, null);
    assert.equal(result[0].pidIdentity, null);
    assert.ok(result[0].completedAt);
  });

  it("does not touch running job with alive PID", () => {
    const id = "test-reap-alive";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: process.pid, // This process is alive
      createdAt: nowIso(),
    });

    const jobs = [readJobFile(PROJECT_CWD, id)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result.length, 1);
    assert.equal(result[0].status, "running");
  });

  it("keeps recently updated running job alive during the reap grace window", () => {
    const id = "test-reap-recent";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: 99999999,
      pidIdentity: "bogus-identity",
      createdAt: nowIso(),
      startedAt: nowIso(),
    });

    const jobs = [readJobFile(PROJECT_CWD, id)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result.length, 1);
    assert.equal(result[0].status, "running");
  });

  it("does not touch running job with no PID (pre-spawn)", () => {
    const id = "test-reap-nopid";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: null,
      createdAt: nowIso(),
    });

    const jobs = [readJobFile(PROJECT_CWD, id)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result.length, 1);
    assert.equal(result[0].status, "running");
  });

  it("does not touch completed/failed jobs", () => {
    const id1 = "test-reap-completed";
    const id2 = "test-reap-failed";
    writeJobFile(PROJECT_CWD, id1, {
      id: id1,
      status: "completed",
      pid: 99999999,
      createdAt: nowIso(),
    });
    writeJobFile(PROJECT_CWD, id2, {
      id: id2,
      status: "failed",
      pid: 99999999,
      createdAt: nowIso(),
    });

    const jobs = [readJobFile(PROJECT_CWD, id1), readJobFile(PROJECT_CWD, id2)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result[0].status, "completed");
    assert.equal(result[1].status, "failed");
  });

  it("reaps cancelling job with dead PID", () => {
    const id = "test-reap-cancelling";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "cancelling",
      pid: 99999999,
      pidIdentity: "bogus",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const jobs = [readJobFile(PROJECT_CWD, id)];
    const result = reapStaleJobs(PROJECT_CWD, jobs);

    assert.equal(result[0].status, "failed");
  });

  it("listJobs integrates the reaper automatically", () => {
    const id = "test-reap-integration";
    writeJobFile(PROJECT_CWD, id, {
      id,
      status: "running",
      pid: 99999999,
      pidIdentity: "bogus",
      createdAt: nowIso(),
    });
    backdateJob(id, staleTimestamp());

    const jobs = listJobs(PROJECT_CWD);
    const found = jobs.find((j) => j.id === id);
    assert.ok(found);
    assert.equal(found.status, "failed");
    assert.ok(found.errorMessage.includes("Auto-reaped"));
  });
});
