/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateReviewResultShape,
  formatJobLine,
  escapeMarkdownCell,
  renderSetupReport,
  renderReviewResult,
  renderTaskResult,
  renderStatusReport,
  renderJobStatusReport,
  renderStoredJobResult,
  renderCancelReport,
} from "../scripts/lib/render.mjs";

// ---------------------------------------------------------------------------
// validateReviewResultShape
// ---------------------------------------------------------------------------

describe("validateReviewResultShape", () => {
  it("returns null for valid shape", () => {
    const data = {
      verdict: "approve",
      summary: "Looks good.",
      findings: [],
      next_steps: [],
    };
    assert.equal(validateReviewResultShape(data), null);
  });

  it("rejects null input", () => {
    assert.ok(validateReviewResultShape(null)?.includes("Expected"));
  });

  it("rejects array input", () => {
    assert.ok(validateReviewResultShape([])?.includes("Expected"));
  });

  it("rejects missing verdict", () => {
    const data = { summary: "ok", findings: [], next_steps: [] };
    assert.ok(validateReviewResultShape(data)?.includes("verdict"));
  });

  it("rejects empty verdict", () => {
    const data = { verdict: "  ", summary: "ok", findings: [], next_steps: [] };
    assert.ok(validateReviewResultShape(data)?.includes("verdict"));
  });

  it("rejects missing summary", () => {
    const data = { verdict: "ok", findings: [], next_steps: [] };
    assert.ok(validateReviewResultShape(data)?.includes("summary"));
  });

  it("rejects missing findings array", () => {
    const data = { verdict: "ok", summary: "ok", next_steps: [] };
    assert.ok(validateReviewResultShape(data)?.includes("findings"));
  });

  it("rejects non-array findings", () => {
    const data = { verdict: "ok", summary: "ok", findings: "not array", next_steps: [] };
    assert.ok(validateReviewResultShape(data)?.includes("findings"));
  });

  it("rejects missing next_steps", () => {
    const data = { verdict: "ok", summary: "ok", findings: [] };
    assert.ok(validateReviewResultShape(data)?.includes("next_steps"));
  });
});

// ---------------------------------------------------------------------------
// formatJobLine
// ---------------------------------------------------------------------------

describe("formatJobLine", () => {
  it("includes job id and status", () => {
    const line = formatJobLine({ id: "job-abc", status: "running" });
    assert.ok(line.includes("job-abc"));
    assert.ok(line.includes("running"));
  });

  it("includes kind label if present", () => {
    const line = formatJobLine({ id: "j1", status: "completed", kindLabel: "review" });
    assert.ok(line.includes("review"));
  });

  it("includes title if present", () => {
    const line = formatJobLine({ id: "j1", status: "running", title: "My task" });
    assert.ok(line.includes("My task"));
  });

  it("uses pipe separator", () => {
    const line = formatJobLine({ id: "j1", status: "ok" });
    assert.ok(line.includes(" | "));
  });

  it("defaults to 'unknown' for missing status", () => {
    const line = formatJobLine({ id: "j1" });
    assert.ok(line.includes("unknown"));
  });
});

// ---------------------------------------------------------------------------
// escapeMarkdownCell
// ---------------------------------------------------------------------------

describe("escapeMarkdownCell", () => {
  it("escapes pipe characters", () => {
    assert.equal(escapeMarkdownCell("a|b|c"), "a\\|b\\|c");
  });

  it("replaces newlines with spaces", () => {
    assert.equal(escapeMarkdownCell("line1\nline2\r\nline3"), "line1 line2 line3");
  });

  it("trims whitespace", () => {
    assert.equal(escapeMarkdownCell("  hello  "), "hello");
  });

  it("handles null/undefined as empty string", () => {
    assert.equal(escapeMarkdownCell(null), "");
    assert.equal(escapeMarkdownCell(undefined), "");
  });

  it("converts numbers to string", () => {
    assert.equal(escapeMarkdownCell(42), "42");
  });
});

// ---------------------------------------------------------------------------
// renderSetupReport
// ---------------------------------------------------------------------------

