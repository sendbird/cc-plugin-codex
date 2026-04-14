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
const INSTALLER_SCRIPT = path.join(PROJECT_ROOT, "scripts", "installer-cli.mjs");
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

it("requires the codex CLI when E2E runs in CI", (t) => {
  if (codexAvailable()) {
    return;
  }

  if (process.env.CI) {
    assert.fail(
      "codex CLI is not available in this CI environment; full E2E coverage requires installing @openai/codex first"
    );
  }

  t.skip("codex CLI is not available in this environment");
});

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

function installHooks(testEnv) {
  const result = spawnSync(process.execPath, [INSTALL_HOOKS_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: testEnv.env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const hooksFile = path.join(testEnv.codexHome, "hooks.json");
  assert.ok(fs.existsSync(hooksFile), "Codex hooks should be installed");
}

function installPlugin(testEnv) {
  const result = spawnSync(process.execPath, [INSTALLER_SCRIPT, "install"], {
    cwd: PROJECT_ROOT,
    env: testEnv.env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const installDir = path.join(testEnv.codexHome, "plugins", "cc");
  const marketplaceFile = path.join(testEnv.homeDir, ".agents", "plugins", "marketplace.json");
  const configFile = path.join(testEnv.codexHome, "config.toml");

  assert.ok(
    fs.existsSync(path.join(installDir, "scripts", "installer-cli.mjs")),
    "installer should copy the plugin into the Codex home"
  );
  assert.ok(fs.existsSync(marketplaceFile), "installer should register the plugin in the local marketplace");
  assert.ok(fs.existsSync(configFile), "installer should create a Codex config.toml");
}

function installPluginWithEnv(testEnv, extraEnv = {}) {
  const result = spawnSync(process.execPath, [INSTALLER_SCRIPT, "install"], {
    cwd: PROJECT_ROOT,
    env: {
      ...testEnv.env,
      ...extraEnv,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function createMethodNotFoundCodex(testEnv) {
  const scriptPath = path.join(testEnv.rootDir, "fake-codex-app-server-method-not-found.mjs");
  const logPath = path.join(testEnv.codexHome, "fake-codex-requests.log");

  fs.writeFileSync(
    scriptPath,
    String.raw`import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [, , logPath] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n", "utf8");

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\n"
  );
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([scriptPath, logPath]),
    },
    logPath,
  };
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

function buildMultiSkillPrompt(skills, userRequest) {
  return [
    ...skills.flatMap(({ name, path: skillPath }) => {
      const skillBody = fs.readFileSync(skillPath, "utf8").trim();
      return [
        "<skill>",
        `<name>${name}</name>`,
        `<path>${skillPath}</path>`,
        skillBody,
        "</skill>",
        "",
      ];
    }),
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
              { id: "gpt-5.3-codex", object: "model" },
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

function startMockProvider({
  taskPrompt,
  userRequest,
  mode = "builtin-default",
  skillTitle = "Claude Code Rescue",
  expectedParentNeedles = [],
  taskCommand: taskCommandOverride = null,
  expectedChildNeedles = [],
  expectedFinalOutput = null,
  notificationMessage = null,
  spawnMessage = null,
  childPromptChecks = "rescue",
}) {
  const requests = [];
  const errors = [];
  const phases = [];
  const spawnCallId = "spawn-1";
  const shellCallId = "shell-1";
  const waitCallId = "wait-1";
  const taskCommand =
    taskCommandOverride ??
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
              { id: "gpt-5.4", object: "model" },
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
          phases.push("parent-init");
          const serializedUserRequest = JSON.stringify(userRequest).slice(1, -1);
          assert.ok(
            bodyText.includes(skillTitle),
            `${skillTitle} skill should be injected into the parent turn`
          );
          assert.ok(
            bodyText.includes(userRequest) || bodyText.includes(serializedUserRequest),
            "raw user prompt should reach the parent turn"
          );
          for (const needle of expectedParentNeedles) {
            assert.ok(
              bodyText.includes(needle),
              `parent turn should include ${needle}`
            );
          }
          assert.ok(
            getToolNames(body).includes("spawn_agent"),
            "spawn_agent should be available in the parent turn"
          );
          const agentTypeDescription = getToolParameterDescription(body, "spawn_agent", "agent_type");
          if (mode === "builtin-alias") {
            assert.ok(
              bodyText.includes("--builtin-agent"),
              "legacy built-in rescue alias should preserve the routing flag in the parent turn"
            );
          }
          const defaultRoleBlock = extractRoleBlock(agentTypeDescription, "default");
          assert.ok(
            typeof defaultRoleBlock === "string" && defaultRoleBlock.includes("Default agent."),
            `parent turn should advertise the built-in default role in the spawn_agent schema, saw: ${defaultRoleBlock}`
          );
          assert.ok(
            bodyText.includes("retry once with") && bodyText.includes("gpt-5.4"),
            "parent turn should include the narrow gpt-5.4 fallback guidance for mini-unavailable errors"
          );
          assert.ok(
            bodyText.includes("Do not use that fallback for arbitrary failures"),
            "parent turn should forbid broad fallback on generic spawn failures"
          );

          const spawnArgs = {
            agent_type: "default",
            model: "gpt-5.4-mini",
            reasoning_effort: "medium",
            message:
              spawnMessage ??
              "You are a transient forwarding worker for Claude Code rescue.\n" +
              "Run exactly one shell command.\n" +
              "Return only that command's stdout text exactly.\n" +
              "Ignore stderr progress chatter such as [cc] lines.\n" +
              "If the tool output includes both stderr progress and a final stdout-style result, preserve only the final stdout-equivalent result text.\n" +
              "Do not trim, normalize, add punctuation, or add commentary.\n" +
              "Do not drop prefixes like completed: or strip a leading slash command.\n" +
              "Do not inspect the repository, read files, grep, or do the task directly.\n" +
              "Do not reinterpret routing flags that were already resolved by the parent.\n" +
              "If the companion reports missing setup or auth, return that output unchanged.\n" +
              "Copy the resolved rescue task text byte-for-byte into the exact command below.\n" +
              "Example exact output: completed:/simplify make the output compact\n\n" +
              taskCommand,
          };
          events = [
            eventCreated("resp-parent-1"),
            eventFunctionCall(spawnCallId, "spawn_agent", spawnArgs),
            eventCompleted("resp-parent-1"),
          ];
        } else if (responseIndex === 2) {
          phases.push("child-shell");
          assert.ok(
            bodyText.includes(COMPANION_SCRIPT),
            "spawned child turn should receive the companion path"
          );
          if (childPromptChecks === "rescue") {
            assert.ok(
              bodyText.includes("Run exactly one shell command") ||
                bodyText.includes("Run exactly this command and return stdout unchanged"),
              "spawned child turn should receive the forwarding contract"
            );
            assert.ok(
              bodyText.includes("transient forwarding worker for Claude Code rescue"),
              "built-in child should receive the stricter forwarding contract"
            );
            assert.ok(
              bodyText.includes("Return only that command's stdout text exactly"),
              "built-in child should be told to preserve stdout exactly"
            );
            assert.ok(
              bodyText.includes("Ignore stderr progress chatter such as [cc] lines."),
              "built-in child should be told to ignore stderr progress chatter"
            );
            assert.ok(
              bodyText.includes("preserve only the final stdout-equivalent result text"),
              "built-in child should be told to prefer the final stdout-equivalent result over stderr chatter"
            );
            assert.ok(
              bodyText.includes("Do not drop prefixes like completed:"),
              "built-in child should be told not to strip completed: prefixes"
            );
            assert.ok(
              bodyText.includes("Do not trim, normalize, add punctuation, or add commentary."),
              "built-in child should be told not to rewrite stdout"
            );
            assert.ok(
              bodyText.includes("Copy the resolved rescue task text byte-for-byte"),
              "built-in child should be told to preserve the exact task text in the command"
            );
          }
          assert.doesNotMatch(
            bodyText,
            /claude-companion\.mjs"\s+task\s+--background|claude-companion\.mjs"\s+task\s+--wait|claude-companion\.mjs\s+task\s+--background|claude-companion\.mjs\s+task\s+--wait/,
            "spawned child turn must not turn parent execution flags into companion task flags"
          );
          for (const needle of expectedChildNeedles) {
            assert.ok(
              bodyText.includes(needle),
              `spawned child turn should include ${needle}`
            );
          }
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
          phases.push("child-final");
          childRenderedOutput =
            notificationMessage ??
            expectedFinalOutput ??
            computeExpectedChildOutput(taskPrompt);
          events = [
            eventCreated("resp-child-2"),
            eventAssistantMessage("msg-child-2", childRenderedOutput.trimEnd()),
            eventCompleted("resp-child-2"),
          ];
        } else if (responseIndex === 4) {
          const toolNames = getToolNames(body);
          const hasNotification = bodyText.includes("<subagent_notification>");
          if (toolNames.includes("wait_agent") || toolNames.includes("wait")) {
            phases.push("parent-wait");
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
            phases.push("parent-notification");
            if (notificationMessage) {
              assert.ok(
                bodyText.includes(notificationMessage),
                "parent notification follow-up should carry the steering message, not the raw child result"
              );
            }
            events = [
              eventCreated("resp-parent-2"),
              eventAssistantMessage(
                "msg-parent-2",
                (notificationMessage ?? childRenderedOutput).trimEnd()
              ),
              eventCompleted("resp-parent-2"),
            ];
          } else {
            throw new Error("parent follow-up should either expose a wait tool or include a subagent notification");
          }
        } else if (responseIndex === 5) {
          phases.push("parent-final");
          assert.ok(
            typeof childRenderedOutput === "string" && childRenderedOutput.trim(),
            "provider should have captured the child rendered output before the parent wait completes"
          );
          assert.ok(
            bodyText.includes("<subagent_notification>"),
            "parent post-wait turn should include the subagent completion notification"
          );
          const completedMessage = extractCompletedMessageFromWaitOutput(body, waitCallId);
          const expectedCompletedMessage = (
            notificationMessage ?? childRenderedOutput
          ).trim();
          assert.ok(
            typeof completedMessage === "string" &&
              completedMessage.trim() === expectedCompletedMessage,
            "wait_agent output should expose the expected completion message"
          );
          events = [
            eventCreated("resp-parent-3"),
            eventAssistantMessage(
              "msg-parent-3",
              (notificationMessage ?? childRenderedOutput).trimEnd()
            ),
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
    phases,
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
  it("routes $cc:rescue through the built-in rescue subagent, the companion task runtime, and the fake Claude CLI", async (t) => {
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
      mode: "builtin-default",
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
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

      const acceptedPhaseSequences = [
        ["parent-init", "child-shell", "child-final"],
        ["parent-init", "child-shell", "child-final", "parent-wait", "parent-final"],
      ];
      assert.ok(
        acceptedPhaseSequences.some(
          (sequence) => JSON.stringify(sequence) === JSON.stringify(provider.phases)
        ),
        `expected the built-in rescue wait flow to use either the direct child-completion path or the explicit wait-follow-up path, saw ${JSON.stringify(provider.phases)}`
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
      mode: "builtin-default",
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
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

  it("keeps background rescue completion as a steering message instead of inlining the raw result", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const reservedJobId = "task-background-steer-123";
    const taskPrompt = "codex-rescue-e2e background-notify delay=10";
    const userRequest = "$cc:rescue --background say hello from codex e2e in background";
    const notificationMessage = `Background Claude Code rescue finished. Open it with $cc:result ${reservedJobId}.`;
    const provider = startMockProvider({
      taskPrompt,
      userRequest,
      mode: "builtin-default",
      taskCommand:
        `node ${JSON.stringify(COMPANION_SCRIPT)} task --fresh --job-id ${JSON.stringify(reservedJobId)} --view-state defer ${JSON.stringify(taskPrompt)}`,
      expectedChildNeedles: ["--view-state defer", "--job-id", reservedJobId],
      notificationMessage,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, buildRescuePrompt(userRequest));

      assert.equal(
        execResult.status,
        0,
        [
          "background rescue codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, notificationMessage);
      assert.notEqual(finalMessage, `completed:${taskPrompt}`);
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
      mode: "builtin-default",
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
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

  it("accepts the legacy --builtin-agent alias without any extra rescue-agent install path", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const taskPrompt = "codex-rescue-e2e builtin-agent delay=10";
    const userRequest = "$cc:rescue --builtin-agent --wait say hello from codex e2e";
    const provider = startMockProvider({
      taskPrompt,
      userRequest,
      mode: "builtin-alias",
    });
    testEnv.providerPort = await provider.listen();
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

  it("can resume a built-in rescue run with a delta follow-up", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const initialTaskPrompt = "codex-rescue-e2e builtin-agent initial delay=10";
    const initialRequest = "$cc:rescue --builtin-agent --wait say hello from codex e2e";
    let provider = startMockProvider({
      taskPrompt: initialTaskPrompt,
      userRequest: initialRequest,
      mode: "builtin-alias",
    });
    testEnv.providerPort = await provider.listen();
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const initialResult = await runCodexExec(
        testEnv,
        buildRescuePrompt(initialRequest)
      );
      assert.equal(
        initialResult.status,
        0,
        [
          "initial built-in rescue failed",
          `stdout:\n${initialResult.stdout}`,
          `stderr:\n${initialResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const firstFinalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(firstFinalMessage, `completed:${initialTaskPrompt}`);
    } finally {
      await provider.close();
    }

    const followupTaskPrompt = "only fix the quoting issue and keep everything else";
    const followupRequest =
      "$cc:rescue --builtin-agent --wait --resume only fix the quoting issue and keep everything else";
    provider = startMockProvider({
      taskPrompt: followupTaskPrompt,
      userRequest: followupRequest,
      mode: "builtin-alias",
      taskCommand:
        `node ${JSON.stringify(COMPANION_SCRIPT)} task --resume ${JSON.stringify(followupTaskPrompt)}`,
      expectedChildNeedles: ["task --resume"],
    });
    testEnv.providerPort = await provider.listen();
    fs.rmSync(path.join(testEnv.codexHome, "config.toml"), { force: true });
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const followupResult = await runCodexExec(
        testEnv,
        buildRescuePrompt(followupRequest)
      );

      assert.equal(
        followupResult.status,
        0,
        [
          "resume built-in rescue failed",
          `stdout:\n${followupResult.stdout}`,
          `stderr:\n${followupResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, `completed:${followupTaskPrompt}`);

      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some(
          (entry) =>
            entry.prompt === followupTaskPrompt && entry.sessionId === "stub-session"
        ),
        "expected follow-up built-in rescue to resume the stub Claude session with the delta prompt"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  for (const scenario of [
    {
      name: "a slash-style rescue request",
      taskPrompt: "/simplify make the output compact",
      userRequest: "$cc:rescue --builtin-agent --wait /simplify make the output compact",
    },
    {
      name: "a quoted literal rescue request",
      taskPrompt: "return exactly 'foo \"bar\" baz'",
      userRequest: "$cc:rescue --builtin-agent --wait return exactly 'foo \"bar\" baz'",
    },
    {
      name: "a multiline rescue request",
      taskPrompt: "output exactly:\nline 1\n\nline 2\nline 3",
      userRequest:
        "$cc:rescue --builtin-agent --wait output exactly:\nline 1\n\nline 2\nline 3",
    },
    {
      name: "a mixed-language rescue request",
      taskPrompt: "한국어 2줄 + English 1 line 형식으로 답해줘",
      userRequest:
        "$cc:rescue --builtin-agent --wait 한국어 2줄 + English 1 line 형식으로 답해줘",
    },
    {
      name: "a follow-up style rescue request",
      taskPrompt: "keep going from the last fix and make it clean",
      userRequest:
        "$cc:rescue --builtin-agent --wait keep going from the last fix and make it clean",
    },
    {
      name: "an ambiguous rescue request",
      taskPrompt: "take care of the thing from earlier",
      userRequest:
        "$cc:rescue --builtin-agent --wait take care of the thing from earlier",
    },
  ]) {
    it(`preserves ${scenario.name} through the experimental built-in path`, async (t) => {
      if (!codexAvailable()) {
        t.skip("codex CLI is not available in this environment");
        return;
      }

      const testEnv = createEnvironment();
      const provider = startMockProvider({
        taskPrompt: scenario.taskPrompt,
        userRequest: scenario.userRequest,
        mode: "builtin-alias",
      });
      testEnv.providerPort = await provider.listen();
      writeConfigToml(testEnv, testEnv.providerPort);

      try {
        const execResult = await runCodexExec(
          testEnv,
          buildRescuePrompt(scenario.userRequest)
        );

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
        assert.equal(finalMessage, `completed:${scenario.taskPrompt}`);

        const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
        if (scenario.taskPrompt.includes("\n")) {
          assert.ok(
            claudeInvocations.length >= 1,
            "expected at least one fake Claude invocation for multiline prompt coverage"
          );
        } else {
          assert.ok(
            claudeInvocations.some((entry) => entry.prompt === scenario.taskPrompt),
            `expected fake Claude invocation for prompt ${JSON.stringify(scenario.taskPrompt)}`
          );
        }
      } finally {
        await provider.close();
        cleanupEnvironment(testEnv);
      }
    });
  }
});

describe("Codex direct-skill E2E", () => {
  it("uses fallback-installed cc-review wrappers when plugin/install is unavailable", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "fallback-review-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 5;\n}\n",
      "utf8"
    );

    const fallbackCodex = createMethodNotFoundCodex(testEnv);
    installPluginWithEnv(testEnv, fallbackCodex.env);
    assert.ok(
      fs.existsSync(path.join(testEnv.codexHome, "skills", "cc-review", "SKILL.md")),
      "fallback install should create a Codex-native cc-review wrapper"
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
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, userRequest, { cwd: workspaceDir });

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Claude Code Review/);
      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some(
          (entry) => entry.args.includes("--model") && entry.args.includes("claude-haiku-4-5")
        ),
        "fallback-installed wrapper should still route the requested model alias to Claude"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("uses the installed plugin review skill without running $cc:setup first", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "installed-review-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 4;\n}\n",
      "utf8"
    );

    installPlugin(testEnv);

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
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, userRequest, { cwd: workspaceDir });

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Claude Code Review/);

      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some(
          (entry) => entry.args.includes("--model") && entry.args.includes("claude-haiku-4-5")
        ),
        "installed plugin review should forward the requested model alias to Claude without running setup first"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

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
    installHooks(testEnv);
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

  it("routes $cc:review --background through the built-in path with notification steering", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "review-background-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 5;\n}\n",
      "utf8"
    );

    const reservedJobId = "review-background-steer-123";
    const ownerSessionId = "parent-review-session";
    const userRequest = "$cc:review --background --scope working-tree --model haiku";
    const notificationMessage =
      `Background Claude Code review finished. Open it with $cc:result ${reservedJobId}.`;
    const provider = startMockProvider({
      taskPrompt: "background review raw output should not surface",
      userRequest,
      skillTitle: "Claude Code Review",
      expectedParentNeedles: [
        "background-routing-context --kind review --json",
        "--owner-session-id <owner-session-id>",
        "Never satisfy background review by running the companion command itself with shell backgrounding",
        "allow one extra `send_input` call after a successful shell result",
        "must target the provided parent thread id",
        "do not silently drop the completion notification path from the child prompt",
        "Background Claude Code review finished. Open it with $cc:result <reserved-job-id>.",
      ],
      taskCommand:
        `node ${JSON.stringify(COMPANION_SCRIPT)} review --view-state defer --scope working-tree --model haiku --job-id ${JSON.stringify(reservedJobId)} --owner-session-id ${JSON.stringify(ownerSessionId)}`,
      expectedChildNeedles: [
        "--view-state defer",
        "--job-id",
        reservedJobId,
        "--owner-session-id",
        ownerSessionId,
        "send_input",
        notificationMessage,
      ],
      notificationMessage,
      childPromptChecks: "generic",
      spawnMessage:
        "You are a pure forwarder for a background Claude Code review job.\n" +
        "Do not inspect the repo, do not review anything yourself, and do not add commentary.\n" +
        "Run exactly one shell command and capture only the stdout-equivalent final result text from that command, ignoring stderr progress chatter like [cc] lines.\n" +
        "If the command succeeds and a parent thread id is available, send exactly this notification to the parent thread before finishing: " +
        JSON.stringify(notificationMessage) + "\n" +
        "Use that same sentence as your own final assistant message.\n" +
        "If the command fails, return only the command stdout if any, otherwise a terse failure note.\n\n" +
        `node ${JSON.stringify(COMPANION_SCRIPT)} review --view-state defer --scope working-tree --model haiku --job-id ${JSON.stringify(reservedJobId)} --owner-session-id ${JSON.stringify(ownerSessionId)}`,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt("cc:review", REVIEW_SKILL_PATH, userRequest),
        { cwd: workspaceDir }
      );

      assert.equal(
        execResult.status,
        0,
        [
          "background review codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, notificationMessage);
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
    installHooks(testEnv);
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

  it("injects review-versus-adversarial focus routing guidance when both skills are available", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "focus-routing-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 7;\n}\n",
      "utf8"
    );

    const userRequest =
      "$cc:review --wait --scope working-tree --model haiku focus on race conditions";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: [
        "`$cc:review` does not accept custom focus text",
        "Unlike `$cc:review`, this skill accepts custom focus text after the flags",
        "keep the delegated Claude part on `$cc:review`",
      ],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} adversarial-review --view-state on-success --scope working-tree --model haiku focus on race conditions`,
      ],
      cwd: workspaceDir,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildMultiSkillPrompt(
          [
            { name: "cc:review", path: REVIEW_SKILL_PATH },
            { name: "cc:adversarial-review", path: ADVERSARIAL_REVIEW_SKILL_PATH },
          ],
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
        "focus-routing e2e should preserve the user focus text when the adversarial path is selected"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("routes $cc:adversarial-review --background through the built-in path with notification steering", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "adversarial-background-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 6;\n}\n",
      "utf8"
    );

    const reservedJobId = "adversarial-background-steer-123";
    const ownerSessionId = "parent-adversarial-session";
    const userRequest =
      "$cc:adversarial-review --background --scope working-tree --model haiku focus on race conditions";
    const notificationMessage =
      `Background Claude Code adversarial review finished. Open it with $cc:result ${reservedJobId}.`;
    const provider = startMockProvider({
      taskPrompt: "background adversarial review raw output should not surface",
      userRequest,
      skillTitle: "Claude Code Adversarial Review",
      expectedParentNeedles: [
        "background-routing-context --kind review --json",
        "--owner-session-id <owner-session-id>",
        "Never satisfy background adversarial review by running the companion command itself with shell backgrounding",
        "allow one extra `send_input` call after a successful shell result",
        "must target the provided parent thread id",
        "do not silently drop the completion notification path from the child prompt",
        "Background Claude Code adversarial review finished. Open it with $cc:result <reserved-job-id>.",
      ],
      taskCommand:
        `node ${JSON.stringify(COMPANION_SCRIPT)} adversarial-review --view-state defer --scope working-tree --model haiku --job-id ${JSON.stringify(reservedJobId)} --owner-session-id ${JSON.stringify(ownerSessionId)} focus on race conditions`,
      expectedChildNeedles: [
        "--view-state defer",
        "--job-id",
        reservedJobId,
        "--owner-session-id",
        ownerSessionId,
        "send_input",
        notificationMessage,
        "focus on race conditions",
      ],
      notificationMessage,
      childPromptChecks: "generic",
      spawnMessage:
        "You are a pure forwarder for a background Claude Code adversarial review job.\n" +
        "Do not inspect the repo, do not review anything yourself, and do not add commentary.\n" +
        "Run exactly one shell command and capture only the stdout-equivalent final result text from that command, ignoring stderr progress chatter like [cc] lines.\n" +
        "If the command succeeds and a parent thread id is available, send exactly this notification to the parent thread before finishing: " +
        JSON.stringify(notificationMessage) + "\n" +
        "Use that same sentence as your own final assistant message.\n" +
        "If the command fails, return only the command stdout if any, otherwise a terse failure note.\n\n" +
        `node ${JSON.stringify(COMPANION_SCRIPT)} adversarial-review --view-state defer --scope working-tree --model haiku --job-id ${JSON.stringify(reservedJobId)} --owner-session-id ${JSON.stringify(ownerSessionId)} focus on race conditions`,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
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

      assert.equal(
        execResult.status,
        0,
        [
          "background adversarial review codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, notificationMessage);
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
    installHooks(testEnv);
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

  it("auto-installs hooks during $cc:setup when the json probe reports they are missing", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const userRequest = "$cc:setup";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: ["Claude Code Setup"],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup --json`,
        `node ${JSON.stringify(INSTALL_HOOKS_SCRIPT)}`,
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup`,
      ],
    });
    testEnv.providerPort = await provider.listen();
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt("cc:setup", SETUP_SKILL_PATH, userRequest)
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Status: ready/i);
      assert.match(finalMessage, /hooks: Codex hooks installed/i);

      const hooksFile = path.join(testEnv.codexHome, "hooks.json");
      assert.ok(fs.existsSync(hooksFile), "setup should install hooks when they are missing");
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("auto-installs hooks during $cc:setup --enable-review-gate when the json probe reports they are missing", async (t) => {
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
        `node ${JSON.stringify(INSTALL_HOOKS_SCRIPT)}`,
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup --enable-review-gate`,
      ],
    });
    testEnv.providerPort = await provider.listen();
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt("cc:setup", SETUP_SKILL_PATH, userRequest)
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Status: ready/i);
      assert.match(finalMessage, /hooks: Codex hooks installed/i);
      assert.match(finalMessage, /review gate: enabled/i);
      assert.match(finalMessage, /Enabled the stop-time review gate/i);

      const hooksFile = path.join(testEnv.codexHome, "hooks.json");
      assert.ok(
        fs.existsSync(hooksFile),
        "setup --enable-review-gate should still install hooks when they are missing"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });
});
