/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Claude Code CLI wrapper — replaces Codex app-server + broker pattern.
 * Spawns `claude -p` subprocess per invocation.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePathSlashes, resolvePluginRuntimeRoot } from "./codex-paths.mjs";
import { getProcessIdentity, validateProcessIdentity } from "./process.mjs";

const CLAUDE_BIN = "claude";
export const MAX_STREAM_PARSER_UNKNOWN_EVENTS = 50;
export const MAX_STREAM_PARSER_PARSE_ERRORS = 50;
export const MAX_STREAM_PARSER_TOOL_USES = 256;
export const MAX_STREAM_PARSER_TOUCHED_FILES = 256;
export const MAX_STDERR_BYTES = 64 * 1024;
export const SANDBOX_TEMP_DIR = normalizePathSlashes(path.resolve(os.tmpdir()));

function pushBoundedTail(list, value, maxEntries) {
  list.push(value);
  if (list.length > maxEntries) {
    list.splice(0, list.length - maxEntries);
  }
}

function pushUniqueBoundedTail(list, value, maxEntries) {
  if (!value || list.includes(value)) {
    return;
  }
  pushBoundedTail(list, value, maxEntries);
}

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

function appendTextTail(existing, chunk, maxBytes) {
  const next = `${existing ?? ""}${chunk ?? ""}`;
  return sliceTextTailByBytes(next, maxBytes);
}

// ---------------------------------------------------------------------------
// Availability & Auth
// ---------------------------------------------------------------------------

