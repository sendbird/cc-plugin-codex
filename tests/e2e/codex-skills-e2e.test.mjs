/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url))
);
const COMPANION_SCRIPT = path.join(PROJECT_ROOT, "scripts", "claude-companion.mjs");
const INSTALL_HOOKS_SCRIPT = path.join(PROJECT_ROOT, "scripts", "install-hooks.mjs");
const RESCUE_SKILL_PATH = path.join(PROJECT_ROOT, "skills", "rescue", "SKILL.md");
const REVIEW_SKILL_PATH = path.join(PROJECT_ROOT, "skills", "review", "SKILL.md");
const ADVERSARIAL_REVIEW_SKILL_PATH = path.join(
  PROJECT_ROOT,
  "skills",
  "adversarial-review",
  "SKILL.md"
);
const SETUP_SKILL_PATH = path.join(PROJECT_ROOT, "skills", "setup", "SKILL.md");

function codexAvailable() {
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function createFakeClaudeBinary(binDir, logFile) {
  const claudePath = path.join(binDir, "claude");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const logFile = process.env.FAKE_CLAUDE_LOG;

function getValue(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index === args.length - 1) {
    return null;
  }
  return args[index + 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (args[0] === "--version") {
    process.stdout.write("2.1.90 (Claude Code)\\n");
    return;
  }

  if (args[0] === "auth" && args[1] === "status") {
    process.stdout.write("authenticated\\n");
    return;
  }

  if (args[0] !== "-p") {
    process.stderr.write("unexpected arguments: " + JSON.stringify(args) + "\\n");
    process.exitCode = 2;
    return;
  }

  const promptIndex = args.lastIndexOf("--");
  const prompt = promptIndex >= 0 ? args.slice(promptIndex + 1).join(" ") : "";
  const delayMatch = prompt.match(/\\bdelay=(\\d+)\\b/);
  const delay = delayMatch ? Number(delayMatch[1]) : 25;
  const sessionId =
    getValue("--resume") ||
    getValue("--session-id") ||
    "stub-session";

  if (logFile) {
    fs.appendFileSync(
      logFile,
      JSON.stringify({ args, prompt, sessionId }) + "\\n",
      "utf8"
    );
  }

  const resultText = prompt.includes("multiline")
    ? ["completed:" + prompt, "Finding 1", "Finding 2", "Finding 3"].join("\\n")
    : "completed:" + prompt;

  process.stdout.write(
    JSON.stringify({
      type: "stream_event",
      session_id: sessionId,
      event: {
        delta: {
          type: "text_delta",
          text: resultText,
        },
      },
    }) + "\\n"
  );

  await sleep(delay);

  process.stdout.write(
    JSON.stringify({
      type: "result",
      session_id: sessionId,
      result: resultText,
    }) + "\\n"
  );
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + "\\n");
  process.exitCode = 1;
});
`;

  fs.writeFileSync(claudePath, source, "utf8");
  fs.chmodSync(claudePath, 0o755);
}

function createEnvironment() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rescue-e2e-"));
  const homeDir = path.join(rootDir, "home");
  const codexHome = path.join(homeDir, ".codex");
  const binDir = path.join(rootDir, "bin");
  const outputFile = path.join(rootDir, "last-message.txt");
  const claudeLogFile = path.join(rootDir, "fake-claude.ndjson");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  createFakeClaudeBinary(binDir, claudeLogFile);

  return {
    rootDir,
    homeDir,
    codexHome,
    outputFile,
    claudeLogFile,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: homeDir,
      USERPROFILE: homeDir,
      FAKE_CLAUDE_LOG: claudeLogFile,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  };
}

function installGlobalRescueAgent(testEnv) {
  const result = spawnSync(process.execPath, [INSTALL_HOOKS_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: testEnv.env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const agentFile = path.join(testEnv.codexHome, "agents", "cc-rescue.toml");
  const configFile = path.join(testEnv.codexHome, "config.toml");
  assert.ok(fs.existsSync(agentFile), "global cc-rescue agent file should be installed");
  assert.ok(fs.existsSync(configFile), "Codex config.toml should exist after install-hooks");
  const configText = fs.readFileSync(configFile, "utf8");
  assert.match(
    configText,
    /\[agents\."cc-rescue"\]/,
    "install-hooks should register cc-rescue in config.toml"
  );
  assert.match(
    configText,
    /config_file = "agents\/cc-rescue\.toml"/,
    "install-hooks should point the registered role at the global agent file"
  );
}

function writeConfigToml(testEnv, port) {
  const configFile = path.join(testEnv.codexHome, "config.toml");
  const existing = fs.existsSync(configFile)
    ? fs.readFileSync(configFile, "utf8").trim()
    : "";
  fs.writeFileSync(
    configFile,
    `model = "mock-model"
