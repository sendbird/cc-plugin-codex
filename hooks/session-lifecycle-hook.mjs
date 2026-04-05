#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session lifecycle hook for Codex — Claude Code bridge.
 *
 * SessionStart: Exports CLAUDE_COMPANION_SESSION_ID via CLAUDE_ENV_FILE.
 *
 * SessionEnd:   Cleans up tracked jobs for the session, kills orphan `claude` processes.
 *
 * No broker lifecycle — Claude Code uses direct CLI invocation.
 */

import fs from "node:fs";
import process from "node:process";

import { readHookInput } from "./lib/hook-input.mjs";
import { terminateProcessTree, validateProcessIdentity } from "../scripts/lib/process.mjs";
import {
  ACTIVE_JOB_STATUSES,
  clearCurrentSession,
  getCurrentSession,
  listStoredJobs,
  setCurrentSession,
  transitionJob,
} from "../scripts/lib/state.mjs";
import { nowIso, SESSION_ID_ENV } from "../scripts/lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";

export { SESSION_ID_ENV };
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SKIP_INTERACTIVE_HOOKS_ENV = "CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS";

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(
    process.env.CLAUDE_ENV_FILE,
    `export ${name}=${shellEscape(value)}\n`,
    "utf8"
  );
}

function isNestedCodexSession(inputSessionId) {
  const inheritedSessionId = process.env[SESSION_ID_ENV] || null;
  return Boolean(
    inputSessionId &&
      inheritedSessionId &&
      inheritedSessionId !== inputSessionId
  );
}

// ---------------------------------------------------------------------------
// Session cleanup
// ---------------------------------------------------------------------------

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listStoredJobs(workspaceRoot);
  const sessionJobs = jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return;
  }

  for (const job of sessionJobs) {
    const stillRunning = ACTIVE_JOB_STATUSES.has(job.status);
    if (!stillRunning) {
      continue;
    }
    const hasPid = Number.isFinite(job.pid);
    const hasTrustedPid =
      hasPid &&
      typeof job.pidIdentity === "string" &&
      job.pidIdentity &&
      validateProcessIdentity(job.pid, job.pidIdentity);
    const canSafelyCancel = !hasPid || hasTrustedPid;
    try {
      if (hasTrustedPid) {
        terminateProcessTree(job.pid);
      }
    } catch {
      // Ignore teardown failures during session shutdown.
    }
    try {
      transitionJob(
        workspaceRoot,
        job.id,
        [job.status],
        canSafelyCancel ? "cancelled" : "cancel_failed",
        {
        completedAt: nowIso(),
        errorMessage: canSafelyCancel
          ? "Cancelled when the Codex session ended."
          : "Refused to terminate a stored process without a matching PID identity.",
        pid: canSafelyCancel ? null : job.pid ?? null,
        pidIdentity: canSafelyCancel ? null : job.pidIdentity ?? null,
        phase: canSafelyCancel ? "cancelled" : "cancel_failed",
      }
      );
    } catch {
      // Ignore state transition races during session shutdown.
    }
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handleSessionStart(input) {
  const cwd = input.cwd || process.cwd();
  const nestedSession = isNestedCodexSession(input.session_id);
  // Export session ID so companion scripts can correlate jobs
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(SKIP_INTERACTIVE_HOOKS_ENV, nestedSession ? "1" : "0");
  // Forward plugin data dir if set
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  if (input.session_id && !nestedSession) {
    setCurrentSession(cwd, input.session_id);
  }
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  let sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    try {
      sessionId = getCurrentSession(resolveWorkspaceRoot(cwd));
    } catch {
      sessionId = null;
    }
  }

  // Clean up tracked jobs for this session
  cleanupSessionJobs(cwd, sessionId);
  if (sessionId) {
    clearCurrentSession(cwd, sessionId);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart" || !eventName) {
    // Default to SessionStart (Codex invokes this on session start)
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
