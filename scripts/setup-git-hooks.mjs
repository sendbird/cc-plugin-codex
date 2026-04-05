#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