export function getClaudeAvailability(cwd) {
  try {
    const result = spawnSync(CLAUDE_BIN, ["--version"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) throw new Error("non-zero exit");
    return { available: true, detail: (result.stdout ?? "").trim() };
  } catch {
    return { available: false, detail: "claude CLI not found in PATH" };
  }
}

export function getClaudeAuthStatus(cwd) {
  if (process.env.ANTHROPIC_API_KEY) {
    return { available: true, loggedIn: true, detail: "API key configured" };
  }
  try {
    const result = spawnSync(CLAUDE_BIN, ["auth", "status"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) throw new Error("not authenticated");
    return { available: true, loggedIn: true, detail: "authenticated" };
  } catch {
    return {
      available: true,
      loggedIn: false,
      detail: "not authenticated — run `claude auth login`",
    };
  }
}

// ---------------------------------------------------------------------------
// Stream Parser — fail-safe with chunk-boundary buffering
// ---------------------------------------------------------------------------

export class StreamParser {
  constructor() {
    this.buffer = "";
    this.state = {
      sessionId: null,
      finalMessage: "",
      structuredOutput: null,
      receivedTerminalEvent: false,
      unknownEvents: [],
      parseErrors: [],
      unresolvedParseErrors: 0,
      toolUses: [],
      touchedFiles: [],
    };
  }

  /** Feed a raw stdout chunk. Returns parsed events. */
  feed(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop(); // keep incomplete trailing line
    return lines.map((l) => this._parseLine(l)).filter(Boolean);
  }

  /** Flush remaining buffer at stream end. */
  flush() {
    if (this.buffer.trim()) {
      const result = this._parseLine(this.buffer);
      this.buffer = "";
      return result ? [result] : [];
    }
    return [];
  }

  _parseLine(line) {
    if (!line.trim()) return null;
    try {
      const event = JSON.parse(line);
      // Extract session_id from any event
      if (event.session_id && !this.state.sessionId) {
        this.state.sessionId = event.session_id;
      }
      switch (event.type) {
        case "stream_event":
          return this._handleStreamEvent(event);
        case "system":
          return this._handleSystemEvent(event);
        case "result":
          this.state.receivedTerminalEvent = true;
          if (event.result) {
            this.state.finalMessage = mergeTerminalResultText(
              this.state.finalMessage,
              event.result
            );
          }
          if (Object.prototype.hasOwnProperty.call(event, "structured_output")) {
            this.state.structuredOutput = event.structured_output ?? null;
          }
          if (event.session_id) this.state.sessionId = event.session_id;
          return { kind: "result", data: event };
        default:
          pushBoundedTail(this.state.unknownEvents, {
            type: event.type,
            ts: Date.now(),
          }, MAX_STREAM_PARSER_UNKNOWN_EVENTS);
          return null;
      }
    } catch (err) {
      this.state.unresolvedParseErrors++;
      pushBoundedTail(this.state.parseErrors, {
        line: line.slice(0, 200),
        error: err.message,
      }, MAX_STREAM_PARSER_PARSE_ERRORS);
      return null;
    }
  }

  _handleStreamEvent(event) {
    const inner = event.event;
    const delta = inner?.delta;
    if (delta?.type === "text_delta" && delta.text) {
      this.state.finalMessage += delta.text;
      return {
        kind: "text",
        text: delta.text,
        message: delta.text,
        phase: "running",
        threadId: this.state.sessionId,
      };
    }

    if (inner?.type === "content_block_delta") {
      const blockDelta = inner.delta;
      if (blockDelta?.type === "text_delta" && blockDelta.text) {
        this.state.finalMessage += blockDelta.text;
        return {
          kind: "text",
          text: blockDelta.text,
          message: blockDelta.text,
          phase: "running",
          threadId: this.state.sessionId,
        };
      }
      if (blockDelta?.type === "thinking_delta" && blockDelta.thinking) {
        return {
          kind: "thinking",
          message: blockDelta.thinking,
          phase: "thinking",
          threadId: this.state.sessionId,
        };
      }
    }

    // Tool use events
    if (inner?.type === "content_block_start") {
      const cb = inner.content_block;
      if (cb?.type === "tool_use") {
        pushBoundedTail(
          this.state.toolUses,
          { tool: cb.name, input: cb.input },
          MAX_STREAM_PARSER_TOOL_USES
        );
        if (cb.name === "Write" || cb.name === "Edit") {
          pushUniqueBoundedTail(
            this.state.touchedFiles,
            cb.input?.file_path ?? cb.input?.path ?? null,
            MAX_STREAM_PARSER_TOUCHED_FILES
          );
        }
        return {
          kind: "tool_use",
          tool: cb.name,
          input: cb.input,
          message: `Using tool: ${cb.name}`,
          phase: "tool",
          threadId: this.state.sessionId,
        };
      }
    }
    return null;
  }

  _handleSystemEvent(event) {
    if (event.subtype === "api_retry") {
      return {
        kind: "system",
        subtype: "api_retry",
        data: event,
        message: "API retry in progress",
        phase: "retry",
        threadId: this.state.sessionId,
      };
    }
    return null;
  }
}

function mergeTerminalResultText(existingText, terminalText) {
  const existing = typeof existingText === "string" ? existingText : "";
  const terminal = typeof terminalText === "string" ? terminalText : "";

  if (!terminal) {
    // Structured-output and tool-only turns can finish with an empty text result.
    return existing;
  }
  if (!existing) {
    return terminal;
  }

  // We observed one real failure mode where the terminal payload only contained
  // a truncated tail of the streamed answer. Preserve the longer streamed copy
  // only for that strict suffix case; otherwise the terminal result is the
  // authoritative final answer according to the streaming contract.
  if (existing.endsWith(terminal) && existing.length > terminal.length) {
    return existing;
  }

  return terminal;
}

// ---------------------------------------------------------------------------
// Turn Completion Validation
// ---------------------------------------------------------------------------

export function validateTurnCompletion(state, exitCode) {
  if (exitCode !== 0) {
    return { status: "failed", exitCode };
  }
  if (state.unresolvedParseErrors > 0) {
    return {
      status: "unknown",
      warning: `${state.unresolvedParseErrors} unrecovered parse errors`,
    };
  }
  if (!state.receivedTerminalEvent) {
    return {
      status: "unknown",
      warning: "No terminal result event received despite exit code 0",
    };
  }
  if (state.unknownEvents.length > 0) {
    // Log but don't fail — protocol drift detection
  }
  return { status: "completed" };
}

// ---------------------------------------------------------------------------
// Sandbox Tool Sets — approximate Codex sandbox modes via allowedTools.
// Codex enforces sandbox at OS level (seatbelt/landlock); Claude Code lacks
// OS-level sandboxing, so we restrict the tool whitelist instead.
// ---------------------------------------------------------------------------

export const SANDBOX_READ_ONLY_BASH_TOOLS = [
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git blame:*)",
  "Bash(git rev-parse:*)",
  "Bash(git branch:*)",
  "Bash(git ls-files:*)",
  "Bash(git merge-base:*)",
  "Bash(git describe:*)",
  "Bash(git shortlog:*)",
  "Bash(git cat-file:*)",
  "Bash(git tag --list:*)",
  "Bash(git stash list:*)",
  "Bash(git config --get:*)",
];

export const SANDBOX_STOP_REVIEW_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
];

