/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  StreamParser,
  validateTurnCompletion,
  resolveModel,
  resolveEffort,
  resolveDefaultModel,
  resolveDefaultEffort,
  resolveClaudeBin,
  buildArgs,
  EFFORT_ALIASES,
  VALID_EFFORTS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT_BY_MODEL,
  SANDBOX_READ_ONLY_BASH_TOOLS,
  SANDBOX_READ_ONLY_TOOLS,
  SANDBOX_TEMP_DIR,
  SANDBOX_SETTINGS,
  MAX_STREAM_PARSER_UNKNOWN_EVENTS,
  MAX_STREAM_PARSER_PARSE_ERRORS,
  MAX_STREAM_PARSER_TOOL_USES,
  MAX_STREAM_PARSER_TOUCHED_FILES,
} from "../scripts/lib/claude-cli.mjs";

// ===========================================================================
// StreamParser
// ===========================================================================

describe("StreamParser", () => {
  // ---- basic event parsing ------------------------------------------------

  it("parses a result event and marks receivedTerminalEvent", () => {
    const parser = new StreamParser();
    const resultEvent = JSON.stringify({
      type: "result",
      result: "done",
      session_id: "sess-1",
    });
    const events = parser.feed(resultEvent + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "result");
    assert.equal(parser.state.receivedTerminalEvent, true);
    assert.equal(parser.state.sessionId, "sess-1");
    assert.equal(parser.state.finalMessage, "done");
  });

  it("captures terminal structured_output even when result text is empty", () => {
    const parser = new StreamParser();
    const resultEvent = JSON.stringify({
      type: "result",
      result: "",
      structured_output: { answer: "ALPHA" },
      session_id: "sess-structured",
    });

    parser.feed(resultEvent + "\n");

    assert.equal(parser.state.receivedTerminalEvent, true);
    assert.deepEqual(parser.state.structuredOutput, { answer: "ALPHA" });
    assert.equal(parser.state.finalMessage, "");
  });

  it("does not overwrite accumulated deltas with a shorter terminal suffix", () => {
    const parser = new StreamParser();
    const delta = JSON.stringify({
      type: "stream_event",
      session_id: "sess-tail",
      event: { delta: { type: "text_delta", text: "Finding 1\nFinding 2\nFinding 3" } },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      session_id: "sess-tail",
      result: "Finding 3",
    });

    parser.feed(delta + "\n");
    parser.feed(resultEvent + "\n");

    assert.equal(
      parser.state.finalMessage,
      "Finding 1\nFinding 2\nFinding 3"
    );
  });

  it("upgrades accumulated deltas when the terminal result is a full superset", () => {
    const parser = new StreamParser();
    const delta = JSON.stringify({
      type: "stream_event",
      session_id: "sess-full",
      event: { delta: { type: "text_delta", text: "Finding 1\nFinding 2" } },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      session_id: "sess-full",
      result: "Finding 1\nFinding 2\nFinding 3",
    });

    parser.feed(delta + "\n");
    parser.feed(resultEvent + "\n");

    assert.equal(
      parser.state.finalMessage,
      "Finding 1\nFinding 2\nFinding 3"
    );
  });

  it("prefers the terminal result when both payloads are non-empty and disagree", () => {
    const parser = new StreamParser();
    const delta = JSON.stringify({
      type: "stream_event",
      session_id: "sess-disjoint",
      event: { delta: { type: "text_delta", text: "Structured review body" } },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      session_id: "sess-disjoint",
      result: "Metadata wrapper",
    });

    parser.feed(delta + "\n");
    parser.feed(resultEvent + "\n");

    assert.equal(parser.state.finalMessage, "Metadata wrapper");
  });

  it("keeps accumulated deltas when the terminal result is empty", () => {
    const parser = new StreamParser();
    const delta = JSON.stringify({
      type: "stream_event",
      session_id: "sess-empty-terminal",
      event: { delta: { type: "text_delta", text: "Structured review body" } },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      session_id: "sess-empty-terminal",
      result: "",
    });

    parser.feed(delta + "\n");
    parser.feed(resultEvent + "\n");

    assert.equal(parser.state.finalMessage, "Structured review body");
  });

  it("parses a text_delta stream_event", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "stream_event",
      session_id: "sess-2",
      event: { delta: { type: "text_delta", text: "hello" } },
    });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "text");
    assert.equal(events[0].text, "hello");
    assert.equal(events[0].message, "hello");
    assert.equal(events[0].phase, "running");
    assert.equal(parser.state.finalMessage, "hello");
  });

  it("parses a content_block_delta text_delta from newer stream-json output", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "stream_event",
      session_id: "sess-cbd",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "chunk" },
      },
    });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "text");
    assert.equal(events[0].text, "chunk");
    assert.equal(events[0].message, "chunk");
    assert.equal(events[0].phase, "running");
    assert.equal(events[0].threadId, "sess-cbd");
    assert.equal(parser.state.finalMessage, "chunk");
  });

  it("parses a content_block_delta thinking_delta as progress", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "stream_event",
      session_id: "sess-think",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "planning" },
      },
    });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "thinking");
    assert.equal(events[0].message, "planning");
    assert.equal(events[0].phase, "thinking");
    assert.equal(events[0].threadId, "sess-think");
  });

  it("parses a tool_use content_block_start event", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Read", input: { path: "/a" } },
      },
    });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "tool_use");
    assert.equal(events[0].tool, "Read");
    assert.deepEqual(events[0].input, { path: "/a" });
    assert.equal(events[0].message, "Using tool: Read");
    assert.equal(events[0].phase, "tool");
    assert.equal(parser.state.toolUses.length, 1);
  });

  it("parses system api_retry event", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({ type: "system", subtype: "api_retry", message: "retrying" });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "system");
    assert.equal(events[0].subtype, "api_retry");
  });

  it("returns null for unknown event types and tracks them", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({ type: "unknown_event", data: "x" });
    const events = parser.feed(evt + "\n");
    assert.equal(events.length, 0);
    assert.equal(parser.state.unknownEvents.length, 1);
    assert.equal(parser.state.unknownEvents[0].type, "unknown_event");
  });

  it("caps unknown event history to the configured maximum", () => {
    const parser = new StreamParser();

    for (let i = 0; i < MAX_STREAM_PARSER_UNKNOWN_EVENTS + 7; i++) {
      parser.feed(JSON.stringify({ type: `unknown_${i}` }) + "\n");
    }

    assert.equal(parser.state.unknownEvents.length, MAX_STREAM_PARSER_UNKNOWN_EVENTS);
    assert.equal(parser.state.unknownEvents[0].type, "unknown_7");
    assert.equal(
      parser.state.unknownEvents.at(-1).type,
      `unknown_${MAX_STREAM_PARSER_UNKNOWN_EVENTS + 6}`
    );
  });

  it("skips blank lines", () => {
    const parser = new StreamParser();
    const events = parser.feed("\n\n\n");
    assert.equal(events.length, 0);
  });

  // ---- chunk-boundary buffering ------------------------------------------

  it("buffers incomplete JSON across chunks", () => {
    const parser = new StreamParser();
    const full = JSON.stringify({ type: "result", result: "ok", session_id: "s1" });
    const mid = Math.floor(full.length / 2);

    // first chunk — incomplete line, no events
    const events1 = parser.feed(full.slice(0, mid));
    assert.equal(events1.length, 0);

    // second chunk — completes the line
    const events2 = parser.feed(full.slice(mid) + "\n");
    assert.equal(events2.length, 1);
    assert.equal(events2[0].kind, "result");
    assert.equal(parser.state.receivedTerminalEvent, true);
  });

  it("handles multiple events in a single chunk", () => {
    const parser = new StreamParser();
    const ev1 = JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "a" } } });
    const ev2 = JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "b" } } });
    const events = parser.feed(ev1 + "\n" + ev2 + "\n");
    assert.equal(events.length, 2);
    assert.equal(parser.state.finalMessage, "ab");
  });

  // ---- flush -------------------------------------------------------------

  it("flush() processes remaining buffer content", () => {
    const parser = new StreamParser();
    const evt = JSON.stringify({ type: "result", result: "final", session_id: "s2" });
    // feed without trailing newline
    parser.feed(evt);
    assert.equal(parser.state.receivedTerminalEvent, false);

    const flushed = parser.flush();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].kind, "result");
    assert.equal(parser.state.receivedTerminalEvent, true);
  });

  it("flush() on empty buffer returns empty array", () => {
    const parser = new StreamParser();
    assert.deepEqual(parser.flush(), []);
  });

  it("flush() on whitespace-only buffer returns empty array", () => {
    const parser = new StreamParser();
    parser.feed("   ");
    assert.deepEqual(parser.flush(), []);
  });

  // ---- parse error handling -----------------------------------------------

  it("records parse errors for invalid JSON", () => {
    const parser = new StreamParser();
    const events = parser.feed("not valid json\n");
    assert.equal(events.length, 0);
    assert.equal(parser.state.unresolvedParseErrors, 1);
    assert.equal(parser.state.parseErrors.length, 1);
    assert.ok(parser.state.parseErrors[0].line.includes("not valid json"));
  });

  it("caps stored parse error samples while keeping the total unresolved count", () => {
    const parser = new StreamParser();

    for (let i = 0; i < MAX_STREAM_PARSER_PARSE_ERRORS + 9; i++) {
      parser.feed(`not valid json ${i}\n`);
    }

    assert.equal(parser.state.unresolvedParseErrors, MAX_STREAM_PARSER_PARSE_ERRORS + 9);
    assert.equal(parser.state.parseErrors.length, MAX_STREAM_PARSER_PARSE_ERRORS);
    assert.ok(parser.state.parseErrors[0].line.includes(`not valid json 9`));
  });

  it("caps stored tool-use samples and touched file tracking", () => {
    const parser = new StreamParser();
    const total = MAX_STREAM_PARSER_TOOL_USES + 11;

    for (let i = 0; i < total; i++) {
      parser.feed(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: {
              type: "tool_use",
              name: i % 2 === 0 ? "Write" : "Edit",
              input: { file_path: `/tmp/file-${i}.txt` },
            },
          },
        }) + "\n"
      );
    }

    assert.equal(parser.state.toolUses.length, MAX_STREAM_PARSER_TOOL_USES);
    assert.equal(parser.state.toolUses[0].input.file_path, "/tmp/file-11.txt");
    assert.equal(
      parser.state.toolUses.at(-1).input.file_path,
      `/tmp/file-${total - 1}.txt`
    );
    assert.equal(parser.state.touchedFiles.length, MAX_STREAM_PARSER_TOUCHED_FILES);
    assert.equal(parser.state.touchedFiles[0], "/tmp/file-11.txt");
    assert.equal(
      parser.state.touchedFiles.at(-1),
      `/tmp/file-${total - 1}.txt`
    );
  });

  // ---- session_id extraction ----------------------------------------------

  it("extracts session_id from first event only", () => {
    const parser = new StreamParser();
    const ev1 = JSON.stringify({ type: "stream_event", session_id: "first", event: { delta: { type: "text_delta", text: "x" } } });
    const ev2 = JSON.stringify({ type: "stream_event", session_id: "second", event: { delta: { type: "text_delta", text: "y" } } });
    parser.feed(ev1 + "\n" + ev2 + "\n");
    assert.equal(parser.state.sessionId, "first");
  });
});

