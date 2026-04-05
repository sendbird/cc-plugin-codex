/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Derived from OpenAI's codex-plugin-cc and modified for Claude Code delegation.
 *
 * Output rendering — adapted from codex-plugin-cc.
 * All "Codex" labels → "Claude Code".
 */

import path from "node:path";
import { parseStructuredOutput } from "./structured-output.mjs";

function severityRank(severity) {
  switch (severity) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    default: return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) return "";
  if (!finding.line_end || finding.line_end === finding.line_start) return `:${finding.line_start}`;
  return `:${finding.line_start}-${finding.line_end}`;
}

export function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Expected a top-level JSON object.";
  if (typeof data.verdict !== "string" || !data.verdict.trim()) return "Missing string `verdict`.";
  if (typeof data.summary !== "string" || !data.summary.trim()) return "Missing string `summary`.";
  if (!Array.isArray(data.findings)) return "Missing array `findings`.";
  if (!Array.isArray(data.next_steps)) return "Missing array `next_steps`.";
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd = Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart) ? source.line_end : lineStart;
  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : "",
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((f, i) => normalizeReviewFinding(f, i)),
    next_steps: data.next_steps.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()),
  };
}

function normalizeStoredOutput(output) {
  if (typeof output !== "string" || !output) return "";
  return output.endsWith("\n") ? output : `${output}\n`;
}

function getStoredJobOutput(storedJob) {
  if (typeof storedJob?.rendered === "string" && storedJob.rendered) {
    return storedJob.rendered;
  }
  if (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) {
    return storedJob.result.rawOutput;
  }
  if (typeof storedJob?.result?.codex?.stdout === "string" && storedJob.result.codex.stdout) {
    return storedJob.result.codex.stdout;
  }
  if (typeof storedJob?.result === "string" && storedJob.result) {
    return storedJob.result;
  }
  return "";
}

function recoverStructuredStoredReviewOutput(job, storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  if (!result.parseError || typeof result.rawOutput !== "string" || !result.rawOutput) {
    return "";
  }

  const recovered = parseStructuredOutput(result.rawOutput);
  if (!recovered.parsed) return "";

  return renderReviewResult(recovered, {
    reviewLabel: result.review ?? job.title?.replace(/^Claude Code /, "") ?? "Review",
    targetLabel: result.target?.label ?? "unknown target",
    reasoningSummary: null,
  });
}

export function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) parts.push(job.kindLabel);
  if (job.title) parts.push(job.title);
  return parts.join(" | ");
}

export function escapeMarkdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function formatClaudeResumeCommand(job) {
  if (!job?.sessionId) return null;
  return `claude --resume ${job.sessionId}`;
}

function formatClaudeSkillCommand(skill, jobId = null) {
  return jobId ? `$cc:${skill} ${jobId}` : `$cc:${skill}`;
}

function formatMarkdownLink(label, target) {
  return `[${label}](${target})`;
}

function formatLogFileLink(logFile) {
  if (!logFile) return null;
  return formatMarkdownLink(path.basename(logFile), logFile);
}

function formatJobTimestamp(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isPendingJob(job) {
  return job?.status === "queued" || job?.status === "running";
}

function collectStatusRows(report) {
  const rows = [
    ...(Array.isArray(report.running) ? report.running : []),
    report.latestFinished,
    ...(Array.isArray(report.recent) ? report.recent : []),
  ].filter(Boolean);

  const seen = new Set();
  return rows
    .filter((job) => {
      if (!job?.id || seen.has(job.id)) return false;
      seen.add(job.id);
      return true;
    })
    .sort((left, right) =>
      String(
        right.updatedAt ??
          right.completedAt ??
          right.startedAt ??
          right.createdAt ??
          ""
      ).localeCompare(
        String(
          left.updatedAt ??
            left.completedAt ??
            left.startedAt ??
            left.createdAt ??
            ""
        )
      )
    );
}

function formatStatusActions(job) {
  const actions = [`\`${formatClaudeSkillCommand("status", job.id)}\``];
  if (job.status === "queued" || job.status === "running") {
    actions.push(`\`${formatClaudeSkillCommand("cancel", job.id)}\``);
  } else {
    actions.push(`\`${formatClaudeSkillCommand("result", job.id)}\``);
  }
  return actions.join("<br>");
}

function formatStatusDuration(job) {
  return isPendingJob(job) ? job.elapsed ?? "" : job.duration ?? job.elapsed ?? "";
}

function renderStatusTable(rows) {
  const lines = [
    "| Job | Kind | Status | Phase | Started | Ended | Elapsed/Duration | Summary | Actions |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const job of rows) {
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(formatJobTimestamp(job.startedAt))} | ${escapeMarkdownCell(formatJobTimestamp(job.completedAt))} | ${escapeMarkdownCell(formatStatusDuration(job))} | ${escapeMarkdownCell(job.summary ?? "")} | ${formatStatusActions(job)} |`
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function pushJobField(lines, label, value) {
  if (value == null || value === "") return;
  lines.push(`${label}: ${value}`);
}

function pushKeyValueTableRow(lines, label, value, options = {}) {
  if (value == null || value === "") return;
  const renderedValue = options.raw ? String(value) : escapeMarkdownCell(value);
  lines.push(`| ${escapeMarkdownCell(label)} | ${renderedValue} |`);
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) return;
  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) lines.push(`- ${section}`);
}

export function renderSetupReport(report) {
  const lines = [
    "# Claude Code Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- claude: ${report.claude.detail}`,
    `- auth: ${report.auth.detail}`,
    `- hooks: ${report.hooks.detail}`,
    `- rescue agent: ${report.rescueAgent.detail}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    "",
  ];
  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) lines.push(`- ${action}`);
    lines.push("");
  }
  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) lines.push(`- ${step}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    if (parsedResult.rawOutput) {
      // Claude responded in natural language — show it directly instead of as an error
      const lines = [`# Claude Code ${meta.reviewLabel}`, "", `Target: ${meta.targetLabel}`, "", parsedResult.rawOutput];
      appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);
      return `${lines.join("\n").trimEnd()}\n`;
    }
    const lines = [`# Claude Code ${meta.reviewLabel}`, "", "Claude Code did not return output.", "", `- Error: ${parsedResult.parseError}`];
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [`# Claude Code ${meta.reviewLabel}`, "", `Target: ${meta.targetLabel}`, "Claude Code returned JSON with an unexpected review shape.", "", `- Validation error: ${validationError}`];
    if (parsedResult.rawOutput) lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const lines = [`# Claude Code ${meta.reviewLabel}`, "", `Target: ${meta.targetLabel}`, `Verdict: ${data.verdict}`, "", data.summary, ""];
  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const f of findings) {
      const ls = formatLineRange(f);
      lines.push(`- [${f.severity}] ${f.title} (${f.file}${ls})`);
      lines.push(`  ${f.body}`);
      if (f.recommendation) lines.push(`  Recommendation: ${f.recommendation}`);
    }
  }
  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) lines.push(`- ${step}`);
  }
  appendReasoningSection(lines, meta.reasoningSummary);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  const message = String(parsedResult?.failureMessage ?? "").trim() || "Claude Code did not return a final message.";
  return `${message}\n`;
}

