#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

console.error(
  [
    "Local checkout installs are no longer supported.",
    "Install cc from the Sendbird Codex marketplace so Codex owns the active plugin cache:",
    "  codex marketplace add sendbird/codex-marketplace",
    "Then install `cc` from that marketplace and run `$cc:setup`.",
  ].join("\n")
);
process.exit(1);