// ===========================================================================
// validateTurnCompletion
// ===========================================================================

describe("validateTurnCompletion", () => {
  it("returns completed for exit 0 with terminal event", () => {
    const state = { receivedTerminalEvent: true, unresolvedParseErrors: 0, unknownEvents: [] };
    const result = validateTurnCompletion(state, 0);
    assert.equal(result.status, "completed");
  });

  it("returns unknown for exit 0 without terminal event", () => {
    const state = { receivedTerminalEvent: false, unresolvedParseErrors: 0, unknownEvents: [] };
    const result = validateTurnCompletion(state, 0);
    assert.equal(result.status, "unknown");
    assert.ok(result.warning.includes("No terminal result event"));
  });

  it("returns failed for non-zero exit code", () => {
    const state = { receivedTerminalEvent: true, unresolvedParseErrors: 0, unknownEvents: [] };
    const result = validateTurnCompletion(state, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
  });

  it("returns unknown when there are unresolved parse errors", () => {
    const state = { receivedTerminalEvent: true, unresolvedParseErrors: 3, unknownEvents: [] };
    const result = validateTurnCompletion(state, 0);
    assert.equal(result.status, "unknown");
    assert.ok(result.warning.includes("3 unrecovered parse errors"));
  });

  it("returns completed even when unknown events exist (protocol drift)", () => {
    const state = { receivedTerminalEvent: true, unresolvedParseErrors: 0, unknownEvents: [{ type: "new_type", ts: 1 }] };
    const result = validateTurnCompletion(state, 0);
    assert.equal(result.status, "completed");
  });
});

// ===========================================================================
// resolveModel
// ===========================================================================

describe("resolveModel", () => {
  it("canonicalizes friendly model aliases case-insensitively", () => {
    for (const alias of ["fable", "opus", "sonnet", "haiku"]) {
      assert.equal(resolveModel(alias), alias);
      assert.equal(resolveModel(alias.toUpperCase()), alias);
      assert.equal(resolveModel(`${alias[0].toUpperCase()}${alias.slice(1)}`), alias);
    }
  });

  it("passes other aliases, full IDs, and provider-specific names through unchanged", () => {
    for (const alias of ["default", "best", "opusplan", "opus[1m]", "sonnet[1m]"]) {
      assert.equal(resolveModel(alias), alias);
    }
    assert.equal(resolveModel("claude-fable-5"), "claude-fable-5");
    assert.equal(resolveModel("CLAUDE-FABLE-5"), "CLAUDE-FABLE-5");
    assert.equal(
      resolveModel("Us.Anthropic.Claude-Opus-Custom"),
      "Us.Anthropic.Claude-Opus-Custom"
    );
  });

  it("returns undefined for null/undefined input", () => {
    assert.equal(resolveModel(null), undefined);
    assert.equal(resolveModel(undefined), undefined);
  });

  it("returns undefined for blank input", () => {
    assert.equal(resolveModel(""), undefined);
    assert.equal(resolveModel("   "), undefined);
  });

  it("trims surrounding whitespace before canonicalizing friendly aliases", () => {
    assert.equal(resolveModel("  OpUs  "), "opus");
    assert.equal(resolveModel("  claude-fable-5  "), "claude-fable-5");
  });
});

// ===========================================================================
// resolveDefaultModel / resolveDefaultEffort
// ===========================================================================

describe("resolveDefaultModel", () => {
  it("returns 'opus' when model is null/undefined/empty", () => {
    assert.equal(resolveDefaultModel(null), "opus");
    assert.equal(resolveDefaultModel(undefined), "opus");
    assert.equal(resolveDefaultModel(""), "opus");
    assert.equal(resolveDefaultModel("   "), "opus");
  });

  it("passes through an explicit model", () => {
    assert.equal(resolveDefaultModel("sonnet"), "sonnet");
    assert.equal(resolveDefaultModel("fable"), "fable");
    assert.equal(resolveDefaultModel("haiku"), "haiku");
    assert.equal(resolveDefaultModel("claude-opus-4-7"), "claude-opus-4-7");
  });

  it("exposes DEFAULT_MODEL constant as 'opus'", () => {
    assert.equal(DEFAULT_MODEL, "opus");
  });
});

describe("resolveDefaultEffort", () => {
  it("defaults to high for every friendly model alias", () => {
    for (const alias of ["fable", "opus", "sonnet", "haiku"]) {
      assert.equal(resolveDefaultEffort(alias, null), "high");
      assert.equal(resolveDefaultEffort(alias.toUpperCase(), undefined), "high");
    }
  });

  it("does not infer effort for full or provider-specific model names", () => {
    assert.equal(resolveDefaultEffort("claude-opus-4-7[1m]", null), undefined);
    assert.equal(resolveDefaultEffort("claude-sonnet-4-6", null), undefined);
    assert.equal(resolveDefaultEffort("us.anthropic.claude-opus-custom", null), undefined);
    assert.equal(resolveDefaultEffort("some-future-model", null), undefined);
  });

  it("preserves an explicit effort regardless of model", () => {
    assert.equal(resolveDefaultEffort("opus", "low"), "low");
    assert.equal(resolveDefaultEffort("sonnet", "medium"), "medium");
    assert.equal(resolveDefaultEffort("haiku", "high"), "high");
    assert.equal(resolveDefaultEffort(null, "max"), "max");
  });

  it("treats blank effort as missing", () => {
    assert.equal(resolveDefaultEffort("opus", ""), "high");
    assert.equal(resolveDefaultEffort("opus", "   "), "high");
  });

  it("DEFAULT_EFFORT_BY_MODEL contains the expected entries", () => {
    for (const alias of ["fable", "opus", "sonnet", "haiku"]) {
      assert.equal(DEFAULT_EFFORT_BY_MODEL.get(alias), "high");
    }
    assert.equal(DEFAULT_EFFORT_BY_MODEL.size, 4);
  });
});

// ===========================================================================
// resolveEffort
// ===========================================================================

describe("resolveEffort", () => {
  it("maps 'none' to 'low'", () => {
    assert.equal(resolveEffort("none"), "low");
  });

  it("maps 'minimal' to 'low'", () => {
    assert.equal(resolveEffort("minimal"), "low");
  });

  it("maps 'low' to 'low'", () => {
    assert.equal(resolveEffort("low"), "low");
  });

  it("maps 'medium' to 'medium'", () => {
    assert.equal(resolveEffort("medium"), "medium");
  });

  it("maps 'high' to 'high'", () => {
    assert.equal(resolveEffort("high"), "high");
  });

  it("passes 'xhigh' through as a first-class effort", () => {
    assert.equal(resolveEffort("xhigh"), "xhigh");
  });

  it("maps 'max' to 'max'", () => {
    assert.equal(resolveEffort("max"), "max");
  });

  it("normalizes canonical effort values to lowercase", () => {
    assert.equal(resolveEffort("HIGH"), "high");
    assert.equal(resolveEffort("XHIGH"), "xhigh");
  });

  it("throws on unsupported effort values", () => {
    assert.throws(
      () => resolveEffort("ultra"),
      /Unsupported effort "ultra"/
    );
  });

  it("returns undefined for null/undefined input", () => {
    assert.equal(resolveEffort(null), undefined);
    assert.equal(resolveEffort(undefined), undefined);
  });

  it("VALID_EFFORTS contains low, medium, high, xhigh, max", () => {
    assert.ok(VALID_EFFORTS.has("low"));
    assert.ok(VALID_EFFORTS.has("medium"));
    assert.ok(VALID_EFFORTS.has("high"));
    assert.ok(VALID_EFFORTS.has("xhigh"));
    assert.ok(VALID_EFFORTS.has("max"));
    assert.equal(VALID_EFFORTS.size, 5);
  });

  it("EFFORT_ALIASES only contains legacy compatibility mappings", () => {
    assert.deepEqual(EFFORT_ALIASES, {
      none: "low",
      minimal: "low",
    });
  });
});

// ===========================================================================
// resolveClaudeBin
// ===========================================================================

describe("resolveClaudeBin", () => {
  it("prefers an explicit binary override", () => {
    assert.equal(
      resolveClaudeBin({
        env: { CC_PLUGIN_CODEX_CLAUDE_BIN: " C:\\custom\\claude.exe " },
        platform: "win32",
        homedir: "C:\\Users\\demo",
        existsSync: () => false,
      }),
      "C:\\custom\\claude.exe"
    );
  });

  it("finds the native package executable under a PATH npm prefix", () => {
    const expected =
      "D:\\tools\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    assert.equal(
      resolveClaudeBin({
        env: { PATH: "C:\\Windows;D:\\tools\\npm" },
        platform: "win32",
        homedir: "C:\\Users\\demo",
        existsSync: (candidate) => candidate === expected,
      }),
      expected
    );
  });

  it("finds a native Claude executable directly on PATH", () => {
    const expected = "D:\\tools\\claude.exe";
    assert.equal(
      resolveClaudeBin({
        env: { PATH: "C:\\Windows;D:\\tools" },
        platform: "win32",
        homedir: "C:\\Users\\demo",
        existsSync: (candidate) => candidate === expected,
      }),
      expected
    );
  });

  it("uses APPDATA when the npm prefix is not present in PATH", () => {
    const expected =
      "R:\\Profile\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    assert.equal(
      resolveClaudeBin({
        env: { APPDATA: "R:\\Profile" },
        platform: "win32",
        homedir: "C:\\Users\\demo",
        existsSync: (candidate) => candidate === expected,
      }),
      expected
    );
  });

  it("falls back to command lookup when no native executable is found", () => {
    assert.equal(
      resolveClaudeBin({
        env: {},
        platform: "win32",
        homedir: "C:\\Users\\demo",
        existsSync: () => false,
      }),
      "claude"
    );
  });

  it("deduplicates Windows search roots case-insensitively", () => {
    const checked = [];
    resolveClaudeBin({
      env: { PATH: "C:\\NPM;c:\\npm" },
      platform: "win32",
      homedir: "C:\\Users\\demo",
      existsSync: (candidate) => {
        checked.push(candidate);
        return false;
      },
    });
    assert.equal(checked.length, 4);
    assert.equal(
      checked[0].toLowerCase(),
      "c:\\npm\\claude.exe"
    );
  });
});