export function renderStatusReport(report) {
  const rows = collectStatusRows(report).slice(0, 15);
  if (rows.length === 0) return "No Claude Code jobs recorded yet.\n";
  return renderStatusTable(rows);
}

export function renderJobStatusReport(job) {
  const lines = ["# Claude Code Job Status", "", "| Field | Value |", "| --- | --- |"];
  pushKeyValueTableRow(lines, "Job", `\`${job.id}\``, { raw: true });
  pushKeyValueTableRow(lines, "Kind", job.kindLabel ?? job.kind ?? "");
  pushKeyValueTableRow(lines, "Title", job.title ?? "");
  pushKeyValueTableRow(lines, "Status", job.status ?? "unknown");
  pushKeyValueTableRow(lines, "Phase", job.phase ?? "");
  pushKeyValueTableRow(lines, "Summary", job.summary ?? "");
  pushKeyValueTableRow(lines, "Started", job.startedAt ?? "");
  pushKeyValueTableRow(lines, "Ended", job.completedAt ?? "");
  if (isPendingJob(job)) pushKeyValueTableRow(lines, "Elapsed", job.elapsed ?? "");
  else pushKeyValueTableRow(lines, "Duration", job.duration ?? job.elapsed ?? "");
  if (job.sessionId) pushKeyValueTableRow(lines, "Claude Code session", `\`${job.sessionId}\``, { raw: true });
  const resumeCmd = formatClaudeResumeCommand(job);
  if (resumeCmd) pushKeyValueTableRow(lines, "Resume", `\`${resumeCmd}\``, { raw: true });
  const logLink = formatLogFileLink(job.logFile);
  if (logLink) pushKeyValueTableRow(lines, "Log", logLink, { raw: true });
  if (job.status === "queued" || job.status === "running") {
    pushKeyValueTableRow(lines, "Cancel", `\`${formatClaudeSkillCommand("cancel", job.id)}\``, { raw: true });
  } else {
    pushKeyValueTableRow(lines, "Result", `\`${formatClaudeSkillCommand("result", job.id)}\``, { raw: true });
  }
  if (job.status === "cancel_failed") {
    pushKeyValueTableRow(
      lines,
      "Manual cleanup",
      `\`kill -9 -${job.pgid ?? job.pid}\``,
      { raw: true }
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const sessionId = storedJob?.sessionId ?? job.sessionId ?? null;
  const resumeCmd = sessionId ? `claude --resume ${sessionId}` : null;
  const recoveredStructuredOutput = normalizeStoredOutput(
    recoverStructuredStoredReviewOutput(job, storedJob)
  );
  if (recoveredStructuredOutput) {
    if (!sessionId) return recoveredStructuredOutput;
    return `${recoveredStructuredOutput}\nClaude Code session: ${sessionId}\nResume: ${resumeCmd}\n`;
  }
  const storedOutput = normalizeStoredOutput(getStoredJobOutput(storedJob));
  if (storedOutput) {
    const output = storedOutput;
    if (!sessionId) return output;
    return `${output}\nClaude Code session: ${sessionId}\nResume: ${resumeCmd}\n`;
  }
  const lines = [`# ${job.title ?? "Claude Code Result"}`, "", `Job: ${job.id}`, `Status: ${job.status}`];
  if (sessionId) { lines.push(`Claude Code session: ${sessionId}`); lines.push(`Resume: ${resumeCmd}`); }
  if (job.summary) lines.push(`Summary: ${job.summary}`);
  if (job.errorMessage) lines.push("", job.errorMessage);
  else if (storedJob?.errorMessage) lines.push("", storedJob.errorMessage);
  else lines.push("", "No captured result payload was stored for this job.");
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# Claude Code Cancel", "", `Cancelled ${job.id}.`, ""];
  if (job.title) lines.push(`- Title: ${job.title}`);
  if (job.summary) lines.push(`- Summary: ${job.summary}`);
  if (job.status === "cancel_failed") lines.push(`- Warning: Process group may still be alive. Manual cleanup: kill -9 -${job.pgid ?? job.pid}`);
  lines.push("- Check `$cc:status` for the updated queue.");
  return `${lines.join("\n").trimEnd()}\n`;
}