describe("renderSetupReport", () => {
  const baseReport = {
    ready: true,
    node: { detail: "v20.0.0" },
    claude: { detail: "installed" },
    auth: { detail: "authenticated" },
    hooks: { detail: "Codex hooks installed" },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: [],
  };

  it("renders ready status", () => {
    const output = renderSetupReport(baseReport);
    assert.ok(output.includes("Status: ready"));
    assert.ok(output.includes("# Claude Code Setup"));
  });

  it("renders not-ready status", () => {
    const output = renderSetupReport({ ...baseReport, ready: false });
    assert.ok(output.includes("Status: needs attention"));
  });

  it("includes check details", () => {
    const output = renderSetupReport(baseReport);
    assert.ok(output.includes("- node: v20.0.0"));
    assert.ok(output.includes("- auth: authenticated"));
    assert.ok(output.includes("- hooks: Codex hooks installed"));
  });

  it("shows review gate status", () => {
    const enabled = renderSetupReport({ ...baseReport, reviewGateEnabled: true });
    assert.ok(enabled.includes("review gate: enabled"));

    const disabled = renderSetupReport(baseReport);
    assert.ok(disabled.includes("review gate: disabled"));
  });

  it("includes actions taken", () => {
    const report = { ...baseReport, actionsTaken: ["Installed hooks"] };
    const output = renderSetupReport(report);
    assert.ok(output.includes("Actions taken:"));
    assert.ok(output.includes("- Installed hooks"));
  });

  it("includes next steps", () => {
    const report = { ...baseReport, nextSteps: ["Run claude auth"] };
    const output = renderSetupReport(report);
    assert.ok(output.includes("Next steps:"));
    assert.ok(output.includes("- Run claude auth"));
  });

  it("ends with newline", () => {
    const output = renderSetupReport(baseReport);
    assert.ok(output.endsWith("\n"));
  });
});

// ---------------------------------------------------------------------------
// renderReviewResult
// ---------------------------------------------------------------------------

describe("renderReviewResult", () => {
  const meta = {
    reviewLabel: "Review",
    targetLabel: "working tree diff",
    reasoningSummary: [],
  };

  it("renders structured review with findings", () => {
    const parsed = {
      parsed: {
        verdict: "approve",
        summary: "Clean code.",
        findings: [
          { severity: "low", title: "Minor style", body: "Use const.", file: "index.js", line_start: 10 },
        ],
        next_steps: ["Fix style"],
      },
    };
    const output = renderReviewResult(parsed, meta);
    assert.ok(output.includes("Verdict: approve"));
    assert.ok(output.includes("Clean code."));
    assert.ok(output.includes("[low] Minor style"));
    assert.ok(output.includes("index.js:10"));
    assert.ok(output.includes("Fix style"));
  });

  it("renders no-findings message", () => {
    const parsed = {
      parsed: {
        verdict: "approve",
        summary: "All good.",
        findings: [],
        next_steps: [],
      },
    };
    const output = renderReviewResult(parsed, meta);
    assert.ok(output.includes("No material findings."));
  });

  it("shows raw output when parsed is null but rawOutput exists", () => {
    const parsed = { parsed: null, rawOutput: "Claude said something", parseError: "not JSON" };
    const output = renderReviewResult(parsed, meta);
    assert.ok(output.includes("Claude said something"));
  });

  it("shows error when no parsed and no rawOutput", () => {
    const parsed = { parsed: null, rawOutput: null, parseError: "empty response" };
    const output = renderReviewResult(parsed, meta);
    assert.ok(output.includes("did not return output"));
    assert.ok(output.includes("empty response"));
  });

  it("handles validation errors in parsed data", () => {
    const parsed = { parsed: { verdict: "ok" } }; // missing summary, findings, next_steps
    const output = renderReviewResult(parsed, meta);
    assert.ok(output.includes("unexpected review shape"));
  });

  it("sorts findings by severity (critical first)", () => {
    const parsed = {
      parsed: {
        verdict: "reject",
        summary: "Issues found.",
        findings: [
          { severity: "low", title: "Style", body: "x", file: "a.js" },
          { severity: "critical", title: "Bug", body: "y", file: "b.js" },
          { severity: "high", title: "Perf", body: "z", file: "c.js" },
        ],
        next_steps: [],
      },
    };
    const output = renderReviewResult(parsed, meta);
    const critIdx = output.indexOf("[critical]");
    const highIdx = output.indexOf("[high]");
    const lowIdx = output.indexOf("[low]");
    assert.ok(critIdx < highIdx);
    assert.ok(highIdx < lowIdx);
  });

  it("formats line ranges correctly", () => {
    const parsed = {
      parsed: {
        verdict: "ok",
        summary: "Fine.",
        findings: [
          { severity: "low", title: "A", body: "b", file: "f.js", line_start: 5, line_end: 10 },
          { severity: "low", title: "B", body: "c", file: "g.js", line_start: 3, line_end: 3 },
          { severity: "low", title: "C", body: "d", file: "h.js" },
        ],
        next_steps: [],
      },
    };
    const output = renderReviewResult(parsed, meta);
    assert.ok(output.includes("f.js:5-10"));
    assert.ok(output.includes("g.js:3)"));
    assert.ok(output.includes("h.js)"));
  });
});

