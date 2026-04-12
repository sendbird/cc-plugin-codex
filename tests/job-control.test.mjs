/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  sortJobsNewestFirst,
  enrichJob,
  readJobProgressPreview,
  buildStatusSnapshot,
  resolveResultJob,
  DEFAULT_MAX_STATUS_JOBS,
  DEFAULT_MAX_PROGRESS_LINES,
} from "../scripts/lib/job-control.mjs";
import {
  clearCurrentSession,
  setCurrentSession,
  writeJobFile,
  resolveJobsDir,
  resolveJobLogFile,
} from "../scripts/lib/state.mjs";

const PROJECT_CWD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createTempGitRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-session-"));
  const init = spawnSync("git", ["init", "--initial-branch=main"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  return repoDir;
}

// ---------------------------------------------------------------------------
// sortJobsNewestFirst
// ---------------------------------------------------------------------------

describe("sortJobsNewestFirst", () => {
  it("sorts by updatedAt descending", () => {
    const jobs = [
      { id: "old", updatedAt: "2024-01-01T00:00:00Z" },
      { id: "new", updatedAt: "2024-06-01T00:00:00Z" },
      { id: "mid", updatedAt: "2024-03-01T00:00:00Z" },
    ];
    const sorted = sortJobsNewestFirst(jobs);
    assert.deepEqual(sorted.map((j) => j.id), ["new", "mid", "old"]);
  });

  it("does not mutate the original array", () => {
    const jobs = [
      { id: "a", updatedAt: "2024-06-01T00:00:00Z" },
      { id: "b", updatedAt: "2024-01-01T00:00:00Z" },
    ];
    const original = [...jobs];
    sortJobsNewestFirst(jobs);
    assert.deepEqual(jobs, original);
  });

  it("handles missing updatedAt gracefully", () => {
    const jobs = [
      { id: "nodate" },
      { id: "hasdate", updatedAt: "2024-01-01T00:00:00Z" },
    ];
    const sorted = sortJobsNewestFirst(jobs);
    // hasdate sorts before nodate (non-empty string > empty string)
    assert.equal(sorted[0].id, "hasdate");
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(sortJobsNewestFirst([]), []);
  });
});

describe("DEFAULT_MAX_STATUS_JOBS", () => {
  it("defaults to 15 jobs", () => {
    assert.equal(DEFAULT_MAX_STATUS_JOBS, 15);
  });
});

describe("buildStatusSnapshot", () => {
  it("filters overview jobs to the current session marker when env is absent", () => {
    const repoDir = createTempGitRepo();
    const scopedIds = ["test-status-session-a", "test-status-session-b"];
    try {
      writeJobFile(repoDir, scopedIds[0], {
        id: scopedIds[0],
        status: "completed",
        jobClass: "task",
        sessionId: "session-a",
        createdAt: "2026-04-03T10:00:00Z",
        completedAt: "2026-04-03T10:00:01Z",
        updatedAt: "2026-04-03T10:00:01Z",
      });
      writeJobFile(repoDir, scopedIds[1], {
        id: scopedIds[1],
        status: "completed",
        jobClass: "task",
        sessionId: "session-b",
        createdAt: "2026-04-03T11:00:00Z",
        completedAt: "2026-04-03T11:00:01Z",
        updatedAt: "2026-04-03T11:00:01Z",
      });

      setCurrentSession(repoDir, "session-a");
      const snapshot = buildStatusSnapshot(repoDir);

      assert.equal(snapshot.latestFinished?.id, scopedIds[0]);
      const recentIds = snapshot.recent.map((job) => job.id);
      assert.ok(!recentIds.includes(scopedIds[1]));
      const runningIds = snapshot.running.map((job) => job.id);
      assert.ok(!runningIds.includes(scopedIds[1]));
    } finally {
      clearCurrentSession(repoDir);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("status --all bypasses the current-session filter and shows workspace jobs", () => {
    const repoDir = createTempGitRepo();
    const scopedIds = ["test-status-all-a", "test-status-all-b"];
    try {
      writeJobFile(repoDir, scopedIds[0], {
        id: scopedIds[0],
        status: "completed",
        jobClass: "task",
        sessionId: "session-a",
        createdAt: "2026-04-03T10:00:00Z",
        completedAt: "2026-04-03T10:00:01Z",
        updatedAt: "2026-04-03T10:00:01Z",
      });
      writeJobFile(repoDir, scopedIds[1], {
        id: scopedIds[1],
        status: "completed",
        jobClass: "review",
        sessionId: "session-b",
        createdAt: "2026-04-03T11:00:00Z",
        completedAt: "2026-04-03T11:00:01Z",
        updatedAt: "2026-04-03T11:00:01Z",
      });

      setCurrentSession(repoDir, "session-a");
      const snapshot = buildStatusSnapshot(repoDir, { all: true });

      const ids = [
        snapshot.latestFinished?.id,
        ...snapshot.recent.map((job) => job.id),
        ...snapshot.running.map((job) => job.id),
      ].filter(Boolean);
      assert.ok(ids.includes(scopedIds[0]));
      assert.ok(ids.includes(scopedIds[1]));
    } finally {
      clearCurrentSession(repoDir);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// readJobProgressPreview
// ---------------------------------------------------------------------------

describe("readJobProgressPreview", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-test-"));
  });

  afterEach(() => {
    // Clean up files in tmpDir (keep the dir)
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  });

  it("returns empty array for null logFile", () => {
    assert.deepEqual(readJobProgressPreview(null), []);
  });

  it("returns empty array for non-existent file", () => {
    assert.deepEqual(readJobProgressPreview("/no/such/file.log"), []);
  });

  it("extracts last N timestamped lines", () => {
    const logFile = path.join(tmpDir, "progress.log");
    const lines = [
      "[2024-01-01T00:00:01Z] Starting claude review.",
      "[2024-01-01T00:00:02Z] Reading files.",
      "[2024-01-01T00:00:03Z] Running analysis.",
      "[2024-01-01T00:00:04Z] Writing findings.",
      "[2024-01-01T00:00:05Z] Turn completed.",
    ];
    fs.writeFileSync(logFile, lines.join("\n"), "utf8");

    const preview = readJobProgressPreview(logFile, 3);
    assert.equal(preview.length, 3);
    assert.equal(preview[0], "Running analysis.");
    assert.equal(preview[2], "Turn completed.");
  });

  it("strips timestamp prefix from lines", () => {
    const logFile = path.join(tmpDir, "prefix.log");
    fs.writeFileSync(logFile, "[2024-01-01T10:00:00Z] Hello world.\n", "utf8");
    const preview = readJobProgressPreview(logFile, 1);
    assert.equal(preview[0], "Hello world.");
  });

  it("skips lines without bracket prefix", () => {
    const logFile = path.join(tmpDir, "mixed.log");
    fs.writeFileSync(
      logFile,
      "plain line\n[2024-01-01T00:00:01Z] Timestamped line.\n  indented\n",
      "utf8"
    );
    const preview = readJobProgressPreview(logFile);
    assert.equal(preview.length, 1);
    assert.equal(preview[0], "Timestamped line.");
  });

  it("uses DEFAULT_MAX_PROGRESS_LINES by default", () => {
    const logFile = path.join(tmpDir, "many.log");
    const lines = Array.from({ length: 20 }, (_, i) => `[t${i}] Line ${i}.`);
    fs.writeFileSync(logFile, lines.join("\n"), "utf8");
    const preview = readJobProgressPreview(logFile);
    assert.equal(preview.length, DEFAULT_MAX_PROGRESS_LINES);
  });
});

// ---------------------------------------------------------------------------
// enrichJob
// ---------------------------------------------------------------------------

describe("enrichJob", () => {
  it("adds kindLabel based on jobClass=review", () => {
    const enriched = enrichJob({ id: "j1", status: "completed", jobClass: "review" });
    assert.equal(enriched.kindLabel, "review");
  });

  it("adds kindLabel based on jobClass=task", () => {
    const enriched = enrichJob({ id: "j1", status: "completed", jobClass: "task" });
    assert.equal(enriched.kindLabel, "rescue");
  });

  it("adds kindLabel based on kind=adversarial-review", () => {
    const enriched = enrichJob({ id: "j1", status: "completed", kind: "adversarial-review" });
    assert.equal(enriched.kindLabel, "adversarial-review");
  });

  it("defaults kindLabel to 'job' when no match", () => {
    const enriched = enrichJob({ id: "j1", status: "completed" });
    assert.equal(enriched.kindLabel, "job");
  });

  it("preserves existing kindLabel", () => {
    const enriched = enrichJob({ id: "j1", status: "completed", kindLabel: "custom" });
    assert.equal(enriched.kindLabel, "custom");
  });

  it("ignores a tampered stored logFile path and reads only the managed job log", () => {
    const repoDir = createTempGitRepo();
    const outsideFile = path.join(os.tmpdir(), `jc-outside-${Date.now()}.log`);
    const managedLogFile = resolveJobLogFile(repoDir, "j1");

    try {
      fs.writeFileSync(outsideFile, "[2026-04-04T00:00:00Z] SECRET.\n", "utf8");
      fs.mkdirSync(path.dirname(managedLogFile), { recursive: true });
      fs.writeFileSync(managedLogFile, "[2026-04-04T00:00:00Z] SAFE.\n", "utf8");

      const enriched = enrichJob({
        id: "j1",
        status: "running",
        workspaceRoot: repoDir,
        logFile: outsideFile,
      });

      assert.equal(enriched.logFile, managedLogFile);
      assert.deepEqual(enriched.progressPreview, ["SAFE."]);
    } finally {
      try { fs.unlinkSync(outsideFile); } catch {}
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("calculates elapsed for running job", () => {
    const fiveMinAgo = new Date(Date.now() - 300000).toISOString();
    const enriched = enrichJob({ id: "j1", status: "running", startedAt: fiveMinAgo });
    assert.ok(enriched.elapsed);
    // elapsed should contain minutes
    assert.match(enriched.elapsed, /\d+m/);
  });

  it("calculates duration for completed job", () => {
    const start = "2024-01-01T10:00:00Z";
    const end = "2024-01-01T10:05:30Z";
    const enriched = enrichJob({
      id: "j1",
      status: "completed",
      startedAt: start,
      completedAt: end,
    });
    assert.equal(enriched.duration, "5m 30s");
  });

  it("sets duration to null for running jobs", () => {
    const enriched = enrichJob({ id: "j1", status: "running", startedAt: new Date().toISOString() });
    assert.equal(enriched.duration, null);
  });

  it("infers phase from status", () => {
    assert.equal(enrichJob({ id: "j1", status: "cancelled" }).phase, "cancelled");
    assert.equal(enrichJob({ id: "j1", status: "failed" }).phase, "failed");
    assert.equal(enrichJob({ id: "j1", status: "completed" }).phase, "done");
    assert.equal(enrichJob({ id: "j1", status: "cancelling" }).phase, "cancelling");
    assert.equal(enrichJob({ id: "j1", status: "cancel_failed" }).phase, "cancel_failed");
    assert.equal(enrichJob({ id: "j1", status: "unknown" }).phase, "unknown");
  });

  it("defaults running review phase to 'reviewing'", () => {
    const enriched = enrichJob({ id: "j1", status: "running", jobClass: "review" });
    assert.equal(enriched.phase, "reviewing");
  });

  it("defaults running task phase to 'running'", () => {
    const enriched = enrichJob({ id: "j1", status: "running", jobClass: "task" });
    assert.equal(enriched.phase, "running");
  });
});

// ---------------------------------------------------------------------------
// resolveResultJob
// ---------------------------------------------------------------------------

describe("resolveResultJob", () => {
  const jobIds = ["test-result-active-running", "test-result-active-queued"];

  afterEach(() => {
    for (const id of jobIds) {
      try {
        fs.unlinkSync(path.join(resolveJobsDir(PROJECT_CWD), `${id}.json`));
      } catch {}
    }
  });

  it("returns active state for a referenced running job", () => {
    writeJobFile(PROJECT_CWD, jobIds[0], {
      id: jobIds[0],
      status: "running",
      jobClass: "review",
      title: "Claude Code Review",
      createdAt: "2026-04-03T09:00:00Z",
      startedAt: "2026-04-03T09:00:05Z",
      logFile: "/tmp/test-result-active-running.log",
    });

    const resolved = resolveResultJob(PROJECT_CWD, jobIds[0]);
    assert.equal(resolved.state, "active");
    assert.equal(resolved.job.id, jobIds[0]);
    assert.equal(resolved.job.status, "running");
    assert.ok(resolved.job.elapsed);
  });

  it("returns active state for a referenced queued job", () => {
    writeJobFile(PROJECT_CWD, jobIds[1], {
      id: jobIds[1],
      status: "queued",
      jobClass: "review",
      title: "Claude Code Review",
      createdAt: "2026-04-03T09:00:00Z",
      logFile: "/tmp/test-result-active-queued.log",
    });

    const resolved = resolveResultJob(PROJECT_CWD, jobIds[1]);
    assert.equal(resolved.state, "active");
    assert.equal(resolved.job.id, jobIds[1]);
    assert.equal(resolved.job.status, "queued");
  });
});
