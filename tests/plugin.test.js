import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import nativeStepRollbackPlugin, {
  createNativeStepRollbackPlugin,
  createStepRollbackPlugin
} from "../dist/index.js";

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

test("creates checkpoints, rolls back workspace state, and continues from the checkpoint", async () => {
  const fixture = await createFixture();
  const calls = {
    stopRun: [],
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
      async startContinueRun(input) {
        calls.continueRun.push(input);
        return { runId: `continued:${input.sessionId}:${input.entryId}` };
      }
    }
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "v1\n", "utf8");

  await plugin.hooks.sessionStart({
    agentId: "main",
    sessionId: "session-1",
    runId: "run-1"
  });

  await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-1",
    entryId: "entry-1",
    nodeIndex: 1,
    toolName: "write",
    runId: "run-1"
  });

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
  assert.equal(calls.continueRun.length, 1);
  assert.equal(calls.continueRun[0].entryId, "entry-1");

  const report = await plugin.methods["steprollback.reports.get"]({
    rollbackId: rollbackResponse.rollbackId
  });

  assert.equal(report.result, "success");
  assert.match(report.message, /waiting for continue/);

  const finalState = await plugin.services.runtimeCursorManager.get("main", "session-1");
  assert.equal(finalState.awaitingContinue, false);
  assert.equal(finalState.currentRunId, "continued:session-1:entry-1");
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

  await fs.writeFile(path.join(fixture.workspace, "native.txt"), "safe\n", "utf8");

  const api = {
    config: {
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
            return {
              runId: `run:${params.sessionId}:${params.resumeFromEntryId ?? "tail"}`,
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
    entryId: "entry-native",
    nodeIndex: 1,
    toolName: "write",
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
  assert.equal(
    gatewayCalls.some(
      (call) =>
        call.method === "agent" &&
        call.params.sessionId === "native-session" &&
        call.params.message === "Continue from the restored checkpoint."
    ),
    true
  );
  assert.equal(logs.some((entry) => entry.message.includes("registered native OpenClaw plugin surfaces")), true);
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
