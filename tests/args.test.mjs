/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../scripts/lib/args.mjs";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("returns empty options and positionals for empty argv", () => {
    const result = parseArgs([]);
    assert.deepEqual(result, { options: {}, positionals: [] });
  });

  it("collects bare positionals", () => {
    const result = parseArgs(["foo", "bar", "baz"]);
    assert.deepEqual(result.positionals, ["foo", "bar", "baz"]);
    assert.deepEqual(result.options, {});
  });

  it("treats a lone dash as a positional", () => {
    const result = parseArgs(["-"]);
    assert.deepEqual(result.positionals, ["-"]);
  });

  describe("boolean options", () => {
    const config = { booleanOptions: ["verbose", "dry-run"] };

    it("sets boolean options to true", () => {
      const result = parseArgs(["--verbose", "--dry-run"], config);
      assert.equal(result.options.verbose, true);
      assert.equal(result.options["dry-run"], true);
    });

    it("supports --flag=false to set boolean to false", () => {
      const result = parseArgs(["--verbose=false"], config);
      assert.equal(result.options.verbose, false);
    });

    it("supports --flag=true inline", () => {
      const result = parseArgs(["--verbose=true"], config);
      assert.equal(result.options.verbose, true);
    });
  });

  describe("value options", () => {
    const config = { valueOptions: ["output", "model"] };

    it("parses --key value pairs", () => {
      const result = parseArgs(["--output", "/tmp/out", "--model", "sonnet"], config);
      assert.equal(result.options.output, "/tmp/out");
      assert.equal(result.options.model, "sonnet");
    });

    it("parses --key=value inline form", () => {
      const result = parseArgs(["--output=/tmp/out"], config);
      assert.equal(result.options.output, "/tmp/out");
    });

    it("throws on missing value", () => {
      assert.throws(
        () => parseArgs(["--output"], config),
        /Missing value for --output/
      );
    });
  });

  describe("short options", () => {
    const config = {
      valueOptions: ["output"],
      booleanOptions: ["verbose"],
      aliasMap: { v: "verbose", o: "output" },
    };

    it("resolves short boolean aliases", () => {
      const result = parseArgs(["-v"], config);
      assert.equal(result.options.verbose, true);
    });

    it("resolves short value aliases with next arg", () => {
      const result = parseArgs(["-o", "/tmp/out"], config);
      assert.equal(result.options.output, "/tmp/out");
    });

    it("throws on missing value for short option", () => {
      assert.throws(
        () => parseArgs(["-o"], config),
        /Missing value for -o/
      );
    });
  });

  describe("alias mapping", () => {
    const config = {
      valueOptions: ["scope"],
      aliasMap: { s: "scope", "review-scope": "scope" },
    };

    it("maps long alias to canonical name", () => {
      const result = parseArgs(["--review-scope", "branch"], config);
      assert.equal(result.options.scope, "branch");
    });

    it("maps short alias to canonical name", () => {
      const result = parseArgs(["-s", "working-tree"], config);
      assert.equal(result.options.scope, "working-tree");
    });
  });

  describe("passthrough (--)", () => {
    it("treats everything after -- as positionals", () => {
      const config = { booleanOptions: ["verbose"] };
      const result = parseArgs(["--verbose", "--", "--not-a-flag", "extra"], config);
      assert.equal(result.options.verbose, true);
      assert.deepEqual(result.positionals, ["--not-a-flag", "extra"]);
    });
  });

  describe("unknown options become positionals", () => {
    it("pushes unknown long options to positionals", () => {
      const result = parseArgs(["--unknown-flag"], {});
      assert.deepEqual(result.positionals, ["--unknown-flag"]);
    });

    it("pushes unknown short options to positionals", () => {
      const result = parseArgs(["-x"], {});
      assert.deepEqual(result.positionals, ["-x"]);
    });
  });

  describe("mixed positionals and options", () => {
    it("handles interleaved args correctly", () => {
      const config = {
        valueOptions: ["model"],
        booleanOptions: ["verbose"],
      };
      const result = parseArgs(["review", "--verbose", "--model", "opus", "extra"], config);
      assert.deepEqual(result.positionals, ["review", "extra"]);
      assert.equal(result.options.verbose, true);
      assert.equal(result.options.model, "opus");
    });
  });
});

// ---------------------------------------------------------------------------
// splitRawArgumentString
// ---------------------------------------------------------------------------

describe("splitRawArgumentString", () => {
  it("returns empty array for empty string", () => {
    assert.deepEqual(splitRawArgumentString(""), []);
  });

  it("splits simple whitespace-separated tokens", () => {
    assert.deepEqual(splitRawArgumentString("foo bar baz"), ["foo", "bar", "baz"]);
  });

  it("handles multiple whitespace characters", () => {
    assert.deepEqual(splitRawArgumentString("  foo   bar  "), ["foo", "bar"]);
  });

  it("handles tab and mixed whitespace", () => {
    assert.deepEqual(splitRawArgumentString("foo\tbar  baz"), ["foo", "bar", "baz"]);
  });

  describe("quoted strings", () => {
    it("handles double-quoted strings", () => {
      assert.deepEqual(
        splitRawArgumentString('hello "world wide" test'),
        ["hello", "world wide", "test"]
      );
    });

    it("handles single-quoted strings", () => {
      assert.deepEqual(
        splitRawArgumentString("hello 'world wide' test"),
        ["hello", "world wide", "test"]
      );
    });

    it("handles empty quotes", () => {
      assert.deepEqual(splitRawArgumentString('""'), []);
    });

    it("handles quotes adjacent to text", () => {
      assert.deepEqual(
        splitRawArgumentString('pre"quoted"post'),
        ["prequotedpost"]
      );
    });
  });

  describe("escape sequences", () => {
    it("handles backslash-escaped spaces", () => {
      assert.deepEqual(splitRawArgumentString("hello\\ world"), ["hello world"]);
    });

    it("handles backslash-escaped quotes", () => {
      assert.deepEqual(splitRawArgumentString('say\\"hi\\"'), ['say"hi"']);
    });

    it("handles trailing backslash", () => {
      assert.deepEqual(splitRawArgumentString("trail\\"), ["trail\\"]);
    });
  });

  describe("complex cases", () => {
    it("handles mixed quotes and escapes", () => {
      assert.deepEqual(
        splitRawArgumentString('--model "claude opus" --verbose'),
        ["--model", "claude opus", "--verbose"]
      );
    });

    it("handles flags with values", () => {
      assert.deepEqual(
        splitRawArgumentString("--output '/tmp/my dir/file.txt' --dry-run"),
        ["--output", "/tmp/my dir/file.txt", "--dry-run"]
      );
    });
  });
});
