/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";

const DEFAULT_MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_HOOK_INPUT_BYTES = Math.max(
  1,
  Number(process.env.CLAUDE_HOOK_INPUT_MAX_BYTES) ||
    DEFAULT_MAX_HOOK_INPUT_BYTES
);

/**
 * Read and parse JSON hook input from stdin.
 * Returns an empty object when stdin is empty.
 */
export function readHookInput() {
  const rawInput = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(rawInput, "utf8") > MAX_HOOK_INPUT_BYTES) {
    throw new Error(
      `Hook input exceeds ${MAX_HOOK_INPUT_BYTES} bytes.`
    );
  }
  const raw = rawInput.trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid hook input JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