// ---------------------------------------------------------------------------
// renderTaskResult
// ---------------------------------------------------------------------------

describe("renderTaskResult", () => {
  it("returns rawOutput with trailing newline", () => {
    assert.equal(renderTaskResult({ rawOutput: "done" }), "done\n");
  });

  it("does not double newline", () => {
    assert.equal(renderTaskResult({ rawOutput: "done\n" }), "done\n");
  });

  it("returns failure message when no rawOutput", () => {
    const output = renderTaskResult({ failureMessage: "timeout" });
    assert.equal(output, "timeout\n");
  });

  it("returns default message when nothing provided", () => {
    const output = renderTaskResult({});
    assert.ok(output.includes("did not return a final message"));
  });

  it("handles null input", () => {
    const output = renderTaskResult(null);
    assert.ok(output.includes("did not return a final message"));
  });
});

// ---------------------------------------------------------------------------
// renderStatusReport
// ---------------------------------------------------------------------------

describe("renderStatusReport", () => {
  it("renders empty state", () => {
    const report = {
      config: { stopReviewGate: false },
      running: [],
      latestFinished: null,
      recent: [],
      needsReview: false,
    };
    const output = renderStatusReport(report);
    assert.equal(output, "No Claude Code jobs recorded yet.\n");
  });

  it("renders overview as a compact markdown table", () => {
    const report = {
      config: { stopReviewGate: false },
      running: [
        {
          id: "j1",
          status: "running",
          phase: "reviewing",
          kindLabel: "review",
          startedAt: "2026-04-02T19:00:00.000Z",
          elapsed: "2m 30s",
          updatedAt: "2026-04-02T19:02:30.000Z",
        },
      ],
      latestFinished: {
        id: "j2",
        status: "completed",
        phase: "done",
        kindLabel: "adversarial-review",
        startedAt: "2026-04-02T18:00:00.000Z",
        completedAt: "2026-04-02T18:01:00.000Z",
        duration: "1m",
        updatedAt: "2026-04-02T18:01:00.000Z",
      },
      recent: [
        {
          id: "j3",
          status: "completed",
          phase: "done",
          kindLabel: "rescue",
          startedAt: "2026-04-02T17:00:00.000Z",
          completedAt: "2026-04-02T17:03:00.000Z",
          duration: "3m",
          updatedAt: "2026-04-02T17:03:00.000Z",
        },
      ],
      needsReview: false,
    };
    const output = renderStatusReport(report);
    assert.ok(output.startsWith("| Job | Kind | Status | Phase | Started | Ended | Elapsed/Duration | Summary | Actions |"));
    assert.ok(output.includes("`$cc:status j1`"));
    assert.ok(output.includes("`$cc:cancel j1`"));
    assert.ok(output.includes("`$cc:result j2`"));
    assert.ok(output.includes("2026-04-02T19:00:00.000Z"));
    assert.ok(output.indexOf("j1") < output.indexOf("j2"));
    assert.ok(output.indexOf("j2") < output.indexOf("j3"));
  });

  it("limits the overview to the first 15 jobs after sorting", () => {
    const report = {
      config: { stopReviewGate: false },
      running: [],
      latestFinished: null,
      recent: Array.from({ length: 20 }, (_, i) => ({
        id: `j${i}`,
        status: "completed",
        phase: "done",
        kindLabel: "review",
        updatedAt: `2026-04-02T19:${String(59 - i).padStart(2, "0")}:00.000Z`,
        duration: "1m",
      })),
      needsReview: false,
    };
    const output = renderStatusReport(report);
    assert.ok(output.includes("j0"));
    assert.ok(output.includes("j14"));
    assert.ok(!output.includes("j15"));
  });

  it("deduplicates latestFinished from recent rows", () => {
    const report = {
      config: { stopReviewGate: false },
      running: [],
      latestFinished: {
        id: "j2",
        status: "completed",
        phase: "done",
        kindLabel: "review",
        updatedAt: "2026-04-02T18:01:00.000Z",
        duration: "1m",
      },
      recent: [
        {
          id: "j2",
          status: "completed",
          phase: "done",
          kindLabel: "review",
          updatedAt: "2026-04-02T18:01:00.000Z",
          duration: "1m",
        },
      ],
      needsReview: false,
    };
    const output = renderStatusReport(report);
    assert.equal(output.split("j2").length - 1, 3);
  });
});

