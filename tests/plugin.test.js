import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createStepRollbackPlugin } from "../dist/index.js";

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