approval_policy = "never"
sandbox_mode = "workspace-write"
model_provider = "mock_provider"

${existing}

[model_providers.mock_provider]
name = "Mock provider"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
`,
    "utf8"
  );
  const merged = fs.readFileSync(configFile, "utf8");
  assert.match(
    merged,
    /\[agents\."cc-rescue"\]/,
    "mock provider config should preserve the cc-rescue registration"
  );
  assert.match(
    merged,
    /config_file = "agents\/cc-rescue\.toml"/,
    "mock provider config should preserve the cc-rescue config_file entry"
  );
}

function cleanupEnvironment(testEnv) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19 || !["ENOTEMPTY", "EBUSY"].includes(error?.code)) {
        throw error;
      }
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) {
        // brief sync backoff for detached process cleanup on macOS
      }
    }
  }
}

function buildRescuePrompt(userRequest) {
  const skillBody = fs.readFileSync(RESCUE_SKILL_PATH, "utf8").trim();
  return [
    "<skill>",
    "<name>cc:rescue</name>",
    `<path>${RESCUE_SKILL_PATH}</path>`,
    skillBody,
    "</skill>",
    "",
    userRequest,
  ].join("\n");
}

function buildSkillPrompt(name, skillPath, userRequest) {
  const skillBody = fs.readFileSync(skillPath, "utf8").trim();
  return [
    "<skill>",
    `<name>${name}</name>`,
    `<path>${skillPath}</path>`,
    skillBody,
    "</skill>",
    "",
    userRequest,
  ].join("\n");
}

function eventCreated(id) {
  return {
    type: "response.created",
    response: { id },
  };
}

function eventCompleted(id) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function eventAssistantMessage(id, text) {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id,
      content: [{ type: "output_text", text }],
    },
  };
}

function eventFunctionCall(callId, name, args) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function formatSse(events) {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function getToolNames(body) {
  return Array.isArray(body.tools)
    ? body.tools
        .map((tool) => tool.name || tool.function?.name || tool.type)
        .filter(Boolean)
    : [];
}

function getToolParameterDescription(body, toolName, parameterName) {
  return Array.isArray(body.tools)
    ? body.tools
        .find((tool) => (tool.name || tool.function?.name || tool.type) === toolName)
        ?.parameters?.properties?.[parameterName]?.description ?? null
    : null;
}

function extractRoleBlock(description, roleName) {
  if (!description) {
    return null;
  }

  const roleHeader = `${roleName}: {`;
  const lines = description.split("\n");
  const startIndex = lines.findIndex((line) => line === roleHeader);
  if (startIndex < 0) {
    return null;
  }

  const block = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > startIndex && line.endsWith(": {")) {
      break;
    }
    block.push(line);
  }
  return block.join("\n");
}

function chooseShellTool(body) {
  const toolNames = getToolNames(body);
  if (toolNames.includes("exec_command")) {
    return "exec_command";
  }
  if (toolNames.includes("shell_command")) {
    return "shell_command";
  }
  if (toolNames.includes("shell")) {
    return "shell";
  }
  throw new Error(`No supported shell tool found. Saw: ${toolNames.join(", ")}`);
}

function buildShellArgs(toolName, command, cwd = PROJECT_ROOT) {
  if (toolName === "exec_command") {
    return {
      cmd: command,
      workdir: cwd,
      yield_time_ms: 15000,
      max_output_tokens: 12000,
    };
  }

  if (toolName === "shell_command") {
    return {
      command,
      cwd,
      timeout_ms: 20000,
    };
  }

  return {
    command: ["bash", "-lc", command],
    timeout_ms: 20000,
  };
}

function extractOutputText(body, callId) {
  function extractText(value) {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = extractText(item);
        if (typeof text === "string" && text) {
          return text;
        }
      }
      return null;
    }
    if (!value || typeof value !== "object") {
      return null;
    }
    if (typeof value.text === "string" && value.text) {
      return value.text;
    }
    if (typeof value.content === "string" && value.content) {
      return value.content;
    }
    if (typeof value.stdout === "string" && value.stdout) {
      return value.stdout;
    }
    if (typeof value.rawOutput === "string" && value.rawOutput) {
      return value.rawOutput;
    }
    for (const key of ["content", "output", "result", "items"]) {
      const text = extractText(value[key]);
      if (typeof text === "string" && text) {
        return text;
      }
    }
    return null;
  }

  const input = Array.isArray(body.input) ? body.input : [];
  const item = input.find(
    (entry) =>
      (entry.type === "function_call_output" ||
        entry.type === "custom_tool_call_output") &&
      entry.call_id === callId
  );
  if (!item) {
    return null;
  }
  return extractText(item.output);
}

function extractAgentIdFromSpawnOutput(body, callId) {
  const outputText = extractOutputText(body, callId);
  if (!outputText) {
    return null;
  }
  try {
    const parsed = JSON.parse(outputText);
    return typeof parsed?.agent_id === "string" && parsed.agent_id
      ? parsed.agent_id
      : null;
  } catch {
    return null;
  }
}

function extractCompletedMessageFromWaitOutput(body, callId) {
  const outputText = extractOutputText(body, callId);
  if (!outputText) {
    return null;
  }
  try {
    const parsed = JSON.parse(outputText);
    const statuses = parsed?.status;
    if (!statuses || typeof statuses !== "object") {
      return null;
    }
    for (const value of Object.values(statuses)) {
      if (value && typeof value === "object") {
        if (typeof value.Completed === "string") {
          return value.Completed;
        }
        if (typeof value.completed === "string") {
          return value.completed;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function computeExpectedChildOutput(taskPrompt) {
  if (taskPrompt.includes("multiline")) {
    return [
      `completed:${taskPrompt}`,
      "Finding 1",
      "Finding 2",
      "Finding 3",
    ].join("\n");
  }
  return `completed:${taskPrompt}`;
}

function startDirectSkillProvider({
  userRequest,
  expectedNeedles = [],
  shellCommands,
  cwd = PROJECT_ROOT,
}) {
  const requests = [];
  const errors = [];
  const shellCallIdPrefix = "direct-shell";

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, body });

      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "mock-model", object: "model" },
              { id: "gpt-5.4-mini", object: "model" },
            ],
          })
        );
        return;
      }

      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      try {
        const responseIndex = requests.filter(
          (entry) => entry.method === "POST"
        ).length;
        const bodyText = JSON.stringify(body);
        let events;

        if (responseIndex === 1) {
          assert.ok(
            bodyText.includes(userRequest),
            "skill turn should receive the raw user request"
          );
          for (const needle of expectedNeedles) {
            assert.ok(bodyText.includes(needle), `skill turn should include ${needle}`);
          }
        }

        if (responseIndex <= shellCommands.length) {
          const shellTool = chooseShellTool(body);
          events = [
            eventCreated(`resp-direct-${responseIndex}`),
            eventFunctionCall(
              `${shellCallIdPrefix}-${responseIndex}`,
              shellTool,
              buildShellArgs(shellTool, shellCommands[responseIndex - 1], cwd)
            ),
            eventCompleted(`resp-direct-${responseIndex}`),
          ];
        } else if (responseIndex === shellCommands.length + 1) {
          const output = extractOutputText(
            body,
            `${shellCallIdPrefix}-${shellCommands.length}`
          );
          assert.ok(
            typeof output === "string" && output.trim(),
            "provider should receive shell output before the final assistant reply"
          );
          events = [
            eventCreated("resp-direct-final"),
            eventAssistantMessage("msg-direct-final", output.trimEnd()),
            eventCompleted("resp-direct-final"),
          ];
        } else {
          throw new Error(`Unexpected POST /v1/responses call #${responseIndex}`);
        }

        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(formatSse(events));
      } catch (error) {
        errors.push({
          method: req.method,
          url: req.url,
          message: error instanceof Error ? error.message : String(error),
          body,
        });
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.stack || error.message : String(error));
      }
    });
  });

  return {
    errors,
    requests,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function setupGitWorkspace(workspaceDir) {
  function run(args) {
    const result = spawnSync("git", args, {
      cwd: workspaceDir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  run(["init", "--initial-branch=main"]);
  run(["config", "user.name", "Codex Test"]);
  run(["config", "user.email", "codex@example.com"]);
  fs.writeFileSync(
    path.join(workspaceDir, "app.js"),
    "export function value() {\n  return 1;\n}\n",
    "utf8"
  );
  run(["add", "app.js"]);
  run(["commit", "-m", "initial"]);
}

function startMockProvider({ taskPrompt, userRequest }) {
  const requests = [];
  const errors = [];
  const spawnCallId = "spawn-1";
  const shellCallId = "shell-1";
  const waitCallId = "wait-1";
  const taskCommand =
    `node ${JSON.stringify(COMPANION_SCRIPT)} task --fresh ${JSON.stringify(taskPrompt)}`;
  let childRenderedOutput = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, body });

      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "mock-model", object: "model" },
              { id: "gpt-5.4-mini", object: "model" },
            ],
          })
        );
        return;
      }

      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      try {
        const responseIndex = requests.filter(
          (entry) => entry.method === "POST"
        ).length;
        const bodyText = JSON.stringify(body);
        let events;

        if (responseIndex === 1) {
          assert.ok(
            bodyText.includes("Claude Code Rescue"),
            "rescue skill should be injected into the parent turn"
          );
          assert.ok(
            bodyText.includes(userRequest),
            "raw user prompt should reach the parent turn"
          );
          assert.ok(
            getToolNames(body).includes("spawn_agent"),
            "spawn_agent should be available in the parent turn"
          );
          const agentTypeDescription = getToolParameterDescription(
            body,
            "spawn_agent",
            "agent_type"
          );
          const rescueRoleBlock = extractRoleBlock(agentTypeDescription, "cc-rescue");
          assert.ok(
            typeof rescueRoleBlock === "string" &&
              rescueRoleBlock.includes("cc-rescue: {") &&
              rescueRoleBlock.includes(
                "Forward substantial rescue tasks to Claude Code through the companion runtime."
              ),
            `parent turn should advertise the global cc-rescue role in the spawn_agent schema, saw: ${rescueRoleBlock}`
          );

          events = [
          eventCreated("resp-parent-1"),
          eventFunctionCall(spawnCallId, "spawn_agent", {
            agent_type: "cc-rescue",
            message:
              `Run exactly this command and return stdout unchanged:\n` +
              taskCommand,
            }),
            eventCompleted("resp-parent-1"),
          ];
        } else if (responseIndex === 2) {
          assert.ok(
            bodyText.includes("Run exactly this command and return stdout unchanged:"),
            "spawned child turn should receive the forwarded cc-rescue task message"
          );
          assert.ok(
            bodyText.includes(COMPANION_SCRIPT),
            "spawned child turn should receive the cc-rescue companion path"
          );
          assert.doesNotMatch(
            bodyText,
            /claude-companion\.mjs"\s+task\s+--background|claude-companion\.mjs"\s+task\s+--wait|claude-companion\.mjs\s+task\s+--background|claude-companion\.mjs\s+task\s+--wait/,
            "spawned child turn must not turn parent execution flags into companion task flags"
          );
          const shellTool = chooseShellTool(body);
          events = [
            eventCreated("resp-child-1"),
            eventFunctionCall(
              shellCallId,
              shellTool,
              buildShellArgs(shellTool, taskCommand)
            ),
            eventCompleted("resp-child-1"),
          ];
        } else if (responseIndex === 3) {
          childRenderedOutput = computeExpectedChildOutput(taskPrompt);
          events = [
            eventCreated("resp-child-2"),
            eventAssistantMessage("msg-child-2", childRenderedOutput.trimEnd()),
            eventCompleted("resp-child-2"),
          ];
        } else if (responseIndex === 4) {
          const toolNames = getToolNames(body);
          const hasNotification = bodyText.includes("<subagent_notification>");
          if (toolNames.includes("wait_agent") || toolNames.includes("wait")) {
            const agentId = extractAgentIdFromSpawnOutput(body, spawnCallId);
            assert.ok(
              agentId,
              "parent follow-up should receive the spawned agent id from spawn_agent"
            );
            events = [
              eventCreated("resp-parent-2"),
              eventFunctionCall(
                waitCallId,
                toolNames.includes("wait_agent") ? "wait_agent" : "wait",
                toolNames.includes("wait_agent")
                  ? { targets: [agentId], timeout_ms: 1000 }
                  : { ids: [agentId], timeout_ms: 1000 }
              ),
              eventCompleted("resp-parent-2"),
            ];
          } else if (hasNotification) {
            events = [
              eventCreated("resp-parent-2"),
              eventAssistantMessage("msg-parent-2", childRenderedOutput.trimEnd()),
              eventCompleted("resp-parent-2"),
            ];
          } else {
            throw new Error("parent follow-up should either expose a wait tool or include a subagent notification");
          }
        } else if (responseIndex === 5) {
          assert.ok(
            typeof childRenderedOutput === "string" && childRenderedOutput.trim(),
            "provider should have captured the child rendered output before the parent wait completes"
          );
          assert.ok(
            bodyText.includes("<subagent_notification>"),
            "parent post-wait turn should include the subagent completion notification"
          );
          const completedMessage = extractCompletedMessageFromWaitOutput(body, waitCallId);
          assert.ok(
            typeof completedMessage === "string" &&
              completedMessage.trim() === childRenderedOutput.trim(),
            "wait_agent output should expose the child final message"
          );
          events = [
            eventCreated("resp-parent-3"),
            eventAssistantMessage("msg-parent-3", childRenderedOutput.trimEnd()),
            eventCompleted("resp-parent-3"),
          ];
        } else {
          throw new Error(`Unexpected POST /v1/responses call #${responseIndex}`);
        }

        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(formatSse(events));
      } catch (error) {
        errors.push({
          method: req.method,
          url: req.url,
          message: error instanceof Error ? error.message : String(error),
          body,
        });
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.stack || error.message : String(error));
      }
    });
  });

  return {
    errors,
    requests,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function runCodexExec(testEnv, prompt, options = {}) {
  const cwd = options.cwd ?? PROJECT_ROOT;
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-m",
    "mock-model",
    "--enable",
    "multi_agent",
    "--dangerously-bypass-approvals-and-sandbox",
    "--color",
    "never",
    "-C",
    cwd,
    "-o",
    testEnv.outputFile,
    prompt,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      env: testEnv.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(`codex exec timed out\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
      );
    }, 60000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function readClaudeInvocations(logFile) {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs
    .readFileSync(logFile, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Codex rescue-skill E2E", () => {
  it("routes $cc:rescue through the global cc-rescue subagent, the companion task runtime, and the fake Claude CLI", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const taskPrompt = "codex-rescue-e2e foreground delay=10";
    const userRequest = "$cc:rescue --wait say hello from codex e2e";
    const provider = startMockProvider({
      taskPrompt,
      userRequest,
    });
    testEnv.providerPort = await provider.listen();
    installGlobalRescueAgent(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, buildRescuePrompt(userRequest));

      assert.equal(
        execResult.status,
        0,
        [
          "codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      assert.ok(
        fs.existsSync(testEnv.outputFile),
        [
          "expected codex exec to write the last message file",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, `completed:${taskPrompt}`);

      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.length >= 1,
        "fake Claude CLI should be invoked at least once"
      );
      assert.ok(
        claudeInvocations.some((entry) => entry.prompt === taskPrompt),
        `expected fake Claude invocation for prompt ${taskPrompt}`
      );

      const responsePosts = provider.requests.filter(
        (entry) => entry.method === "POST"
      );
      assert.ok(
        responsePosts.length === 4 || responsePosts.length === 5,
        `expected 4 or 5 response posts, saw ${responsePosts.length}`
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("defaults $cc:rescue without execution flags to the foreground companion path", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const taskPrompt = "codex-rescue-e2e default-foreground delay=10";
    const userRequest = "$cc:rescue say hello from codex e2e without flags";
    const provider = startMockProvider({
      taskPrompt,
      userRequest,
    });
    testEnv.providerPort = await provider.listen();
    installGlobalRescueAgent(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, buildRescuePrompt(userRequest));

      assert.equal(
        execResult.status,
        0,
        [
          "codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      assert.ok(
        fs.existsSync(testEnv.outputFile),
        [
          "expected codex exec to write the last message file",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, `completed:${taskPrompt}`);

      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some((entry) => entry.prompt === taskPrompt),
        `expected fake Claude invocation for prompt ${taskPrompt}`
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("passes through a multiline rescue result exactly in the foreground path", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const taskPrompt = "codex-rescue-e2e multiline delay=10";
    const userRequest = "$cc:rescue --wait /simplify";
    const provider = startMockProvider({
      taskPrompt,
      userRequest,
    });
    testEnv.providerPort = await provider.listen();
    installGlobalRescueAgent(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, buildRescuePrompt(userRequest));

      assert.equal(
        execResult.status,
        0,
        [
          "codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, computeExpectedChildOutput(taskPrompt));
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });
});

describe("Codex direct-skill E2E", () => {
  it("routes $cc:review --wait through the companion review command with forwarded scope and model", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "review-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 2;\n}\n",
      "utf8"
    );

    const userRequest = "$cc:review --wait --scope working-tree --model haiku";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: ["Claude Code Review"],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} review --view-state on-success --scope working-tree --model haiku`,
      ],
      cwd: workspaceDir,
    });
    testEnv.providerPort = await provider.listen();
    installGlobalRescueAgent(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt("cc:review", REVIEW_SKILL_PATH, userRequest),
        { cwd: workspaceDir }
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Claude Code Review/);
      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some((entry) => entry.args.includes("--model") && entry.args.includes("claude-haiku-4-5")),
        "review e2e should forward the requested model alias to Claude"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("routes $cc:adversarial-review --wait through the companion command with focus text", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "adversarial-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 3;\n}\n",
      "utf8"
    );

    const userRequest =
      "$cc:adversarial-review --wait --scope working-tree --model haiku focus on race conditions";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: ["Claude Code Adversarial Review"],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} adversarial-review --view-state on-success --scope working-tree --model haiku focus on race conditions`,
      ],
      cwd: workspaceDir,
    });
    testEnv.providerPort = await provider.listen();
    installGlobalRescueAgent(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt(
          "cc:adversarial-review",
          ADVERSARIAL_REVIEW_SKILL_PATH,
          userRequest
        ),
        { cwd: workspaceDir }
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Adversarial Review/);
      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some((entry) => entry.prompt.includes("focus on race conditions")),
        "adversarial review e2e should preserve the user focus text in the Claude prompt"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("routes $cc:setup --enable-review-gate through the json probe then final setup command", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const userRequest = "$cc:setup --enable-review-gate";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: ["Claude Code Setup"],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup --json --enable-review-gate`,
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup --enable-review-gate`,
      ],
    });
    testEnv.providerPort = await provider.listen();
    installGlobalRescueAgent(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt("cc:setup", SETUP_SKILL_PATH, userRequest)
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /review gate: enabled/i);
      assert.match(
        finalMessage,
        new RegExp(`Enabled the stop-time review gate for ${PROJECT_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });
});