// ---------------------------------------------------------------------------
// renderJobStatusReport
// ---------------------------------------------------------------------------

describe("renderJobStatusReport", () => {
  it("renders job status as a key-value markdown table with links", () => {
    const job = {
      id: "j1",
      status: "completed",
      phase: "done",
      kindLabel: "review",
      title: "Review",
      summary: "Looks fine",
      startedAt: "2026-04-02T19:00:00.000Z",
      completedAt: "2026-04-02T19:01:00.000Z",
      duration: "1m",
      sessionId: "owner-sess",
      threadId: "claude-sess",
    };
    const output = renderJobStatusReport(job);
    assert.ok(output.includes("# Claude Code Job Status"));
    assert.ok(output.includes("| Field | Value |"));
    assert.ok(output.includes("| Job | `j1` |"));
    assert.ok(output.includes("| Kind | review |"));
    assert.ok(output.includes("| Title | Review |"));
    assert.ok(output.includes("| Started | 2026-04-02T19:00:00.000Z |"));
    assert.ok(output.includes("| Ended | 2026-04-02T19:01:00.000Z |"));
    assert.ok(output.includes("| Duration | 1m |"));
    assert.ok(output.includes("| Result | `$cc:result j1` |"));
    assert.ok(output.includes("| Claude Code session | `claude-sess` |"));
    assert.ok(output.includes("| Owning Codex session | `owner-sess` |"));
    assert.ok(output.includes("| Resume | `claude --resume claude-sess` |"));
  });

  it("shows cancel action for active jobs", () => {
    const job = {
      id: "j2",
      status: "running",
      phase: "reviewing",
      kindLabel: "review",
      startedAt: "2026-04-02T19:00:00.000Z",
      elapsed: "5s",
    };
    const output = renderJobStatusReport(job);
    assert.ok(output.includes("| Elapsed | 5s |"));
    assert.ok(output.includes("| Cancel | `$cc:cancel j2` |"));
  });
});

// ---------------------------------------------------------------------------
// renderStoredJobResult
// ---------------------------------------------------------------------------

