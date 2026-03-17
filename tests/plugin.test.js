import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import nativeStepRollbackPlugin, {
  createNativeStepRollbackPlugin,
  createStepRollbackPlugin
} from "../dist/index.js";
import { resolveAbsolutePath } from "../dist/core/utils.js";

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secure-step-claw-"));
  const workspace = path.join(root, "workspace");
  const pluginRoot = path.join(root, "plugin-data");

  await fs.mkdir(workspace, { recursive: true });

  return {
    root,
    workspace,
    checkpointDir: path.join(pluginRoot, "checkpoints"),
    registryDir: path.join(pluginRoot, "registry"),
    runtimeDir: path.join(pluginRoot, "runtime"),
    reportsDir: path.join(pluginRoot, "reports")
  };
}

async function writeSessionTranscript(root, agentId, sessionId, entries) {
  const sessionsDir = path.join(root, "agents", agentId, "sessions");
  const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);

  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    transcriptPath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );

  return {
    transcriptPath,
    sessionStoreTemplate: path.join(root, "agents", "{agentId}", "sessions", "sessions.json")
  };
}

function createFakeProgram() {
  const commands = new Map();

  function createCommand(pathParts) {
    const record = {
      path: pathParts.join(" "),
      action: null
    };

    if (record.path) {
      commands.set(record.path, record);
    }

    return {
      command(name) {
        return createCommand([...pathParts, name]);
      },
      description() {
        return this;
      },
      option() {
        return this;
      },
      requiredOption() {
        return this;
      },
      action(handler) {
        record.action = handler;
        return this;
      }
    };
  }

  return {
    program: createCommand([]),
    commands
  };
}

async function captureConsoleLog(fn) {
  const original = console.log;
  const output = [];

  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await fn();
  } finally {
    console.log = original;
  }

  return output.join("\n");
}