/** read-only: file reading + read-only git + web + read-only agents. No writes, MCP, or skills. */
export const SANDBOX_READ_ONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  ...SANDBOX_READ_ONLY_BASH_TOOLS,
  "WebSearch",
  "WebFetch",
  "Agent(explore,plan)",
];

// ---------------------------------------------------------------------------
// Sandbox Settings — OS-level isolation via Claude Code's sandbox feature.
// Written to a temp file and passed via --settings.
// ---------------------------------------------------------------------------

/**
 * Sandbox presets matching Codex sandbox modes.
 *
 * read-only:       no writes at all, no network from Bash.
 * workspace-write: Bash can write to cwd + OS temp dir only, no network from Bash.
 *                  All tools allowed (no allowedTools restriction).
 */
export const SANDBOX_SETTINGS = {
  "read-only": {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        allowWrite: [SANDBOX_TEMP_DIR],
      },
      network: {
        allowedDomains: [],
      },
    },
  },
  "workspace-write": {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        allowWrite: [".", SANDBOX_TEMP_DIR],
      },
      network: {
        allowedDomains: [],
      },
    },
  },
};

/**
 * Write sandbox settings to a temp file. Returns the file path.
 * Caller is responsible for cleanup via cleanupSandboxSettings().
 */
export function createSandboxSettings(mode) {
  const settings = SANDBOX_SETTINGS[mode];
  if (!settings) return null;

  const sandboxDir = path.join(resolvePluginRuntimeRoot(), "sandbox");
  fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(
    sandboxDir,
    `cc-sandbox-${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.json`
  );
  fs.writeFileSync(tmpFile, JSON.stringify(settings), {
    encoding: "utf8",
    mode: 0o600,
  });
  return tmpFile;
}

export function cleanupSandboxSettings(filePath) {
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Model & Effort Mapping
// ---------------------------------------------------------------------------

export const MODEL_ALIASES = new Map([
  ["sonnet", "claude-sonnet-4-6"],
  ["haiku", "claude-haiku-4-5"],
]);

export const EFFORT_ALIASES = {
  none: "low",
  minimal: "low",
  xhigh: "max",
};

export const VALID_EFFORTS = new Set(["low", "medium", "high", "max"]);

export function resolveModel(model) {
  if (!model) return undefined;
  return MODEL_ALIASES.get(model) ?? model;
}

export function resolveEffort(effort) {
  if (!effort) return undefined;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return undefined;
  const resolved = EFFORT_ALIASES[normalized] ?? normalized;
  if (VALID_EFFORTS.has(resolved)) {
    return resolved;
  }
  throw new Error(
    `Unsupported effort "${effort}". Use one of: ${[...VALID_EFFORTS].join(", ")}.`
  );
}

// ---------------------------------------------------------------------------
// Core Execution
// ---------------------------------------------------------------------------

/**
 * Build CLI argument array for `claude -p`.
 */
/** @visibleForTesting */
export function buildArgs(prompt, options = {}) {
  const args = ["-p"];
  // No --bare: it breaks OAuth auth. Isolation is achieved via --allowedTools.

  if (options.outputFormat === "stream-json") {
    args.push(
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages"
    );
  } else {
    args.push("--output-format", options.outputFormat ?? "json");
  }

  if (options.noSessionPersistence) {
    args.push("--no-session-persistence");
  }
  if (options.model) {
    args.push("--model", resolveModel(options.model));
  }
  if (options.effort) {
    args.push("--effort", resolveEffort(options.effort));
  }
  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  if (options.allowedTools) {
    for (const tool of options.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }
  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }
  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.settingsFile) {
    args.push("--settings", options.settingsFile);
  }

  args.push("--", prompt);
  return args;
}

/**
 * Execute a Claude Code turn with streaming progress.
 * Returns { status, sessionId, finalMessage, toolUses, touchedFiles, stderr, pid, pidIdentity }
 */
