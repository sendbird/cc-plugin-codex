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

import {
  SESSION_ID_ENV,
  MAX_JOB_LOG_BYTES,
  nowIso,
  appendLogLine,
  appendLogBlock,
  createJobLogFile,
  createJobRecord,
  runTrackedJob,
} from "../scripts/lib/tracked-jobs.mjs";
import { clearCurrentSession, ensureStateDir, readJobFile, resolveJobFile, resolveJobLogFile, setCurrentSession, writeJobFile } from "../scripts/lib/state.mjs";

const PROJECT_CWD = path.resolve(new URL(".", import.meta.url).pathname, "..");

function createTempGitRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracked-jobs-session-"));
  const init = spawnSync("git", ["init", "--initial-branch=main"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  return repoDir;
}

// ---------------------------------------------------------------------------
// SESSION_ID_ENV
// ---------------------------------------------------------------------------

describe("SESSION_ID_ENV", () => {
  it("is the expected environment variable name", () => {
    assert.equal(SESSION_ID_ENV, "CLAUDE_COMPANION_SESSION_ID");
  });
});

// ---------------------------------------------------------------------------
// nowIso (re-exported)
// ---------------------------------------------------------------------------

describe("nowIso (tracked-jobs re-export)", () => {
  it("returns a valid ISO timestamp", () => {
    const ts = nowIso();
    assert.ok(typeof ts === "string");
    const parsed = Date.parse(ts);
    assert.ok(Number.isFinite(parsed));
    assert.ok(Math.abs(Date.now() - parsed) < 5000);
  });
});

// ---------------------------------------------------------------------------
// appendLogLine
// ---------------------------------------------------------------------------

describe("appendLogLine", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-test-"));
  });

  afterEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  });

  it("appends timestamped line to file", () => {
    const logFile = path.join(tmpDir, "test.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogLine(logFile, "hello");
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /\[.+\] hello\n/);
  });

  it("appends multiple lines", () => {
    const logFile = path.join(tmpDir, "multi.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogLine(logFile, "line 1");
    appendLogLine(logFile, "line 2");
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  });

  it("skips null/empty messages", () => {
    const logFile = path.join(tmpDir, "skip.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogLine(logFile, null);
    appendLogLine(logFile, "");
    appendLogLine(logFile, "  ");
    const content = fs.readFileSync(logFile, "utf8");
    assert.equal(content, "");
  });

  it("is a no-op when logFile is null", () => {
    // Should not throw
    appendLogLine(null, "hello");
  });

  it("trims oversized logs to the configured byte cap", () => {
    const logFile = path.join(tmpDir, "bounded.log");
    fs.writeFileSync(logFile, "", "utf8");

    appendLogLine(logFile, "header");
    appendLogLine(logFile, "x".repeat(MAX_JOB_LOG_BYTES));

    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(Buffer.byteLength(content, "utf8") <= MAX_JOB_LOG_BYTES);
    assert.ok(content.includes("truncated"), "expected truncation marker");
    assert.ok(content.endsWith("\n"));
  });
});

// ---------------------------------------------------------------------------
// appendLogBlock
// ---------------------------------------------------------------------------

describe("appendLogBlock", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "block-test-"));
  });

  afterEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  });

  it("appends a titled block", () => {
    const logFile = path.join(tmpDir, "block.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogBlock(logFile, "Summary", "some body text");
    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(content.includes("Summary"));
    assert.ok(content.includes("some body text"));
  });

  it("skips when body is null", () => {
    const logFile = path.join(tmpDir, "nobody.log");
    fs.writeFileSync(logFile, "", "utf8");
    appendLogBlock(logFile, "Title", null);
    assert.equal(fs.readFileSync(logFile, "utf8"), "");
  });

  it("skips when logFile is null", () => {
    appendLogBlock(null, "Title", "body"); // no-op
  });

  it("retains the newest block content when the file exceeds the byte cap", () => {
    const logFile = path.join(tmpDir, "bounded-block.log");
    fs.writeFileSync(logFile, "", "utf8");

    appendLogBlock(logFile, "Old", "a".repeat(MAX_JOB_LOG_BYTES));
    appendLogBlock(logFile, "New", "latest-body");

    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(Buffer.byteLength(content, "utf8") <= MAX_JOB_LOG_BYTES);
    assert.ok(content.includes("latest-body"));
  });
});

