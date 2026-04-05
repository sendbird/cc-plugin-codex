/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * State management — adapted for Codex plugin.
 * Key changes from original:
 * - Plugin-owned state under the cc plugin data namespace
 * - Legacy claude-code namespace migration
 * - Workspace-hash isolation
 * - Config/job separation in filesystem
 * - CAS for job status transitions
 * - Workspace-scoped stop-review gate config
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  LEGACY_PLUGIN_DATA_NAMESPACES,
  resolvePluginDataRoot,
  resolvePluginStateRoot,
  resolvePluginsDataRoot,
} from "./codex-paths.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { isProcessAlive, validateProcessIdentity, getProcessIdentity } from "./process.mjs";

const STATE_VERSION = 1;
let ensuredPluginDataRoot = null;
const CONFIG_FILE_NAME = "config.json";
const JOBS_DIR_NAME = "jobs";
const CURRENT_SESSION_FILE_NAME = "current-session.json";
const STOP_REVIEW_LAST_FILE_NAME = "stop-review-last.json";
const STOP_REVIEW_HISTORY_FILE_NAME = "stop-review-history.jsonl";
const TURN_BASELINE_FILE_PREFIX = "turn-baseline";
const MAX_TERMINAL_JOBS_PER_SESSION = 100;
export const MAX_STOP_REVIEW_HISTORY_ENTRIES = 200;
const REAP_GRACE_MS = 2_000;
export const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "cancelling"]);
const NO_SESSION_RETENTION_BUCKET = "__no-session__";

export function nowIso() {
  return new Date().toISOString();
}

function defaultConfig() {
  return {
    version: STATE_VERSION,
    stopReviewGate: false,
  };
}

function movePath(sourcePath, destinationPath) {
  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
    fs.cpSync(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    fs.rmSync(sourcePath, { recursive: true, force: true });
  }
}

function removeIfEmpty(dirPath) {
  try {
    if (fs.readdirSync(dirPath).length === 0) {
      fs.rmdirSync(dirPath);
    }
  } catch {}
}

function mergeDirectory(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      if (fs.existsSync(destinationPath) && !fs.statSync(destinationPath).isDirectory()) {
        fs.rmSync(destinationPath, { recursive: true, force: true });
      }
      mergeDirectory(sourcePath, destinationPath);
      removeIfEmpty(sourcePath);
      continue;
    }

    if (!fs.existsSync(destinationPath)) {
      movePath(sourcePath, destinationPath);
      continue;
    }

    const sourceStat = fs.statSync(sourcePath);
    const destinationStat = fs.statSync(destinationPath);
    if (sourceStat.mtimeMs > destinationStat.mtimeMs) {
      fs.rmSync(destinationPath, { recursive: true, force: true });
      movePath(sourcePath, destinationPath);
    } else {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  }
}

function migrateLegacyPluginDataRoots() {
  const pluginsDataRoot = resolvePluginsDataRoot();
  const destinationRoot = resolvePluginDataRoot();
  fs.mkdirSync(pluginsDataRoot, { recursive: true, mode: 0o700 });

  for (const legacyNamespace of LEGACY_PLUGIN_DATA_NAMESPACES) {
    const legacyRoot = resolvePluginDataRoot(legacyNamespace);
    if (!fs.existsSync(legacyRoot) || legacyRoot === destinationRoot) {
      continue;
    }

    if (!fs.existsSync(destinationRoot)) {
      movePath(legacyRoot, destinationRoot);
      continue;
    }

    mergeDirectory(legacyRoot, destinationRoot);
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  }
}

function cleanupLegacyStateArtifacts(stateRoot) {
  if (!fs.existsSync(stateRoot)) {
    return;
  }

  for (const workspaceEntry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!workspaceEntry.isDirectory()) {
      continue;
    }

    const workspaceDir = path.join(stateRoot, workspaceEntry.name);
    for (const child of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!child.isFile() || !child.name.startsWith("armed-")) {
        continue;
      }
      try {
        fs.unlinkSync(path.join(workspaceDir, child.name));
      } catch {}
    }
  }
}

function ensurePluginDataLayout() {
  const destinationRoot = resolvePluginDataRoot();
  if (ensuredPluginDataRoot === destinationRoot) {
    return;
  }
  migrateLegacyPluginDataRoots();
  cleanupLegacyStateArtifacts(resolvePluginStateRoot());
  ensuredPluginDataRoot = destinationRoot;
}

