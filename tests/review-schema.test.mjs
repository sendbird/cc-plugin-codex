/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const POST_DRAFT_07_KEYWORD = /"(?:\$anchor|\$defs|\$dynamicAnchor|\$dynamicRef|\$recursiveAnchor|\$recursiveRef|contentSchema|dependentRequired|dependentSchemas|maxContains|minContains|prefixItems|unevaluatedItems|unevaluatedProperties)"\s*:/;
const schemaSource = fs.readFileSync(
  path.join(PROJECT_ROOT, "schemas", "review-output.schema.json"),
  "utf8"
);
const schema = JSON.parse(schemaSource);

describe("adversarial review output schema", () => {
  it("declares the Draft-07 dialect accepted by Claude Code", () => {
    assert.equal(
      schema.$schema,
      "http://json-schema.org/draft-07/schema#",
      "Claude Code 2.1.205+ rejects the Draft 2020-12 declaration before review execution; see #72"
    );
  });

  it("does not use schema keywords introduced after Draft-07", () => {
    assert.doesNotMatch(schemaSource, POST_DRAFT_07_KEYWORD);
  });
});