// ---------------------------------------------------------------------------
// createJobLogFile
// ---------------------------------------------------------------------------

describe("createJobLogFile", () => {
  it("creates an empty log file and writes a title line", () => {
    const logFile = createJobLogFile(PROJECT_CWD, "test-log-job", "code review");
    assert.ok(fs.existsSync(logFile));
    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(content.includes("Starting code review."));
    // Cleanup
    fs.unlinkSync(logFile);
  });

  it("creates log file without title", () => {
    const logFile = createJobLogFile(PROJECT_CWD, "test-no-title", null);
    assert.ok(fs.existsSync(logFile));
    const content = fs.readFileSync(logFile, "utf8");
    assert.equal(content, "");
    fs.unlinkSync(logFile);
  });
});

// ---------------------------------------------------------------------------
// createJobRecord
// ---------------------------------------------------------------------------

describe("createJobRecord", () => {
  afterEach(() => {
    clearCurrentSession(PROJECT_CWD);
  });

  it("adds createdAt timestamp", () => {
    const record = createJobRecord({ id: "j1", kind: "review" });
    assert.ok(record.createdAt);
    assert.ok(Date.parse(record.createdAt) > 0);
  });

  it("preserves base fields", () => {
    const record = createJobRecord({ id: "j1", kind: "review", title: "My Review" });
    assert.equal(record.id, "j1");
    assert.equal(record.kind, "review");
    assert.equal(record.title, "My Review");
  });

  it("picks up sessionId from env", () => {
    const record = createJobRecord({ id: "j1" }, {
      env: { [SESSION_ID_ENV]: "sess-abc" },
    });
    assert.equal(record.sessionId, "sess-abc");
  });

  it("omits sessionId when env var is not set", () => {
    const record = createJobRecord({ id: "j1" }, { env: {} });
    assert.equal(record.sessionId, undefined);
  });

  it("falls back to the current session marker when env is unset", () => {
    const repoDir = createTempGitRepo();
    try {
      setCurrentSession(repoDir, "fallback-session");
      const record = createJobRecord({ id: "j1" }, { env: {}, cwd: repoDir });
      assert.equal(record.sessionId, "fallback-session");
    } finally {
      clearCurrentSession(repoDir);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("supports custom sessionIdEnv", () => {
    const record = createJobRecord({ id: "j1" }, {
      env: { CUSTOM_SESSION: "custom-123" },
      sessionIdEnv: "CUSTOM_SESSION",
    });
    assert.equal(record.sessionId, "custom-123");
  });

  it("prefers an explicit sessionId override over env and marker fallbacks", () => {
    const repoDir = createTempGitRepo();
    try {
      setCurrentSession(repoDir, "marker-session");
      const record = createJobRecord(
        { id: "j1" },
        {
          env: { [SESSION_ID_ENV]: "env-session" },
          cwd: repoDir,
          sessionId: "owner-session",
        }
      );
      assert.equal(record.sessionId, "owner-session");
    } finally {
      clearCurrentSession(repoDir);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runTrackedJob
// ---------------------------------------------------------------------------

describe("runTrackedJob", () => {
  it("does not overwrite a concurrent cancelling transition when onSpawn races with cancel", async () => {
    const repoDir = createTempGitRepo();
    const job = {
      id: "tracked-race-job",
      workspaceRoot: repoDir,
      status: "queued",
      title: "race",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeJobFile(repoDir, job.id, job);

    await runTrackedJob(
      job,
      async (onSpawn) => {
        const beforeSpawn = readJobFile(repoDir, job.id);
        writeJobFile(repoDir, job.id, {
          ...beforeSpawn,
          status: "cancelling",
          updatedAt: nowIso(),
        });
        onSpawn({ pid: 999999, pidIdentity: "fake-ident" });
        return {
          exitStatus: 1,
          threadId: null,
          turnId: null,
          payload: {},
          rendered: "failed",
          summary: "failed",
        };
      },
      {}
    ).catch(() => {});

    const finalJob = readJobFile(repoDir, job.id);
    assert.equal(finalJob.status, "cancelling");
    assert.equal(finalJob.pid, null);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });
});