test("creates checkpoints, rolls back workspace state, and continues from the checkpoint", async () => {
  const fixture = await createFixture();
  const calls = {
    stopRun: [],
    createSession: [],
    continueRun: []
  };

  const plugin = createStepRollbackPlugin({
    config: {
      workspaceRoots: [fixture.workspace],
      checkpointDir: fixture.checkpointDir,
      registryDir: fixture.registryDir,
      runtimeDir: fixture.runtimeDir,
      reportsDir: fixture.reportsDir
    },
    host: {
      async stopRun(input) {
        calls.stopRun.push(input);
        return { stopped: true };
      },
      async createSession(input) {
        calls.createSession.push(input);
        return {
          sessionId: "session-branch-1",
          sessionKey: "agent:main:direct:step-rollback-br_0001"
        };
      },
      async startContinueRun(input) {
        calls.continueRun.push(input);
        return {
          runId: `continued:${input.sessionId}:${input.entryId}`,
          sessionId: input.sessionId,
          sessionKey: input.sessionKey
        };
      }
    }
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "v1\n", "utf8");

  await plugin.hooks.sessionStart({
    agentId: "main",
    sessionId: "session-1",
    runId: "run-1"
  });

  const firstCheckpoint = await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-1",
    entryId: "entry-1",
    nodeIndex: 1,
    toolName: "write",
    runId: "run-1"
  });

  assert.equal(firstCheckpoint.workspaceSnapshots[0].backend, "git");
  assert.equal(firstCheckpoint.workspaceSnapshots[0].targetPath, fixture.workspace);
  assert.match(firstCheckpoint.workspaceSnapshots[0].commitId, /^[0-9a-f]{40}$/);

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "v2\n", "utf8");

  await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-1",
    entryId: "entry-2",
    nodeIndex: 2,
    toolName: "write",
    runId: "run-1"
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "broken\n", "utf8");

  const listResponse = await plugin.methods["steprollback.checkpoints.list"]({
    agentId: "main",
    sessionId: "session-1"
  });

  assert.equal(listResponse.checkpoints.length, 2);
  assert.equal(listResponse.checkpoints[0].summary, "before tool write");

  const rollbackResponse = await plugin.methods["steprollback.rollback"]({
    agentId: "main",
    sessionId: "session-1",
    checkpointId: listResponse.checkpoints[0].checkpointId
  });

  assert.equal(rollbackResponse.result, "success");
  assert.equal(rollbackResponse.awaitingContinue, true);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "app.txt"), "utf8"), "v1\n");
  assert.equal(calls.stopRun.length, 1);

  const rollbackStatus = await plugin.methods["steprollback.rollback.status"]({
    agentId: "main",
    sessionId: "session-1"
  });

  assert.equal(rollbackStatus.awaitingContinue, true);
  assert.equal(rollbackStatus.activeHeadEntryId, "entry-1");

  const continueResponse = await plugin.methods["steprollback.continue"]({
    agentId: "main",
    sessionId: "session-1",
    prompt: "Retry, but inspect dependencies first."
  });

  assert.equal(continueResponse.continued, true);
  assert.equal(continueResponse.usedPrompt, true);
  assert.equal(continueResponse.newSessionId, "session-branch-1");
  assert.equal(continueResponse.newSessionKey, "agent:main:direct:step-rollback-br_0001");
  assert.equal(calls.createSession.length, 1);
  assert.equal(calls.continueRun.length, 1);
  assert.equal(calls.continueRun[0].entryId, "entry-1");
  assert.equal(calls.continueRun[0].sessionId, "session-branch-1");
  assert.equal(calls.continueRun[0].sessionKey, "agent:main:direct:step-rollback-br_0001");

  const report = await plugin.methods["steprollback.reports.get"]({
    rollbackId: rollbackResponse.rollbackId
  });

  assert.equal(report.result, "success");
  assert.match(report.message, /waiting for continue/);

  const finalState = await plugin.services.runtimeCursorManager.get("main", "session-1");
  assert.equal(finalState.awaitingContinue, false);
  assert.equal(finalState.currentRunId, null);
  assert.equal(finalState.lastContinueSessionId, "session-branch-1");

  const branchedState = await plugin.services.runtimeCursorManager.get("main", "session-branch-1");
  assert.equal(branchedState.currentRunId, "continued:session-branch-1:entry-1");

  const branch = await plugin.methods["steprollback.session.branch.get"]({
    branchId: continueResponse.branchId
  });
  assert.equal(branch.sourceSessionId, "session-1");
  assert.equal(branch.newSessionId, "session-branch-1");
});

test("resolves relative paths even when process cwd is unavailable", () => {
  const originalCwd = process.cwd;

  Object.defineProperty(process, "cwd", {
    value() {
      const error = new Error("missing cwd");
      error.code = "ENOENT";
      throw error;
    },
    configurable: true
  });

  try {
    const resolved = resolveAbsolutePath("relative/path");
    assert.equal(resolved, path.join(os.homedir(), "relative/path"));
  } finally {
    Object.defineProperty(process, "cwd", {
      value: originalCwd,
      configurable: true
    });
  }
});

test("repairs placeholder home paths in plugin config", async () => {
  const plugin = createStepRollbackPlugin({
    config: {
      workspaceRoots: ["/Users/you/.openclaw/workspace"],
      checkpointDir: "/Users/you/.openclaw/plugins/step-rollback/checkpoints",
      registryDir: "/Users/you/.openclaw/plugins/step-rollback/registry",
      runtimeDir: "/Users/you/.openclaw/plugins/step-rollback/runtime",
      reportsDir: "/Users/you/.openclaw/plugins/step-rollback/reports"
    }
  });

  assert.equal(plugin.config.workspaceRoots[0], path.join(os.homedir(), ".openclaw", "workspace"));
  assert.equal(
    plugin.config.checkpointDir,
    path.join(os.homedir(), ".openclaw", "plugins", "step-rollback", "checkpoints")
  );
  assert.equal(
    plugin.config.registryDir,
    path.join(os.homedir(), ".openclaw", "plugins", "step-rollback", "registry")
  );
});