function resolveStateRoot() {
  ensurePluginDataLayout();
  return resolvePluginStateRoot();
}

// ---------------------------------------------------------------------------
// Workspace directory resolution
// ---------------------------------------------------------------------------

export function resolveWorkspaceHash(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export function resolveStateDir(cwd) {
  return path.join(resolveStateRoot(), resolveWorkspaceHash(cwd));
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Config (separate from jobs — minimal write contention)
// ---------------------------------------------------------------------------

function resolveConfigFile(cwd) {
  return path.join(resolveStateDir(cwd), CONFIG_FILE_NAME);
}

function resolveCurrentSessionFile(cwd) {
  return path.join(resolveStateDir(cwd), CURRENT_SESSION_FILE_NAME);
}

function resolveStopReviewLastFile(cwd) {
  return path.join(resolveStateDir(cwd), STOP_REVIEW_LAST_FILE_NAME);
}

function resolveStopReviewHistoryFile(cwd) {
  return path.join(resolveStateDir(cwd), STOP_REVIEW_HISTORY_FILE_NAME);
}

function resolveTurnBaselineFile(cwd, sessionId = null) {
  const sessionKey = sessionId ? sanitizeId(sessionId, "session ID") : NO_SESSION_RETENTION_BUCKET;
  return path.join(resolveStateDir(cwd), `${TURN_BASELINE_FILE_PREFIX}.${sessionKey}.json`);
}

export function loadConfig(cwd) {
  const configFile = resolveConfigFile(cwd);
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (parsed.version !== STATE_VERSION) {
      throw new Error(`Incompatible config version: ${parsed.version}`);
    }
    return { ...defaultConfig(), ...parsed };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cwd, config) {
  ensureStateDir(cwd);
  const data = { ...defaultConfig(), ...config, version: STATE_VERSION };
  writeAtomic(resolveConfigFile(cwd), data);
  return data;
}

export function setConfig(cwd, key, value) {
  const config = loadConfig(cwd);
  config[key] = value;
  return saveConfig(cwd, config);
}

export function getConfig(cwd) {
  return loadConfig(cwd);
}

// ---------------------------------------------------------------------------
// Current session marker (fallback when Codex does not propagate env vars)
// ---------------------------------------------------------------------------

export function setCurrentSession(cwd, sessionId) {
  sanitizeId(sessionId, "session ID");
  ensureStateDir(cwd);
  writeAtomic(resolveCurrentSessionFile(cwd), {
    sessionId,
    updatedAt: nowIso(),
  });
}

export function getCurrentSession(cwd) {
  const filePath = resolveCurrentSessionFile(cwd);
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return sanitizeId(payload.sessionId, "session ID");
  } catch {
    return null;
  }
}

export function clearCurrentSession(cwd, sessionId = null) {
  const filePath = resolveCurrentSessionFile(cwd);
  if (sessionId != null) {
    const current = getCurrentSession(cwd);
    if (current !== sessionId) {
      return;
    }
  }
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

// ---------------------------------------------------------------------------
// Input sanitization
// ---------------------------------------------------------------------------

function sanitizeId(id, label = "ID") {
  if (typeof id !== "string" || !/^[\w\-.]+$/.test(id)) {
    throw new Error(`Invalid ${label}: ${String(id).slice(0, 50)}`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Job files (per-job isolation)
// ---------------------------------------------------------------------------

export function resolveJobFile(cwd, jobId) {
  sanitizeId(jobId, "job ID");
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  sanitizeId(jobId, "job ID");
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeAtomic(jobFile, { ...payload, updatedAt: nowIso() });
  return jobFile;
}

export function readJobFile(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null;
  }
}

function readAllJobs(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) return [];
  return fs
    .readdirSync(jobsDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".lock"))
    .map((f) => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(jobsDir, f), "utf8")
        );
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        new Date(b.createdAt ?? 0).getTime() -
        new Date(a.createdAt ?? 0).getTime()
    );
}

export function listStoredJobs(cwd) {
  return readAllJobs(cwd);
}

export function listJobs(cwd) {
  const jobs = reapStaleJobs(cwd, readAllJobs(cwd));
  return partitionJobsForRetention(jobs).retained;
}

function getRetentionBucketKey(job) {
  if (typeof job.sessionId === "string" && job.sessionId.trim()) {
    return job.sessionId.trim();
  }
  return NO_SESSION_RETENTION_BUCKET;
}