describe("renderStoredJobResult", () => {
  it("returns rendered content with session info", () => {
    const job = { id: "j1", sessionId: "owner-sess", threadId: "claude-sess" };
    const stored = {
      sessionId: "owner-sess",
      result: { result: {}, sessionId: "claude-sess" },
      rendered: "Review output here.",
    };
    const output = renderStoredJobResult(job, stored);
    assert.ok(output.includes("Review output here."));
    assert.ok(output.includes("Claude Code session: claude-sess"));
    assert.ok(output.includes("Owning Codex session: owner-sess"));
    assert.ok(output.includes("claude --resume claude-sess"));
  });

  it("does not treat the owning Codex session as a Claude resume target", () => {
    const job = { id: "j1", sessionId: "owner-sess" };
    const stored = {
      sessionId: "owner-sess",
      rendered: "Review output here.",
    };
    const output = renderStoredJobResult(job, stored);
    assert.ok(output.includes("Owning Codex session: owner-sess"));
    assert.ok(!output.includes("Claude Code session: owner-sess"));
    assert.ok(!output.includes("claude --resume owner-sess"));
  });

  it("returns rendered content for plain standard reviews", () => {
    const job = { id: "j1", status: "completed", title: "Claude Code Review" };
    const stored = {
      result: {
        review: "Review",
        codex: { stdout: "# Code Review\n\nLooks good." },
      },
      rendered: "# Claude Code Review\n\nTarget: working tree diff\n\nLooks good.\n",
    };
    const output = renderStoredJobResult(job, stored);
    assert.equal(output, "# Claude Code Review\n\nTarget: working tree diff\n\nLooks good.\n");
  });

  it("returns rawOutput if no rendered", () => {
    const job = { id: "j1", sessionId: "sess1" };
    const stored = { result: { rawOutput: "Task output." } };
    const output = renderStoredJobResult(job, stored);
    assert.ok(output.includes("Task output."));
  });

  it("returns codex stdout if rendered and rawOutput are absent", () => {
    const job = { id: "j1", status: "completed", title: "Claude Code Review" };
    const stored = { result: { codex: { stdout: "Review body." } } };
    const output = renderStoredJobResult(job, stored);
    assert.equal(output, "Review body.\n");
  });

  it("recovers a structured adversarial review from rawOutput with prose preamble", () => {
    const job = { id: "j1", status: "completed", title: "Claude Code Adversarial Review" };
    const stored = {
      result: {
        review: "Adversarial Review",
        target: { label: "working tree diff" },
        result: null,
        rawOutput:
          "Now I have all the evidence I need. Here is the review:\n\n{\"verdict\":\"needs-attention\",\"summary\":\"Ship should wait.\",\"findings\":[{\"severity\":\"high\",\"title\":\"Race\",\"body\":\"A race exists.\",\"file\":\"scripts/example.mjs\",\"line_start\":10,\"line_end\":12,\"confidence\":0.9,\"recommendation\":\"Serialize writes.\"}],\"next_steps\":[\"Fix the race\"]}",
        parseError: "Could not parse structured JSON output from Claude Code.",
      },
      rendered:
        "# Claude Code Adversarial Review\n\nTarget: working tree diff\n\nNow I have all the evidence I need. Here is the review:\n\n{\"verdict\":\"needs-attention\"}\n",
    };
    const output = renderStoredJobResult(job, stored);
    assert.ok(output.includes("Verdict: needs-attention"));
    assert.ok(output.includes("Ship should wait."));
    assert.ok(output.includes("[high] Race"));
    assert.ok(output.includes("Fix the race"));
    assert.ok(!output.includes("{\"verdict\":\"needs-attention\"}"));
  });

  it("returns fallback when no result available", () => {
    const job = { id: "j1", status: "failed", title: "My Job" };
    const stored = {};
    const output = renderStoredJobResult(job, stored);
    assert.ok(output.includes("No captured result"));
  });

  it("includes error message from job", () => {
    const job = { id: "j1", status: "failed", errorMessage: "Timeout" };
    const stored = {};
    const output = renderStoredJobResult(job, stored);
    assert.ok(output.includes("Timeout"));
  });
});

// ---------------------------------------------------------------------------
// renderCancelReport
// ---------------------------------------------------------------------------

describe("renderCancelReport", () => {
  it("renders basic cancel confirmation", () => {
    const output = renderCancelReport({ id: "j1" });
    assert.ok(output.includes("Cancelled j1"));
    assert.ok(output.includes("$cc:status"));
  });

  it("includes title and summary if present", () => {
    const output = renderCancelReport({ id: "j1", title: "Review", summary: "Code review" });
    assert.ok(output.includes("Title: Review"));
    assert.ok(output.includes("Summary: Code review"));
  });

  it("shows manual cleanup warning for cancel_failed", () => {
    const output = renderCancelReport({ id: "j1", status: "cancel_failed", pgid: 12345 });
    assert.ok(output.includes("Manual cleanup"));
    assert.ok(output.includes("kill -9 -12345"));
  });
});
