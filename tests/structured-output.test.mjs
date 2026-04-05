/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractFirstJsonObject,
  parseStructuredOutput,
} from "../scripts/lib/structured-output.mjs";

describe("extractFirstJsonObject", () => {
  it("extracts a JSON object after prose", () => {
    const extracted = extractFirstJsonObject(
      "Intro\n\n{\"ok\":true,\"nested\":{\"a\":1}}\n"
    );
    assert.deepEqual(extracted?.parsed, { ok: true, nested: { a: 1 } });
  });

  it("returns null when no JSON object exists", () => {
    assert.equal(extractFirstJsonObject("hello world"), null);
  });

  it("handles escaped braces inside strings", () => {
    const extracted = extractFirstJsonObject(
      'noise {"message":"brace: \\"{\\"","nested":{"ok":true}} tail'
    );
    assert.deepEqual(extracted?.parsed, {
      message: 'brace: "{"',
      nested: { ok: true },
    });
  });

  it("skips malformed objects and keeps searching", () => {
    const extracted = extractFirstJsonObject(
      'prefix {"bad": } middle {"ok":true}'
    );
    assert.deepEqual(extracted?.parsed, { ok: true });
  });
});

describe("parseStructuredOutput", () => {
  it("parses a full-document JSON object", () => {
    const parsed = parseStructuredOutput(
      "{\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]}"
    );
    assert.equal(parsed.parseError, null);
    assert.equal(parsed.parsed?.verdict, "approve");
  });

  it("parses a JSON object embedded after prose", () => {
    const parsed = parseStructuredOutput(
      "Now I have all the evidence.\n\n{\"verdict\":\"needs-attention\",\"summary\":\"risk\",\"findings\":[],\"next_steps\":[]}"
    );
    assert.equal(parsed.parseError, null);
    assert.equal(parsed.parsed?.verdict, "needs-attention");
  });

  it("parses fenced JSON blocks", () => {
    const parsed = parseStructuredOutput(
      "```json\n{\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]}\n```"
    );
    assert.equal(parsed.parseError, null);
    assert.equal(parsed.parsed?.summary, "ok");
  });

  it("returns a parse error for malformed structured output", () => {
    const parsed = parseStructuredOutput(
      "{\"verdict\":\"approve\",\"summary\":"
    );
    assert.equal(parsed.parsed, null);
    assert.match(
      parsed.parseError ?? "",
      /Could not parse structured JSON output/
    );
  });

  it("uses failureMessage context when output is empty", () => {
    const parsed = parseStructuredOutput("", {
      failureMessage: "Claude run failed upstream.",
    });
    assert.equal(parsed.parsed, null);
    assert.equal(parsed.parseError, "Claude run failed upstream.");
  });
});
