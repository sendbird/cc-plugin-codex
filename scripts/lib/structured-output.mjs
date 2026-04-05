/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
export function extractFirstJsonObject(text) {
  const source = String(text ?? "");
  for (
    let start = source.indexOf("{");
    start !== -1;
    start = source.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index++) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        depth += 1;
        continue;
      }

      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, index + 1);
          try {
            return { parsed: JSON.parse(candidate), jsonText: candidate };
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}

export function parseStructuredOutput(rawMessage, context = {}) {
  const text = String(rawMessage ?? "").trim();
  if (!text) {
    return {
      parsed: null,
      rawOutput: text,
      parseError: context.failureMessage || "No output from Claude Code.",
    };
  }

  try {
    const parsed = JSON.parse(text);
    return { parsed, rawOutput: text, parseError: null };
  } catch {
    const jsonMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return { parsed, rawOutput: text, parseError: null };
      } catch {
        // Fall through.
      }
    }

    const extracted = extractFirstJsonObject(text);
    if (extracted) {
      return { parsed: extracted.parsed, rawOutput: text, parseError: null };
    }
  }

  return {
    parsed: null,
    rawOutput: text,
    parseError: "Could not parse structured JSON output from Claude Code.",
  };
}
