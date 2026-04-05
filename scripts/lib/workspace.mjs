/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
