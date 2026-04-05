/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isProbablyText,
} from "../scripts/lib/fs.mjs";

// ---------------------------------------------------------------------------
// isProbablyText
// ---------------------------------------------------------------------------

describe("isProbablyText", () => {
  it("returns true for ASCII text", () => {
    const buf = Buffer.from("Hello, world!\nLine two.\n");
    assert.equal(isProbablyText(buf), true);
  });

  it("returns true for UTF-8 text", () => {
    const buf = Buffer.from("한글 텍스트 유니코드");
    assert.equal(isProbablyText(buf), true);
  });

  it("returns true for empty buffer", () => {
    assert.equal(isProbablyText(Buffer.alloc(0)), true);
  });

  it("returns false for buffer containing null bytes", () => {
    const buf = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]);
    assert.equal(isProbablyText(buf), false);
  });

  it("returns false for binary data", () => {
    // PNG header
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    assert.equal(isProbablyText(buf), false);
  });

  it("only checks first 4096 bytes", () => {
    // Text buffer larger than 4096 with null byte after 4096
    const textPart = Buffer.alloc(4097, 0x41); // 'A' * 4097
    textPart[4097 - 1] = 0; // null at position 4096 (beyond sample)
    // The function samples subarray(0, min(len, 4096)) = first 4096 bytes, all 'A'
    assert.equal(isProbablyText(textPart), true);
  });
});
