#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stop-time review gate hook for Codex — Claude Code bridge.
 *
 * Flow:
 * 1. Check config.stopReviewGate — if disabled -> exit 0.
 * 2. If Claude Code is not ready, log setup guidance and allow stop to continue.
 * 3. Run a targeted stop-time review of the previous Codex response.
 * 4. Parse ALLOW:/BLOCK: from Claude's output.
 * 5. If the review returns BLOCK, reject the stop.
 */

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readHookInput } from "./lib/hook-input.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../scripts/lib/prompts.mjs";
import {
  appendStopReviewHistory,
  generateJobId,
  getCurrentSession,
  getConfig,
  listJobs,
  nowIso,
  readTurnBaseline,
  writeStopReviewSnapshot
} from "../scripts/lib/state.mjs";
import {
  getClaudeAvailability,
  getClaudeAuthStatus,
  cleanupSandboxSettings,
  createSandboxSettings,
  runClaudeReview,
  SANDBOX_STOP_REVIEW_TOOLS,
} from "../scripts/lib/claude-cli.mjs";
import { getWorkingTreeFingerprint } from "../scripts/lib/git.mjs";
import { SESSION_ID_ENV } from "../scripts/lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const SKIP_INTERACTIVE_HOOKS_ENV = "CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS";
const STOP_REVIEW_SUCCESS_NOTE = "Claude Code stop-time review passed.";
const STOP_REVIEW_NO_EDIT_NOTE =
  "Claude Code stop-time review skipped: the most recent turn made no net edits.";

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function buildSetupNote(cwd) {
  const availability = getClaudeAvailability(cwd);
  if (!availability.available) {
    return `Claude Code is not set up for the review gate. ${availability.detail}. Run $cc:setup.`;
  }

  const authStatus = getClaudeAuthStatus(cwd);
  if (!authStatus.loggedIn) {
    const detail = authStatus.detail ? ` ${authStatus.detail}.` : "";
    return `Claude Code is not set up for the review gate.${detail} Run $cc:setup and, if needed, \`claude auth login\`.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const previousResponseBlock = lastAssistantMessage
    ? [
        "<previous_codex_response>",
        lastAssistantMessage,
        "</previous_codex_response>",
      ].join("\n")
    : "";
  return interpolateTemplate(template, {
    PREVIOUS_RESPONSE_BLOCK: previousResponseBlock
  });
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      rawOutput: text,
      firstLine: "",
      reason:
        "The stop-time Claude Code review returned no output. Run $cc:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  const allowIndex = text.indexOf("ALLOW:");
  const blockIndex = text.indexOf("BLOCK:");
  const markerIndex =
    allowIndex === -1
      ? blockIndex
      : blockIndex === -1
        ? allowIndex
        : Math.min(allowIndex, blockIndex);
  const contractText = markerIndex >= 0 ? text.slice(markerIndex).trim() : text;
  const contractFirstLine = contractText.split(/\r?\n/, 1)[0].trim();

  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null, rawOutput: text, firstLine };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      rawOutput: text,
      firstLine,
      reason: `Claude Code stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }
  if (contractFirstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null, rawOutput: text, firstLine: contractFirstLine };
  }
  if (contractFirstLine.startsWith("BLOCK:")) {
    const reason =
      contractFirstLine.slice("BLOCK:".length).trim() || contractText;
    return {
      ok: false,
      rawOutput: text,
      firstLine: contractFirstLine,
      reason: `Claude Code stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    rawOutput: text,
    firstLine,
    reason:
      "The stop-time Claude Code review returned an unexpected answer. Run $cc:review --wait manually or bypass the gate."
  };
}

// ---------------------------------------------------------------------------
// Review execution via Claude CLI
// ---------------------------------------------------------------------------

async function runStopReview(cwd, input = {}) {
  const prompt = buildStopReviewPrompt(input);
  const sandboxSettingsFile = createSandboxSettings("read-only");
  const promptBytes = Buffer.byteLength(prompt, "utf8");

  try {
    const result = await runClaudeReview(cwd, prompt, {
      allowedTools: SANDBOX_STOP_REVIEW_TOOLS,
      maxTurns: 5,
      permissionMode: "dontAsk",
      settingsFile: sandboxSettingsFile,
    });

    if (result.status !== "completed") {
      const detail = String(
        result.warning || result.stderr || ""
      ).trim();
      return {
        ok: false,
        rawOutput: String(result.result ?? "").trim(),
        firstLine: "",
        claudeStatus: result.status ?? null,
        claudeExitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
        claudeWarning: result.warning ?? null,
        claudeStderr: result.stderr ?? "",
        claudeSessionId: result.sessionId ?? null,
        promptBytes,
        reason: detail
          ? `The stop-time Claude Code review failed: ${detail}`
          : "The stop-time Claude Code review failed. Run $cc:review --wait manually or bypass the gate."
      };
    }

    return {
      ...parseStopReviewOutput(result.result),
      claudeStatus: result.status ?? null,
      claudeExitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
      claudeWarning: result.warning ?? null,
      claudeStderr: result.stderr ?? "",
      claudeSessionId: result.sessionId ?? null,
      promptBytes,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      rawOutput: "",
      firstLine: "",
      claudeStatus: "error",
      claudeExitCode: null,
      claudeWarning: null,
      claudeStderr: detail,
      claudeSessionId: null,
      promptBytes,
      reason: `The stop-time Claude Code review failed: ${detail}`
    };
  } finally {
    cleanupSandboxSettings(sandboxSettingsFile);
  }
}

// ---------------------------------------------------------------------------
// Running job check
// ---------------------------------------------------------------------------

function filterJobsForCurrentSession(jobs, sessionId = null) {
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function checkRunningJobs(workspaceRoot, sessionId = null) {
  const jobs = filterJobsForCurrentSession(listJobs(workspaceRoot), sessionId);
  const sorted = [...jobs].sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
  );
  const runningJob = sorted.find(
    (job) => job.status === "queued" || job.status === "running"
  );
  return runningJob
    ? `Claude Code task ${runningJob.id} is still running. Check $cc:status and use $cc:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;
}

function summarizeFingerprint(fingerprint) {
  if (!fingerprint) {
    return null;
  }
  const { repoRoot, ...summary } = fingerprint;
  return summary;
}

function evaluateTurnEditGate(cwd, workspaceRoot, sessionId) {
  if (!sessionId) {
    return {
      shouldSkipReview: false,
      reason: "No session id available for turn-baseline comparison.",
      baseline: null,
      current: null,
    };
  }

  const baseline = readTurnBaseline(workspaceRoot, sessionId);
  if (!baseline?.fingerprint) {
    return {
      shouldSkipReview: false,
      reason: "No turn baseline was recorded for this session.",
      baseline,
      current: null,
    };
  }

  try {
    const current = getWorkingTreeFingerprint(cwd);
    const baselineFingerprint = baseline.fingerprint;
    const signaturesMatch =
      baselineFingerprint.signature === current.signature;
    return {
      shouldSkipReview: signaturesMatch,
      reason: signaturesMatch
        ? "The most recent turn made no net tracked/untracked edits."
        : "The most recent turn changed the working tree fingerprint.",
      baseline,
      current,
    };
  } catch (error) {
    return {
      shouldSkipReview: false,
      reason:
        error instanceof Error
          ? `Turn-baseline comparison failed: ${error.message}`
          : `Turn-baseline comparison failed: ${String(error)}`,
      baseline,
      current: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId =
    input.session_id ||
    process.env[SESSION_ID_ENV] ||
    getCurrentSession(workspaceRoot) ||
    null;
  const stopReviewRun = {
    runId: generateJobId("stop"),
    startedAt: nowIso(),
    status: "started",
    claudeInvoked: false,
    cwd,
    workspaceRoot,
    sessionId,
    hookSuppressed: process.env[SKIP_INTERACTIVE_HOOKS_ENV] === "1",
    hasLastAssistantMessage: Boolean(
      String(input.last_assistant_message ?? "").trim()
    ),
    lastAssistantMessageChars: String(input.last_assistant_message ?? "").trim().length,
  };
  const persistSnapshot = (patch = {}) =>
    writeStopReviewSnapshot(workspaceRoot, {
      ...stopReviewRun,
      ...patch,
    });
  const persistFinal = (patch = {}) => {
    const snapshot = persistSnapshot({
      ...patch,
      completedAt: nowIso(),
    });
    appendStopReviewHistory(workspaceRoot, snapshot);
    return snapshot;
  };

  if (process.env[SKIP_INTERACTIVE_HOOKS_ENV] === "1") {
    persistFinal({
      status: "skipped_hook_suppressed",
      reason: "Interactive hooks are suppressed for this session.",
    });
    return;
  }

  const config = getConfig(workspaceRoot);
  if (!config.stopReviewGate) {
    persistFinal({
      status: "skipped_config_disabled",
      reason: "stopReviewGate is disabled for this workspace.",
    });
    return;
  }

  const runningTaskNote = checkRunningJobs(workspaceRoot, sessionId);
  const turnEditGate = evaluateTurnEditGate(cwd, workspaceRoot, sessionId);
  const fingerprintFields = {
    baselineFingerprint: summarizeFingerprint(turnEditGate.baseline?.fingerprint),
    currentFingerprint: summarizeFingerprint(turnEditGate.current),
  };
  if (turnEditGate.shouldSkipReview) {
    persistFinal({
      status: "skipped_no_turn_edits",
      reason: turnEditGate.reason,
      claudeInvoked: false,
      runningTaskNote,
      ...fingerprintFields,
    });
    logNote(STOP_REVIEW_NO_EDIT_NOTE);
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    persistFinal({
      status: "skipped_claude_not_ready",
      reason: setupNote,
      runningTaskNote,
      ...fingerprintFields,
    });
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  persistSnapshot({
    status: "running_claude_review",
    claudeInvoked: true,
    runningTaskNote,
    ...fingerprintFields,
  });
  const review = await runStopReview(cwd, input);
  if (!review.ok) {
    persistFinal({
      status: "blocked",
      claudeInvoked: true,
      reason: review.reason,
      rawOutput: review.rawOutput,
      firstLine: review.firstLine,
      claudeStatus: review.claudeStatus,
      claudeExitCode: review.claudeExitCode,
      claudeWarning: review.claudeWarning,
      claudeStderr: review.claudeStderr,
      claudeSessionId: review.claudeSessionId,
      promptBytes: review.promptBytes,
      runningTaskNote,
      ...fingerprintFields,
    });
    emitDecision({
      decision: "block",
      reason: runningTaskNote
        ? `${runningTaskNote} ${review.reason}`
        : review.reason,
    });
    return;
  }

  persistFinal({
    status: "allow",
    claudeInvoked: true,
    reason: STOP_REVIEW_SUCCESS_NOTE,
    rawOutput: review.rawOutput,
    firstLine: review.firstLine,
    claudeStatus: review.claudeStatus,
    claudeExitCode: review.claudeExitCode,
    claudeWarning: review.claudeWarning,
    claudeStderr: review.claudeStderr,
    claudeSessionId: review.claudeSessionId,
    promptBytes: review.promptBytes,
    runningTaskNote,
    ...fingerprintFields,
  });
  logNote(STOP_REVIEW_SUCCESS_NOTE);
  logNote(runningTaskNote);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