function partitionJobsForRetention(jobs) {
  const terminalSeenBySession = new Map();
  const retained = [];
  const pruned = [];

  for (const job of jobs) {
    if (ACTIVE_JOB_STATUSES.has(job.status)) {
      retained.push(job);
      continue;
    }

    const bucketKey = getRetentionBucketKey(job);
    const terminalSeen = terminalSeenBySession.get(bucketKey) ?? 0;
    if (terminalSeen < MAX_TERMINAL_JOBS_PER_SESSION) {
      terminalSeenBySession.set(bucketKey, terminalSeen + 1);
      retained.push(job);
      continue;
    }

    pruned.push(job);
  }

  return { retained, pruned };
}

const REAPABLE_STATUSES = new Set(["running", "cancelling"]);

function mostRecentJobTimestamp(job) {
  const candidates = [job.updatedAt, job.startedAt, job.createdAt]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  if (candidates.length === 0) {
    return null;
  }
  return Math.max(...candidates);
}

function isWithinReapGracePeriod(job, now = Date.now()) {
  const timestamp = mostRecentJobTimestamp(job);
  return Number.isFinite(timestamp) && now - timestamp < REAP_GRACE_MS;
}

/**
 * Detect zombie jobs whose PID has died and auto-transition them to "failed".
 * Called from listJobs() so every job-reading path benefits automatically.
 */
export function reapStaleJobs(cwd, jobs) {
  return jobs.map((job) => {
    if (!REAPABLE_STATUSES.has(job.status) || !job.pid) return job;
    if (isWithinReapGracePeriod(job)) return job;

    // Use pidIdentity if available (PID-reuse safe), otherwise fall back to isProcessAlive
    const alive = job.pidIdentity
      ? validateProcessIdentity(job.pid, job.pidIdentity)
      : isProcessAlive(job.pid);
    if (alive) return job;

    // Process is dead — transition to failed via CAS
    try {
      const transitioned = transitionJob(cwd, job.id, [job.status], "failed", {
        errorMessage: `Process ${job.pid} died without completing. Auto-reaped.`,
        completedAt: nowIso(),
        pid: null,
        pidIdentity: null,
        phase: "failed",
      });
      if (transitioned.transitioned) {
        return readJobFile(cwd, job.id) ?? job;
      }
      // CAS miss — another actor already transitioned; re-read current state
      return readJobFile(cwd, job.id) ?? job;
    } catch {
      return job; // Reaper failure is non-fatal — return original
    }
  });
}

export function upsertJob(cwd, jobPatch) {
  const existing = jobPatch.id ? readJobFile(cwd, jobPatch.id) : null;
  const timestamp = nowIso();
  const job = existing
    ? { ...existing, ...jobPatch, updatedAt: timestamp }
    : { createdAt: timestamp, updatedAt: timestamp, ...jobPatch };
  writeJobFile(cwd, job.id, job);
  return job;
}

export function patchJob(cwd, jobId, patch) {
  const existing = readJobFile(cwd, jobId);
  if (!existing) {
    return null;
  }
  const next = {
    ...existing,
    ...patch,
    id: jobId,
    updatedAt: nowIso(),
  };
  writeJobFile(cwd, jobId, next);
  return next;
}

// ---------------------------------------------------------------------------
// CAS (Compare-And-Swap) for job status transitions
// ---------------------------------------------------------------------------

const CAS_MAX_RETRIES = 3;
const CAS_RETRY_DELAY_MS = 100;

function sleepSync(ms) {
  const boundedMs = Math.max(0, Math.min(Number(ms) || 0, 1_000));
  if (typeof SharedArrayBuffer === "function" && typeof Atomics.wait === "function") {
    const shared = new SharedArrayBuffer(4);
    const view = new Int32Array(shared);
    Atomics.wait(view, 0, 0, boundedMs);
    return;
  }

  const start = Date.now();
  while (Date.now() - start < boundedMs) {
    // Bounded busy-wait fallback when SharedArrayBuffer is unavailable.
  }
}

function recoverStaleLock(lockFile) {
  if (!fs.existsSync(lockFile)) {
    return;
  }
  try {
    const lockData = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    const ownerMatch = validateProcessIdentity(lockData.pid, lockData.identity);
    if (!ownerMatch) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  }
}

