#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session lifecycle hook for Codex — Claude Code bridge.
 *
 * SessionStart: Exports CLAUDE_COMPANION_SESSION_ID via CLAUDE_ENV_FILE.
 * SessionEnd: Reaps dead background jobs and drops the session marker.
 *
 * No broker lifecycle — Claude Code uses direct CLI invocation.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readHookInput } from "./lib/hook-input.mjs";
import { detectExternalHostOrigin } from "./lib/host-origin.mjs";
import { cleanupAfterOfficialUninstall } from "./lib/plugin-install-guard.mjs";
import {
  clearCurrentSession,
  listJobs,
  setCurrentSession,
} from "../scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../scripts/lib/tracked-jobs.mjs";

export { SESSION_ID_ENV };
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SKIP_INTERACTIVE_HOOKS_ENV = "CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function handleSessionStart(input) {
  const cwd = input.cwd || process.cwd();
  const nestedSession = isNestedCodexSession(input.session_id);
  // Export session ID so companion scripts can correlate jobs
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(SKIP_INTERACTIVE_HOOKS_ENV, nestedSession ? "1" : "0");
  // Forward plugin data dir if set
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  if (input.session_id && !nestedSession) {
    setCurrentSession(cwd, input.session_id, {
      hostOrigin: detectExternalHostOrigin(),
    });
  }
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  if (isNestedCodexSession(input.session_id)) {
    return;
  }
  try {
    // listJobs() runs the PID-reuse-safe stale job reaper. Codex caps SessionEnd
    // at a few seconds, so teardown never kills or waits on live processes:
    // detached jobs keep running and the UserPromptSubmit sweeper picks them up.
    listJobs(cwd);
  } catch {
    // Best effort only — teardown must not fail the session shutdown.
  }
  clearCurrentSession(cwd, input.session_id ?? null);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = readHookInput();
  if (cleanupAfterOfficialUninstall(ROOT_DIR)) {
    return;
  }
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
    return;
  }
  if (eventName === "SessionStart" || !eventName) {
    // Default to SessionStart (Codex invokes this on session start)
    handleSessionStart(input);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
