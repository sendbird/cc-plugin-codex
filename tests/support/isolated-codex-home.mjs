/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
// Preloaded by the unit test scripts with `node --import`, which also applies it
// to every test file's process. Plugin state defaults to ~/.codex, so without
// this the tests that create jobs write into the developer's real Codex plugin
// data. Each process gets its own throwaway home. Tests that need a specific
// layout still pass their own HOME or CODEX_HOME to the processes they spawn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-codex-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CODEX_HOME;
process.on("exit", () => {
  fs.rmSync(home, { recursive: true, force: true });
});