test("prunes old checkpoints when maxCheckpointsPerSession is exceeded", async () => {
  const fixture = await createFixture();
  const plugin = createStepRollbackPlugin({
    config: {
      workspaceRoots: [fixture.workspace],
      checkpointDir: fixture.checkpointDir,
      registryDir: fixture.registryDir,
      runtimeDir: fixture.runtimeDir,
      reportsDir: fixture.reportsDir,
      maxCheckpointsPerSession: 2
    }
  });

  await plugin.hooks.sessionStart({
    agentId: "main",
    sessionId: "session-prune",
    runId: "run-prune"
  });

  for (let index = 1; index <= 3; index += 1) {
    await fs.writeFile(path.join(fixture.workspace, "file.txt"), `v${index}\n`, "utf8");
    await plugin.hooks.beforeToolCall({
      agentId: "main",
      sessionId: "session-prune",
      entryId: `entry-${index}`,
      nodeIndex: index,
      toolName: "write",
      runId: "run-prune"
    });
  }

  const listResponse = await plugin.methods["steprollback.checkpoints.list"]({
    agentId: "main",
    sessionId: "session-prune"
  });

  assert.equal(listResponse.checkpoints.length, 2);
  assert.deepEqual(
    listResponse.checkpoints.map((checkpoint) => checkpoint.entryId),
    ["entry-2", "entry-3"]
  );
});

test("checks out a session branch from a checkpoint entry", async () => {
  const fixture = await createFixture();
  const calls = {
    createSession: [],
    continueRun: []
  };

  const plugin = createStepRollbackPlugin({
    config: {
      workspaceRoots: [fixture.workspace],
      checkpointDir: fixture.checkpointDir,
      registryDir: fixture.registryDir,
      runtimeDir: fixture.runtimeDir,
      reportsDir: fixture.reportsDir
    },
    host: {
      async createSession(input) {
        calls.createSession.push(input);
        return { sessionId: "session-branch" };
      },
      async startContinueRun(input) {
        calls.continueRun.push(input);
        return { runId: `run:${input.sessionId}` };
      }
    }
  });

  await plugin.hooks.sessionStart({
    agentId: "main",
    sessionId: "session-source",
    runId: "run-source"
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "base\n", "utf8");
  await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-source",
    entryId: "entry-base",
    nodeIndex: 1,
    toolName: "write",
    runId: "run-source"
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "next\n", "utf8");
  await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-source",
    entryId: "entry-next",
    nodeIndex: 2,
    toolName: "write",
    runId: "run-source"
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "broken\n", "utf8");

  const checkoutResponse = await plugin.methods["steprollback.session.checkout"]({
    agentId: "main",
    sourceSessionId: "session-source",
    sourceEntryId: "entry-base",
    continueAfterCheckout: true,
    prompt: "Continue from the safe checkpoint."
  });

  assert.equal(checkoutResponse.newSessionId, "session-branch");
  assert.equal(checkoutResponse.continued, true);
  assert.equal(checkoutResponse.usedPrompt, true);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "app.txt"), "utf8"), "base\n");
  assert.equal(calls.createSession.length, 1);
  assert.equal(calls.continueRun[0].sessionId, "session-branch");

  const branch = await plugin.methods["steprollback.session.branch.get"]({
    branchId: checkoutResponse.branchId
  });

  assert.equal(branch.sourceSessionId, "session-source");
  assert.equal(branch.sourceEntryId, "entry-base");

  const nodes = await plugin.methods["steprollback.session.nodes.list"]({
    agentId: "main",
    sessionId: "session-source"
  });

  assert.equal(nodes.nodes.length, 2);
  assert.equal(nodes.nodes[0].checkoutAvailable, true);
});