// ===========================================================================
// buildArgs
// ===========================================================================

describe("buildArgs", () => {
  it("always starts with -p", () => {
    const args = buildArgs("prompt");
    assert.equal(args[0], "-p");
  });

  it("keeps the prompt out of argv so it can be sent through stdin", () => {
    const prompt = "x".repeat(70_000);
    const args = buildArgs(prompt);
    assert.ok(!args.includes("--"));
    assert.ok(!args.includes(prompt));
  });

  it("defaults output format to json", () => {
    const args = buildArgs("p");
    const idx = args.indexOf("--output-format");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "json");
  });

  it("stream-json format includes verbose and include-partial-messages", () => {
    const args = buildArgs("p", { outputFormat: "stream-json" });
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--include-partial-messages"));
    const idx = args.indexOf("--output-format");
    assert.equal(args[idx + 1], "stream-json");
  });

  it("includes --no-session-persistence when set", () => {
    const args = buildArgs("p", { noSessionPersistence: true });
    assert.ok(args.includes("--no-session-persistence"));
  });

  it("does not include --no-session-persistence when not set", () => {
    const args = buildArgs("p", {});
    assert.ok(!args.includes("--no-session-persistence"));
  });

  it("includes the model alias unchanged", () => {
    const args = buildArgs("p", { model: "sonnet" });
    const idx = args.indexOf("--model");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "sonnet");
  });

  it("includes the native fable alias unchanged", () => {
    const args = buildArgs("p", { model: "fable" });
    const idx = args.indexOf("--model");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "fable");
  });

  it("includes --effort with resolved effort", () => {
    const args = buildArgs("p", { effort: "xhigh" });
    const idx = args.indexOf("--effort");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "xhigh");
  });

  it("passes 'max' through as --effort max when explicitly requested", () => {
    const args = buildArgs("p", { effort: "max" });
    const idx = args.indexOf("--effort");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "max");
  });

  it("includes --session-id when provided", () => {
    const args = buildArgs("p", { sessionId: "sid-123" });
    const idx = args.indexOf("--session-id");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "sid-123");
  });

  it("includes --resume when resumeSessionId is provided", () => {
    const args = buildArgs("p", { resumeSessionId: "rsid-456" });
    const idx = args.indexOf("--resume");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "rsid-456");
  });

  it("includes --allowedTools as separate flags per tool", () => {
    const tools = ["Read", "Glob", "Bash(git diff:*)"];
    const args = buildArgs("p", { allowedTools: tools });
    const toolArgs = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--allowedTools") toolArgs.push(args[i + 1]);
    }
    assert.deepEqual(toolArgs, tools);
  });

  it("includes --max-turns as string", () => {
    const args = buildArgs("p", { maxTurns: 5 });
    const idx = args.indexOf("--max-turns");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "5");
  });

  it("includes --json-schema as stringified JSON", () => {
    const schema = { type: "object", properties: { x: { type: "string" } } };
    const args = buildArgs("p", { jsonSchema: schema });
    const idx = args.indexOf("--json-schema");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], JSON.stringify(schema));
  });

  it("includes --system-prompt when provided", () => {
    const args = buildArgs("p", { systemPrompt: "Be helpful" });
    const idx = args.indexOf("--system-prompt");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "Be helpful");
  });

  it("includes --permission-mode when provided", () => {
    const args = buildArgs("p", { permissionMode: "dontAsk" });
    const idx = args.indexOf("--permission-mode");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "dontAsk");
  });

  it("includes --settings when settingsFile is provided", () => {
    const args = buildArgs("p", { settingsFile: "/tmp/s.json" });
    const idx = args.indexOf("--settings");
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], "/tmp/s.json");
  });
});

