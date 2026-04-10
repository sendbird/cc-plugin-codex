/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runCommand,
  runCommandChecked,
  binaryAvailable,
  terminateProcessTree,
  formatCommandFailure,
  isProcessAlive,
  validateProcessIdentity,
  getProcessIdentity,
} from "../scripts/lib/process.mjs";

// node may not be on PATH in this test environment; find it once
const NODE_BIN = process.execPath;

// ---------------------------------------------------------------------------
// runCommand
// ---------------------------------------------------------------------------

describe("runCommand", () => {
  it("runs a simple command and captures stdout", () => {
    const result = runCommand("echo", ["hello"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "hello");
    assert.equal(result.signal, null);
    assert.equal(result.error, null);
  });

  it("captures stderr", () => {
    const result = runCommand(NODE_BIN, ["-e", "process.stderr.write('oops')"]);
    assert.equal(result.stderr, "oops");
  });

  it("reports non-zero exit code", () => {
    const result = runCommand(NODE_BIN, ["-e", "process.exit(42)"]);
    assert.equal(result.status, 42);
  });

  it("reports ENOENT for missing command", () => {
    const result = runCommand("definitely-not-a-real-command-xyz");
    assert.ok(result.error);
    assert.equal(result.error.code, "ENOENT");
  });

  it("preserves command and args in result", () => {
    const result = runCommand("echo", ["a", "b"]);
    assert.equal(result.command, "echo");
    assert.deepEqual(result.args, ["a", "b"]);
  });

  it("accepts input via options.input", () => {
    const result = runCommand("cat", [], { input: "stdin data" });
    assert.equal(result.stdout, "stdin data");
  });

  it("does not route commands through a shell", () => {
    let capturedOptions = null;
    const result = runCommand("echo", ["hello"], {
      spawnSyncImpl: (_command, _args, options) => {
        capturedOptions = options;
        return {
          status: 0,
          signal: null,
          stdout: "hello\n",
          stderr: "",
          error: null,
        };
      },
    });

    assert.equal(result.status, 0);
    assert.equal(capturedOptions?.shell, false);
  });

  it("passes maxBuffer through to spawnSync", () => {
    let capturedOptions = null;
    const result = runCommand("echo", ["hello"], {
      maxBuffer: 1234,
      spawnSyncImpl: (_command, _args, options) => {
        capturedOptions = options;
        return {
          status: 0,
          signal: null,
          stdout: "hello\n",
          stderr: "",
          error: null,
        };
      },
    });

    assert.equal(result.status, 0);
    assert.equal(capturedOptions?.maxBuffer, 1234);
  });
});

// ---------------------------------------------------------------------------
// runCommandChecked
// ---------------------------------------------------------------------------

describe("runCommandChecked", () => {
  it("returns result for successful command", () => {
    const result = runCommandChecked("echo", ["ok"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "ok");
  });

  it("throws on non-zero exit code", () => {
    assert.throws(
      () => runCommandChecked(NODE_BIN, ["-e", "process.exit(1)"]),
      (err) => err instanceof Error && err.message.includes("exit=1")
    );
  });

  it("throws the actual Error for ENOENT", () => {
    assert.throws(
      () => runCommandChecked("no-such-binary-xyz"),
      (err) => err.code === "ENOENT"
    );
  });
});

// ---------------------------------------------------------------------------
// binaryAvailable
// ---------------------------------------------------------------------------

describe("binaryAvailable", () => {
  it("returns available:true for known binary (node)", () => {
    const result = binaryAvailable(NODE_BIN, ["--version"]);
    assert.equal(result.available, true);
    assert.ok(result.detail.startsWith("v"));
  });

  it("returns available:false for missing binary", () => {
    const result = binaryAvailable("not-real-binary-xyz");
    assert.equal(result.available, false);
    assert.equal(result.detail, "not found");
  });

  it("returns available:false when command exits non-zero", () => {
    const result = binaryAvailable(NODE_BIN, ["-e", "process.exit(1)"]);
    assert.equal(result.available, false);
  });
});

// ---------------------------------------------------------------------------
// formatCommandFailure
// ---------------------------------------------------------------------------

describe("formatCommandFailure", () => {
  it("formats command with exit code", () => {
    const msg = formatCommandFailure({
      command: "git",
      args: ["push"],
      status: 128,
      signal: null,
      stdout: "",
      stderr: "fatal: not a repo",
    });
    assert.ok(msg.includes("git push"));
    assert.ok(msg.includes("exit=128"));
    assert.ok(msg.includes("fatal: not a repo"));
  });

  it("formats command with signal", () => {
    const msg = formatCommandFailure({
      command: "sleep",
      args: ["100"],
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
    });
    assert.ok(msg.includes("signal=SIGKILL"));
  });

  it("falls back to stdout when stderr is empty", () => {
    const msg = formatCommandFailure({
      command: "test",
      args: [],
      status: 1,
      signal: null,
      stdout: "some output",
      stderr: "",
    });
    assert.ok(msg.includes("some output"));
  });
});

// ---------------------------------------------------------------------------
// terminateProcessTree
// ---------------------------------------------------------------------------

describe("terminateProcessTree", () => {
  it("returns attempted:false for non-finite PID", () => {
    assert.deepEqual(terminateProcessTree(NaN), {
      attempted: false,
      delivered: false,
      method: null,
    });
    assert.deepEqual(terminateProcessTree(Infinity), {
      attempted: false,
      delivered: false,
      method: null,
    });
  });

  describe("unix path", () => {
    it("sends SIGTERM to process group on success", () => {
      let killedPid = null;
      let killedSignal = null;
      const result = terminateProcessTree(12345, {
        platform: "linux",
        killImpl: (pid, sig) => {
          killedPid = pid;
          killedSignal = sig;
        },
      });
      assert.equal(result.attempted, true);
      assert.equal(result.delivered, true);
      assert.equal(result.method, "process-group");
      assert.equal(killedPid, -12345); // negative = process group
      assert.equal(killedSignal, "SIGTERM");
    });

    it("falls back to direct kill on EPERM for group", () => {
      let directPid = null;
      const result = terminateProcessTree(12345, {
        platform: "linux",
        killImpl: (pid, sig) => {
          if (pid < 0) {
            const err = new Error("EPERM");
            err.code = "EPERM";
            throw err;
          }
          directPid = pid;
        },
      });
      assert.equal(result.delivered, true);
      assert.equal(result.method, "process");
      assert.equal(directPid, 12345);
    });

    it("returns delivered:false when process group ESRCH", () => {
      const result = terminateProcessTree(12345, {
        platform: "linux",
        killImpl: () => {
          const err = new Error("ESRCH");
          err.code = "ESRCH";
          throw err;
        },
      });
      assert.equal(result.attempted, true);
      assert.equal(result.delivered, false);
    });
  });

  describe("win32 path", () => {
    it("uses taskkill on windows", () => {
      let capturedArgs = null;
      const result = terminateProcessTree(12345, {
        platform: "win32",
        runCommandImpl: (cmd, args) => {
          capturedArgs = args;
          return { error: null, status: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(result.delivered, true);
      assert.equal(result.method, "taskkill");
      assert.deepEqual(capturedArgs, ["/PID", "12345", "/T", "/F"]);
    });

    it("falls back to kill when taskkill ENOENT", () => {
      let killCalled = false;
      const result = terminateProcessTree(12345, {
        platform: "win32",
        runCommandImpl: () => ({
          error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
          status: null,
          stdout: "",
          stderr: "",
        }),
        killImpl: (pid) => {
          killCalled = true;
        },
      });
      assert.equal(killCalled, true);
      assert.equal(result.delivered, true);
      assert.equal(result.method, "kill");
    });

    it("detects 'not found' messages from taskkill stderr", () => {
      const result = terminateProcessTree(99999, {
        platform: "win32",
        runCommandImpl: () => ({
          error: null,
          status: 128,
          stdout: "",
          stderr: "ERROR: The process \"99999\" not found.",
        }),
      });
      assert.equal(result.attempted, true);
      assert.equal(result.delivered, false);
      assert.equal(result.method, "taskkill");
    });
  });
});

// ---------------------------------------------------------------------------
// isProcessAlive
// ---------------------------------------------------------------------------

describe("isProcessAlive", () => {
  it("returns true for current process", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("returns false for non-existent PID", () => {
    // PID 99999999 is extremely unlikely to exist
    assert.equal(isProcessAlive(99999999), false);
  });
});

// ---------------------------------------------------------------------------
// getProcessIdentity / validateProcessIdentity
// ---------------------------------------------------------------------------

describe("getProcessIdentity", () => {
  it("returns a non-empty string for the current process", () => {
    const identity = getProcessIdentity(process.pid);
    assert.ok(typeof identity === "string");
    assert.ok(identity.length > 0);
  });

  it("returns same identity on repeated calls", () => {
    const id1 = getProcessIdentity(process.pid);
    const id2 = getProcessIdentity(process.pid);
    assert.equal(id1, id2);
  });
});

describe("validateProcessIdentity", () => {
  it("returns true when identity matches", () => {
    const identity = getProcessIdentity(process.pid);
    assert.equal(validateProcessIdentity(process.pid, identity), true);
  });

  it("returns false for mismatched identity", () => {
    assert.equal(validateProcessIdentity(process.pid, "bogus-identity"), false);
  });

  it("returns false for non-existent PID", () => {
    assert.equal(validateProcessIdentity(99999999, "any"), false);
  });
});