test("registers a native OpenClaw plugin and drives rollback through registered hooks and Gateway methods", async () => {
  const fixture = await createFixture();
  const registered = {
    methods: new Map(),
    hooks: new Map(),
    services: [],
    clis: []
  };
  const gatewayCalls = [];
  const logs = [];
  const toolCallId = "chatcmpl-tool-native";
  const transcript = await writeSessionTranscript(fixture.root, "main", "native-session", [
    {
      type: "message",
      id: "entry-native",
      timestamp: "2026-03-17T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "write",
            arguments: {
              file_path: path.join(fixture.workspace, "native.txt"),
              content: "broken\n"
            }
          }
        ]
      }
    }
  ]);
  const nativeSessionStorePath = transcript.sessionStoreTemplate.replace("{agentId}", "main");

  await fs.writeFile(
    nativeSessionStorePath,
    `${JSON.stringify({
      "agent:main:main": {
        sessionId: "native-session",
        label: "Native test session",
        updatedAt: "2026-03-17T00:00:00.000Z"
      }
    }, null, 2)}\n`,
    "utf8"
  );

  await fs.writeFile(path.join(fixture.workspace, "native.txt"), "safe\n", "utf8");

  const api = {
    config: {
      session: {
        storePath: transcript.sessionStoreTemplate
      },
      plugins: {
        entries: {
          "step-rollback": {
            enabled: true,
            config: {
              workspaceRoots: [fixture.workspace],
              checkpointDir: fixture.checkpointDir,
              registryDir: fixture.registryDir,
              runtimeDir: fixture.runtimeDir,
              reportsDir: fixture.reportsDir
            }
          }
        }
      }
    },
    logger: {
      info(message) {
        logs.push({ level: "info", message });
      },
      warn(message) {
        logs.push({ level: "warn", message });
      },
      error(message) {
        logs.push({ level: "error", message });
      },
      debug(message) {
        logs.push({ level: "debug", message });
      }
    },
    registerGatewayMethod(name, handler) {
      registered.methods.set(name, handler);
    },
    registerHook(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    on(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    registerService(service) {
      registered.services.push(service);
    },
    registerCli(factory, meta) {
      registered.clis.push({ factory, meta });
    },
    runtime: {
      gateway: {
        async call(method, params) {
          gatewayCalls.push({ method, params });

          if (method === "agent" && params.message === "/stop") {
            return { runId: "stop-run", acceptedAt: "2026-03-17T00:00:00.000Z" };
          }

          if (method === "agent") {
            const currentStore = JSON.parse(await fs.readFile(nativeSessionStorePath, "utf8"));

            if (params.sessionKey && !currentStore[params.sessionKey]) {
              currentStore[params.sessionKey] = {
                sessionId: "native-session-branch",
                label: params.label ?? "Rollback branch",
                updatedAt: "2026-03-17T00:00:01.000Z"
              };
              await fs.writeFile(nativeSessionStorePath, `${JSON.stringify(currentStore, null, 2)}\n`, "utf8");
            }

            return {
              runId: `run:${params.sessionKey ?? params.sessionId}:tail`,
              acceptedAt: "2026-03-17T00:00:01.000Z"
            };
          }

          return undefined;
        }
      }
    }
  };

  const nativePlugin = createNativeStepRollbackPlugin();
  const engine = await nativePlugin.register(api);

  assert.equal(nativeStepRollbackPlugin.id, "step-rollback");
  assert.equal(engine.manifest.id, "step-rollback");
  assert.equal(registered.methods.has("steprollback.status"), true);
  assert.equal(registered.methods.has("steprollback.rollback"), true);
  assert.equal(registered.hooks.has("session_start"), true);
  assert.equal(registered.hooks.has("before_tool_call"), true);
  assert.equal(typeof registered.hooks.get("before_tool_call").handler, "function");
  assert.equal(registered.services.length, 1);
  assert.equal(registered.clis.length, 1);
  assert.deepEqual(registered.clis[0].meta.commands, ["steprollback"]);

  const serviceStartResult = await registered.services[0].start();
  assert.equal(serviceStartResult.pluginId, "step-rollback");

  await registered.hooks.get("session_start").handler({
    agentId: "main",
    sessionId: "native-session",
    runId: "run-native"
  });

  await registered.hooks.get("before_tool_call").handler({
    agentId: "main",
    sessionId: "native-session",
    toolName: "write",
    toolCallId,
    runId: "run-native"
  });

  await fs.writeFile(path.join(fixture.workspace, "native.txt"), "broken\n", "utf8");

  const checkpointResponses = [];
  await registered.methods.get("steprollback.checkpoints.list")({
    params: {
      agentId: "main",
      sessionId: "native-session"
    },
    respond(ok, payload) {
      checkpointResponses.push({ ok, payload });
    }
  });

  assert.equal(checkpointResponses.length, 1);
  assert.equal(checkpointResponses[0].ok, true);
  assert.equal(checkpointResponses[0].payload.checkpoints.length, 1);

  const checkpointId = checkpointResponses[0].payload.checkpoints[0].checkpointId;

  const rollbackResponse = await registered.methods.get("steprollback.rollback")({
    params: {
      agentId: "main",
      sessionId: "native-session",
      checkpointId
    }
  });

  assert.equal(rollbackResponse.result, "success");
  assert.equal(await fs.readFile(path.join(fixture.workspace, "native.txt"), "utf8"), "safe\n");
  assert.equal(
    gatewayCalls.some((call) => call.method === "agent" && call.params.message === "/stop"),
    true
  );

  const continueResponse = await registered.methods.get("steprollback.continue")({
    params: {
      agentId: "main",
      sessionId: "native-session"
    }
  });

  assert.equal(continueResponse.continued, true);
  assert.equal(continueResponse.newSessionId, "native-session-branch");
  assert.match(continueResponse.newSessionKey, /^agent:main:direct:step-rollback-br_0001$/);
  assert.equal(
    gatewayCalls.some(
      (call) =>
        call.method === "agent" &&
        call.params.sessionKey === continueResponse.newSessionKey &&
        !("resumeFromEntryId" in call.params) &&
        call.params.message === "Continue from the restored checkpoint."
    ),
    true
  );
  assert.equal(logs.some((entry) => entry.message.includes("registered native OpenClaw plugin surfaces")), true);
  assert.equal(logs.some((entry) => entry.message.includes("resolved config")), false);
  assert.equal(logs.some((entry) => entry.message.includes("resolved tool checkpoint context")), true);
  assert.equal(logs.some((entry) => entry.message.includes("git workspace status")), true);
});

