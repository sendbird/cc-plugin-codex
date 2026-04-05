/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadPromptTemplate, interpolateTemplate } from "../scripts/lib/prompts.mjs";

// ---------------------------------------------------------------------------
// interpolateTemplate
// ---------------------------------------------------------------------------

describe("interpolateTemplate", () => {
  const cases = [
    {
      name: "replaces known variables",
      template: "Hello {{NAME}}!",
      variables: { NAME: "World" },
      expected: "Hello World!",
    },
    {
      name: "replaces multiple variables",
      template: "{{A}} and {{B}}",
      variables: { A: "foo", B: "bar" },
      expected: "foo and bar",
    },
    {
      name: "replaces duplicate occurrences",
      template: "{{X}} {{X}}",
      variables: { X: "hi" },
      expected: "hi hi",
    },
    {
      name: "replaces unknown variables with empty string",
      template: "before {{MISSING}} after",
      variables: {},
      expected: "before  after",
    },
    {
      name: "leaves non-matching patterns untouched",
      template: "{{lowercase}} {NOT_MATCHED}",
      variables: {},
      expected: "{{lowercase}} {NOT_MATCHED}",
    },
    {
      name: "handles empty template",
      template: "",
      variables: {},
      expected: "",
    },
    {
      name: "handles template with no variables",
      template: "plain text",
      variables: { X: "unused" },
      expected: "plain text",
    },
    {
      name: "replaces with empty string value",
      template: "a{{B}}c",
      variables: { B: "" },
      expected: "ac",
    },
    {
      name: "handles underscores in variable names",
      template: "{{LONG_VAR_NAME}}",
      variables: { LONG_VAR_NAME: "value" },
      expected: "value",
    },
  ];

  for (const { name, template, variables, expected } of cases) {
    it(name, () => {
      assert.equal(interpolateTemplate(template, variables), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// loadPromptTemplate
// ---------------------------------------------------------------------------

describe("loadPromptTemplate", () => {
  let tmpRoot;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-test-"));
    fs.mkdirSync(path.join(tmpRoot, "prompts"));
  });

  afterEach(() => {
    for (const f of fs.readdirSync(path.join(tmpRoot, "prompts"))) {
      fs.unlinkSync(path.join(tmpRoot, "prompts", f));
    }
  });

  it("loads a prompt file by name", () => {
    fs.writeFileSync(path.join(tmpRoot, "prompts", "review.md"), "# Review\n{{DIFF}}", "utf8");
    const content = loadPromptTemplate(tmpRoot, "review");
    assert.equal(content, "# Review\n{{DIFF}}");
  });

  it("throws for non-existent prompt", () => {
    assert.throws(
      () => loadPromptTemplate(tmpRoot, "nonexistent"),
      (err) => err.code === "ENOENT"
    );
  });

  it("works with the actual project prompts directory", () => {
    const projectRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
    // Check if any prompt files exist
    const promptDir = path.join(projectRoot, "prompts");
    if (fs.existsSync(promptDir)) {
      const files = fs.readdirSync(promptDir).filter((f) => f.endsWith(".md"));
      if (files.length > 0) {
        const name = files[0].replace(".md", "");
        const content = loadPromptTemplate(projectRoot, name);
        assert.ok(typeof content === "string");
        assert.ok(content.length > 0);
      }
    }
  });

  it("keeps the stop-review-gate prompt aligned to Codex wording", () => {
    const projectRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
    const content = loadPromptTemplate(projectRoot, "stop-review-gate");
    assert.match(content, /previous Codex turn/);
    assert.match(content, /\{\{PREVIOUS_RESPONSE_BLOCK\}\}/);
    assert.match(content, /untrusted model output/i);
    assert.doesNotMatch(content, /previous Claude turn/);
    assert.doesNotMatch(content, /\{\{CLAUDE_RESPONSE_BLOCK\}\}/);
  });

  it("frames adversarial-review prompt inputs as untrusted data", () => {
    const projectRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
    const content = loadPromptTemplate(projectRoot, "adversarial-review");
    assert.match(content, /untrusted user input/i);
    assert.match(content, /untrusted repository data/i);
    assert.match(content, /<user_focus>/);
    assert.match(content, /<repository_context>/);
  });
});