export async function runClaudeTurn(cwd, prompt, options = {}) {
  const args = buildArgs(prompt, {
    outputFormat: "stream-json",
    ...options,
  });

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      detached: true, // new process group for safe cancellation
      stdio: ["ignore", "pipe", "pipe"], // stdin ignored — prompt is passed as CLI arg
    });

    let pidIdentity = null;
    try {
      pidIdentity = getProcessIdentity(proc.pid);
    } catch {
      // Best-effort — may fail on some platforms
    }

    // Notify caller of child PID at spawn time (before execution completes)
    if (options.onSpawn) {
      options.onSpawn({ pid: proc.pid, pidIdentity });
    }

    const parser = new StreamParser();
    let stderr = "";

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderr = appendTextTail(stderr, chunk, MAX_STDERR_BYTES);
    });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      const events = parser.feed(chunk);
      for (const evt of events) {
        if (options.onProgress) {
          options.onProgress(evt);
        }
      }
    });

    proc.on("close", (code) => {


      // Flush remaining buffer
      const remaining = parser.flush();
      for (const evt of remaining) {
        if (options.onProgress) options.onProgress(evt);
      }

      const validation = validateTurnCompletion(parser.state, code ?? 1);
      resolve({
        status: validation.status,
        warning: validation.warning,
        exitCode: code,
        sessionId: parser.state.sessionId,
        finalMessage: parser.state.finalMessage,
        structuredOutput: parser.state.structuredOutput,
        toolUses: parser.state.toolUses,
        touchedFiles: parser.state.touchedFiles,
        stderr,
        pid: proc.pid,
        pidIdentity,
      });
    });

    proc.on("error", (err) => {

      resolve({
        status: "failed",
        exitCode: -1,
        sessionId: null,
        finalMessage: "",
        structuredOutput: null,
        toolUses: [],
        touchedFiles: [],
        stderr: err.message,
        pid: proc.pid,
        pidIdentity,
      });
    });

    // Unref only for background workers — foreground callers need the process to keep Node alive
    if (options.background) {
      proc.unref();
    }
  });
}

/**
 * Execute a review (non-streaming, no session persistence).
 */
export async function runClaudeReview(cwd, prompt, options = {}) {
  // Use streaming mode (same as runClaudeTurn) for progress reporting
  const result = await runClaudeTurn(cwd, prompt, {
    noSessionPersistence: true,
    allowedTools: SANDBOX_READ_ONLY_TOOLS,
    ...options,
  });

  return {
    status: result.status,
    exitCode: result.exitCode,
    warning: result.warning,
    result: result.finalMessage,
    structuredOutput: result.structuredOutput ?? null,
    sessionId: result.sessionId,
    stderr: result.stderr,
    pid: result.pid,
    pidIdentity: result.pidIdentity,
  };
}

/**
 * Execute an adversarial review with JSON schema output.
 */
export async function runClaudeAdversarialReview(
  cwd,
  prompt,
  schema,
  options = {}
) {
  return runClaudeReview(cwd, prompt, {
    jsonSchema: schema,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Cancellation — process-group based, identity-verified
// ---------------------------------------------------------------------------

/**
 * Cancel a running Claude Code process.
 * Uses process group kill with PID identity verification.
 */
export async function cancelClaudeProcess(pid, pidIdentity) {
  // Verify PID identity to prevent killing recycled PIDs
  if (pidIdentity && !validateProcessIdentity(pid, pidIdentity)) {
    return {
      cancelled: true,
      note: "Process already exited (PID recycled)",
    };
  }

  // SIGTERM to entire process group
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return { cancelled: true, note: "Process not found" };
  }

  // Wait for process group to die
  const dead = await waitForProcessGroup(pid, 5000);
  if (dead) {
    return { cancelled: true };
  }

  // Escalate to SIGKILL
  if (pidIdentity && !validateProcessIdentity(pid, pidIdentity)) {
    return {
      cancelled: true,
      note: "Process exited during SIGTERM wait",
    };
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {}

  const killedDead = await waitForProcessGroup(pid, 3000);
  if (killedDead) {
    return { cancelled: true };
  }

  return {
    cancelled: false,
    note: `Process group ${pid} still alive after SIGKILL`,
  };
}

function isProcessGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroup(pgid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessGroupAlive(pgid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessGroupAlive(pgid);
}
