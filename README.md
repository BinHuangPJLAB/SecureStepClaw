# SecureStepClaw

This repository now contains a runnable OpenClaw-style `step-rollback` plugin implementation based on the docs in [`docs/`](./docs).

## What's implemented

- Phase 1 core flow:
  - `before_tool_call` checkpoint creation
  - checkpoint registry and listing APIs
  - rollback with workspace restore
  - rollback status tracking
  - continue with optional prompt
- Phase 2 scaffolding plus working file-based checkout metadata:
  - session node listing
  - checkout to a new session id
  - branch record lookup

## Layout

- [`openclaw.plugin.json`](./openclaw.plugin.json): plugin manifest matching the API doc
- [`dist/index.js`](./dist/index.js): package entry
- [`dist/plugin.js`](./dist/plugin.js): plugin factory and public API
- [`dist/services/`](./dist/services): checkpoint/runtime/report/lock services
- [`tests/plugin.test.js`](./tests/plugin.test.js): local verification with Node's built-in test runner

## Usage

```js
import crypto from "node:crypto";
import { createStepRollbackPlugin } from "./dist/index.js";

const plugin = createStepRollbackPlugin({
  config: {
    workspaceRoots: ["/path/to/workspace"]
  },
  host: {
    async stopRun({ agentId, sessionId, runId }) {
      return { stopped: true, agentId, sessionId, runId };
    },
    async startContinueRun({ agentId, sessionId, entryId, prompt }) {
      return { runId: `run:${agentId}:${sessionId}:${entryId}:${prompt ?? ""}` };
    },
    async createSession() {
      return { sessionId: crypto.randomUUID() };
    }
  }
});

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

const checkpoints = await plugin.methods["steprollback.checkpoints.list"]({
  agentId: "main",
  sessionId: "session-1"
});
```
