/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import process from "node:process";

/**
 * Detect whether this Codex session is hosted by an external assistant rather
 * than a user-driven Codex frontend. A Codex app-server spawned from inside
 * Claude Code inherits the Claude Code process env (measured: CLAUDECODE=1 /
 * CLAUDE_CODE_ENTRYPOINT reach plugin hooks). Threads in such an app-server
 * are host-driven, so companion delegation must not loop back to Claude Code.
 *
 * Every writer of the current-session marker must stamp this, or a later
 * rewrite would erase the origin and reopen the delegation loop.
 */
export function detectExternalHostOrigin() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) {
    return "claude-code";
  }
  return null;
}