// ===========================================================================
// SANDBOX_READ_ONLY_TOOLS constant
// ===========================================================================

describe("SANDBOX_READ_ONLY_TOOLS", () => {
  it("contains Read", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("Read")));
  it("contains Glob", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("Glob")));
  it("contains Grep", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("Grep")));
  it("contains explicit read-only git Bash patterns", () => {
    for (const pattern of SANDBOX_READ_ONLY_BASH_TOOLS) {
      assert.ok(SANDBOX_READ_ONLY_TOOLS.includes(pattern));
    }
    assert.ok(!SANDBOX_READ_ONLY_TOOLS.includes("Bash(git:*)"));
  });
  it("contains WebSearch", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("WebSearch")));
  it("contains WebFetch", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("WebFetch")));
  it("contains Agent(explore,plan)", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.includes("Agent(explore,plan)")));
  it("has room for the explicit git allowlist", () => assert.ok(SANDBOX_READ_ONLY_TOOLS.length > 7));
  it("does not contain Write or Edit", () => {
    assert.ok(!SANDBOX_READ_ONLY_TOOLS.includes("Write"));
    assert.ok(!SANDBOX_READ_ONLY_TOOLS.includes("Edit"));
  });
});

// ===========================================================================
// SANDBOX_SETTINGS constant
// ===========================================================================

describe("SANDBOX_SETTINGS", () => {
  it("has read-only and workspace-write keys", () => {
    assert.ok("read-only" in SANDBOX_SETTINGS);
    assert.ok("workspace-write" in SANDBOX_SETTINGS);
  });

  it("read-only enables sandbox with allowWrite [SANDBOX_TEMP_DIR] and unrestricted network", () => {
    const s = SANDBOX_SETTINGS["read-only"].sandbox;
    assert.equal(s.enabled, true);
    assert.deepEqual(s.filesystem.allowWrite, [SANDBOX_TEMP_DIR]);
    // network is intentionally omitted so that WebFetch/WebSearch and Claude's
    // own API path remain reachable; review safety comes from removing Bash
    // from the allowlist instead.
    assert.equal(s.network, undefined);
  });

  it("workspace-write enables sandbox with allowWrite ['.', SANDBOX_TEMP_DIR]", () => {
    const s = SANDBOX_SETTINGS["workspace-write"].sandbox;
    assert.equal(s.enabled, true);
    assert.deepEqual(s.filesystem.allowWrite, [".", SANDBOX_TEMP_DIR]);
    assert.deepEqual(s.network.allowedDomains, []);
  });
});
