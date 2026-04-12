/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Derived from OpenAI's codex-plugin-cc and modified for Claude Code delegation.
 *
 * Tracked jobs — adapted from codex-plugin-cc.
 * SESSION_ID_ENV changed to CLAUDE_COMPANION_SESSION_ID.
 * Progress messages use [cc] prefix instead of [codex].
 */

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./process.mjs";
import { nowIso, ensureStateDir, getCurrentSession, patchJob, resolveJobLogFile, writeJobFile, cleanupOldJobs, transitionJob } from "./state.mjs";

export { nowIso };

export const SESSION_ID_ENV = "CLAUDE_COMPANION_SESSION_ID";
export const MAX_JOB_LOG_BYTES = 1024 * 1024;
const LOG_TRUNCATION_MARKER = "[... earlier log output truncated ...]\n";

function sliceTextTailByBytes(text, maxBytes) {
  const normalized = typeof text === "string" ? text : String(text ?? "");
  if (!normalized || maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }

  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(normalized.slice(mid), "utf8") > maxBytes) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  let start = low;
  let retained = normalized.slice(start);
  while (start < normalized.length && Buffer.byteLength(retained, "utf8") > maxBytes) {
    start += 1;
    retained = normalized.slice(start);
  }
  return retained;
}

function trimLogFile(logFile, maxBytes = MAX_JOB_LOG_BYTES) {
  if (!logFile || !fs.existsSync(logFile) || maxBytes <= 0) {
    return;
  }

  const content = fs.readFileSync(logFile, "utf8");
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return;
  }

  let retained = content;
  while (Buffer.byteLength(retained, "utf8") > maxBytes) {
    const newlineIndex = retained.indexOf("\n");
    if (newlineIndex === -1 || newlineIndex === retained.length - 1) {
      break;
    }
    retained = retained.slice(newlineIndex + 1);
  }

  let output = retained;
  if (Buffer.byteLength(output, "utf8") > maxBytes) {
    const markerBytes = Buffer.byteLength(LOG_TRUNCATION_MARKER, "utf8");
    if (markerBytes >= maxBytes) {
      output = sliceTextTailByBytes(output, maxBytes);
    } else {
      output =
        LOG_TRUNCATION_MARKER +
        sliceTextTailByBytes(output, maxBytes - markerBytes);
    }
  }

  fs.writeFileSync(logFile, output, "utf8");
}

function appendToBoundedLog(logFile, text) {
  if (!logFile || !text) {
    return;
  }
  fs.appendFileSync(logFile, text, "utf8");
  trimLogFile(logFile);
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  appendToBoundedLog(logFile, `[${nowIso()}] ${normalized}\n`);
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  appendToBoundedLog(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`);
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  ensureStateDir(workspaceRoot);
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, "", "utf8");
  }
  if (title && fs.statSync(logFile).size === 0) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId =
    options.sessionId ??
    env[options.sessionIdEnv ?? SESSION_ID_ENV] ??
    (options.cwd ? getCurrentSession(options.cwd) : null);
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    patchJob(workspaceRoot, jobId, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[cc] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: job.pid ?? null, // Preserve queued worker PID until onSpawn replaces it
    pidIdentity: job.pidIdentity ?? null,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);

  // onSpawn callback: persist Claude child PID/identity at spawn time
  // Guarded by status check — only write if job is still running (cancel may have won)
  const onSpawn = ({ pid, pidIdentity }) => {
    const transition = transitionJob(
      job.workspaceRoot,
      job.id,
      ["running"],
      "running",
      {
        pid,
        pidIdentity,
      }
    );
    if (!transition.transitioned) {
      // Job already left running state (cancel won the race) — kill the child immediately
      try { terminateProcessTree(pid); } catch {}
      return;
    }
  };

  try {
    const execution = await runner(onSpawn);

    // Use CAS for terminal transition: running → completed/failed
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const terminalData = {
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      pidIdentity: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      summary: execution.summary,
      result: execution.payload,
      rendered: execution.rendered,
    };

    const transitioned = transitionJob(
      job.workspaceRoot,
      job.id,
      ["running"],
      completionStatus,
      terminalData
    );
    // If CAS failed, another actor (cancel) already moved the job to a different state — respect that

    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    cleanupOldJobs(job.workspaceRoot);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();

    // Use CAS: running → failed
    transitionJob(job.workspaceRoot, job.id, ["running"], "failed", {
      errorMessage,
      pid: null,
      pidIdentity: null,
      phase: "failed",
      completedAt,
      logFile: options.logFile ?? job.logFile ?? null
    });
    cleanupOldJobs(job.workspaceRoot);

    throw error;
  }
}