test("returns Gateway-style error payloads for native RPC handlers", async () => {
  const fixture = await createFixture();
  const registered = new Map();

  const api = {
    config: {
      plugins: {
        entries: {
          "step-rollback": {
            config: {
              workspaceRoots: [fixture.workspace],
              checkpointDir: fixture.checkpointDir,
              registryDir: fixture.registryDir,
              runtimeDir: fixture.runtimeDir,
              reportsDir: fixture.reportsDir
            }
          }
        }
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    registerGatewayMethod(name, handler) {
      registered.set(name, handler);
    },
    registerHook() {},
    on() {},
    registerService() {},
    registerCli() {}
  };

  await createNativeStepRollbackPlugin().register(api);

  const responses = [];
  await registered.get("steprollback.rollback")({
    params: {
      agentId: "main",
      sessionId: "missing-session",
      checkpointId: "missing-checkpoint"
    },
    respond(ok, payload) {
      responses.push({ ok, payload });
    }
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, false);
  assert.equal(responses[0].payload.code, "CHECKPOINT_NOT_FOUND");
});

test("offers flag-based CLI commands for agents, sessions, rollback, and continue", async () => {
  const fixture = await createFixture();
  const registered = {
    methods: new Map(),
    hooks: new Map(),
    services: [],
    clis: []
  };
  const cliGatewayCalls = [];
  const sessionStoreTemplate = path.join(fixture.root, "agents", "{agentId}", "sessions", "sessions.json");
  const sessionStorePath = sessionStoreTemplate.replace("{agentId}", "main");
  const toolCallId = "chatcmpl-tool-cli";

  await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
  await fs.writeFile(
    sessionStorePath,
    `${JSON.stringify([
      {
        sessionId: "session-cli",
        title: "CLI test session",
        updatedAt: "2026-03-17T12:00:00.000Z"
      }
    ], null, 2)}\n`,
    "utf8"
  );
  await writeSessionTranscript(fixture.root, "main", "session-cli", [
    {
      type: "message",
      id: "entry-cli",
      timestamp: "2026-03-17T12:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "write",
            arguments: {
              file_path: path.join(fixture.workspace, "cli.txt"),
              content: "broken\n"
            }
          }
        ]
      }
    }
  ]);
  await fs.writeFile(path.join(fixture.workspace, "cli.txt"), "stable\n", "utf8");

  const api = {
    config: {
      agents: {
        list: [
          {
            id: "main",
            name: "main",
            workspace: fixture.workspace,
            model: "gpt-test"
          }
        ]
      },
      session: {
        storePath: sessionStoreTemplate
      },
      plugins: {
        entries: {
          "step-rollback": {
            config: {
              workspaceRoots: [fixture.workspace],
              checkpointDir: fixture.checkpointDir,
              registryDir: fixture.registryDir,
              runtimeDir: fixture.runtimeDir,
              reportsDir: fixture.reportsDir
            }
          }
        }
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    registerGatewayMethod(name, handler) {
      registered.methods.set(name, handler);
    },
    registerHook(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    on(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    registerService(service) {
      registered.services.push(service);
    },
    registerCli(factory, meta) {
      registered.clis.push({ factory, meta });
    }
  };

  await createNativeStepRollbackPlugin({
    host: {
      async stopRun() {
        return { stopped: true, runId: "stop-cli" };
      },
      async startContinueRun({ sessionId, entryId }) {
        return { started: true, runId: `run:${sessionId}:${entryId}` };
      },
      async createSession() {
        return { sessionId: "session-checkout-cli" };
      }
    },
    cliGatewayInvoker: async (methodName, params) => {
      cliGatewayCalls.push({ methodName, params });
      const handler = registered.methods.get(methodName);
      return handler ? handler({ params }) : undefined;
    }
  }).register(api);

  const cliHarness = createFakeProgram();
  registered.clis[0].factory({ program: cliHarness.program });

  await registered.hooks.get("session_start").handler({
    agentId: "main",
    sessionId: "session-cli",
    runId: "run-cli"
  });
  await registered.hooks.get("before_tool_call").handler({
    agentId: "main",
    sessionId: "session-cli",
    toolName: "write",
    toolCallId,
    runId: "run-cli"
  });
  await fs.writeFile(path.join(fixture.workspace, "cli.txt"), "broken\n", "utf8");

  const agentsOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback agents").action({ agent: "main" });
  });
  assert.match(agentsOutput, /Agent/);
  assert.match(agentsOutput, /main/);

  const sessionsOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback sessions").action({ agent: "main" });
  });
  assert.match(sessionsOutput, /Mark/);
  assert.match(sessionsOutput, /latest/);
  assert.match(sessionsOutput, /session-cli/);
  assert.match(sessionsOutput, /CLI test session/);
  assert.match(sessionsOutput, /2026-03-17 \d{2}:\d{2}:\d{2}/);

  const checkpointsOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback checkpoints").action({
      agent: "main",
      session: "session-cli"
    });
  });
  assert.match(checkpointsOutput, /Checkpoint/);
  assert.match(checkpointsOutput, /entry-cli|ckpt_/);

  const checkpointList = await registered.methods.get("steprollback.checkpoints.list")({
    params: {
      agentId: "main",
      sessionId: "session-cli"
    }
  });
  const checkpointId = checkpointList.checkpoints[0].checkpointId;

  const rollbackOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback rollback").action({
      agent: "main",
      session: "session-cli",
      checkpoint: checkpointId
    });
  });
  assert.match(rollbackOutput, /rollbackId/);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "cli.txt"), "utf8"), "stable\n");

  const continueOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback continue").action({
      agent: "main",
      session: "session-cli",
      prompt: "Inspect first."
    });
  });
  assert.match(continueOutput, /continued/);
  assert.match(continueOutput, /usedPrompt/);
  assert.equal(
    cliGatewayCalls.some(
      (call) =>
        call.methodName === "steprollback.continue" &&
        call.params.agentId === "main" &&
        call.params.sessionId === "session-cli" &&
        call.params.prompt === "Inspect first."
    ),
    true
  );
});