function writeLockOwnership(lockFile) {
  let myIdentity = null;
  try {
    myIdentity = getProcessIdentity(process.pid);
  } catch {}
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: process.pid,
      identity: myIdentity,
      timestamp: Date.now(),
    }),
    { mode: 0o600 }
  );
}

function acquireJobLock(lockFile) {
  for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
    recoverStaleLock(lockFile);
    try {
      const fd = fs.openSync(lockFile, "wx");
      writeLockOwnership(lockFile);
      return fd;
    } catch (err) {
      if (err.code === "EEXIST" && attempt < CAS_MAX_RETRIES - 1) {
        const delay =
          CAS_RETRY_DELAY_MS + Math.random() * CAS_RETRY_DELAY_MS;
        sleepSync(delay);
        continue;
      }
      throw err;
    }
  }
  return null;
}

function releaseJobLock(lockFile, fd) {
  if (fd != null) {
    try {
      fs.closeSync(fd);
    } catch {}
  }
  try {
    fs.unlinkSync(lockFile);
  } catch {}
}

// ---------------------------------------------------------------------------
// Stop review observability
// ---------------------------------------------------------------------------

export function writeStopReviewSnapshot(cwd, payload) {
  ensureStateDir(cwd);
  const snapshot = { ...payload, updatedAt: nowIso() };
  writeAtomic(resolveStopReviewLastFile(cwd), snapshot);
  return snapshot;
}

export function readStopReviewSnapshot(cwd) {
  const filePath = resolveStopReviewLastFile(cwd);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function appendStopReviewHistory(cwd, payload) {
  ensureStateDir(cwd);
  const event = { ...payload, recordedAt: nowIso() };
  const filePath = resolveStopReviewHistoryFile(cwd);
  const nextLine = JSON.stringify(event);
  let retainedLines = [];
  try {
    retainedLines = fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {}
  retainedLines.push(nextLine);
  if (retainedLines.length > MAX_STOP_REVIEW_HISTORY_ENTRIES) {
    retainedLines = retainedLines.slice(-MAX_STOP_REVIEW_HISTORY_ENTRIES);
  }
  fs.writeFileSync(filePath, retainedLines.join("\n") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return event;
}

export function writeTurnBaseline(cwd, sessionId, payload) {
  ensureStateDir(cwd);
  const baseline = { ...payload, sessionId, updatedAt: nowIso() };
  writeAtomic(resolveTurnBaselineFile(cwd, sessionId), baseline);
  return baseline;
}

export function readTurnBaseline(cwd, sessionId) {
  const filePath = resolveTurnBaselineFile(cwd, sessionId);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomically transition job status from `expected` to `next`.
 * Returns true on success, false if current status !== expected.
 * Throws on persistent lock contention.
 */
export function casJobStatus(cwd, jobId, expected, next, extra = {}) {
  return transitionJob(cwd, jobId, [expected], next, extra).transitioned;
}

export function transitionJob(cwd, jobId, expectedStatuses, next, extra = {}) {
  const jobFile = resolveJobFile(cwd, jobId);
  const lockFile = jobFile + ".lock";
  const expectedList = Array.isArray(expectedStatuses)
    ? expectedStatuses
    : [expectedStatuses];
  const fd = acquireJobLock(lockFile);

  try {
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    if (!expectedList.includes(job.status)) {
      return {
        transitioned: false,
        previousStatus: job.status,
        job,
      };
    }

    const updatedJob = {
      ...job,
      status: next,
      ...extra,
      updatedAt: nowIso(),
    };
    writeAtomic(jobFile, updatedJob);
    return {
      transitioned: true,
      previousStatus: job.status,
      job: updatedJob,
    };
  } finally {
    releaseJobLock(lockFile, fd);
  }
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

function writeAtomic(filePath, data) {
  const tmp = filePath + `.tmp.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

export function cleanupOldJobs(cwd) {
  const jobs = reapStaleJobs(cwd, readAllJobs(cwd));
  const { pruned: toRemove } = partitionJobsForRetention(jobs);
  for (const job of toRemove) {
    const jobFile = resolveJobFile(cwd, job.id);
    try {
      fs.unlinkSync(jobFile);
    } catch {}
    const defaultLogFile = resolveJobLogFile(cwd, job.id);
    try {
      fs.unlinkSync(defaultLogFile);
    } catch {}
  }
}
