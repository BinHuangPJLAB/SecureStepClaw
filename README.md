# SecureStepClaw

Chinese version: [`README.zh-CN.md`](./README.zh-CN.md)

`SecureStepClaw` is a native OpenClaw plugin implementation of the `step-rollback` design described in [`docs/`](./docs). It includes the native runtime entry, rollback engine, storage model, manifest, and tests for the Phase 1 and Phase 2 API surface described in the project docs.

## Current status

This repository now exports an OpenClaw native plugin runtime from [`dist/index.js`](./dist/index.js), with the native registration logic implemented in [`dist/native-plugin.js`](./dist/native-plugin.js).

What is already here:

- the plugin manifest: [`openclaw.plugin.json`](./openclaw.plugin.json)
- the native plugin runtime with `register(api)`: [`dist/native-plugin.js`](./dist/native-plugin.js)
- Gateway RPC method registration via `api.registerGatewayMethod(...)`
- typed lifecycle hook registration via `api.on(...)`
- plugin service and CLI registration
- the rollback engine and API implementation: [`dist/plugin.js`](./dist/plugin.js)
- the public entry exports: [`dist/index.js`](./dist/index.js)
- local tests that verify checkpoint, rollback, continue, prune, and checkout flows: [`tests/plugin.test.js`](./tests/plugin.test.js)

Known caveats:

- I did not verify this against a live OpenClaw Gateway process in this workspace, so the native bridge is tested with a mock OpenClaw API rather than a running OpenClaw instance.
- The documented plugin APIs cover native registration surfaces well, but they do not document a dedicated “resume this session from historical entry X” runtime helper. Because of that, the plugin uses documented native surfaces plus a best-effort runtime bridge in [`dist/native-plugin.js`](./dist/native-plugin.js).
- If your OpenClaw build exposes different runtime helper names under `api.runtime`, you may need a small compatibility adjustment in [`dist/native-plugin.js`](./dist/native-plugin.js).
- When `steprollback.continue` is called without a prompt, the plugin synthesizes the message `Continue from the restored checkpoint.` because OpenClaw’s agent entrypoint expects a message payload.

## What is implemented

### Phase 1

- automatic checkpoint creation before each tool call
- checkpoint registry and lookup
- workspace snapshot restore
- rollback status tracking
- continue with an optional prompt
- rollback reports

### Phase 2 scaffolding

- session node listing
- checkout metadata and branch records
- new-session runtime state bootstrap

## Repository layout

- [`docs/`](./docs): PRD, architecture, and API design
- [`openclaw.plugin.json`](./openclaw.plugin.json): plugin manifest and config schema
- [`package.json`](./package.json): package metadata and test script
- [`dist/index.js`](./dist/index.js): public entry exports
- [`dist/native-plugin.js`](./dist/native-plugin.js): OpenClaw native runtime entry and registration
- [`dist/plugin.js`](./dist/plugin.js): core plugin engine
- [`dist/services/`](./dist/services): checkpoint, registry, runtime, lock, and report services
- [`tests/plugin.test.js`](./tests/plugin.test.js): Node test suite

## Prerequisites

Before you use or integrate this project, make sure you have:

1. Node.js 24 or newer
2. an OpenClaw installation with Gateway enabled
3. access to the machine that actually runs the OpenClaw Gateway

Important OpenClaw behavior to keep in mind:

- native plugins run inside the Gateway process
- plugin config lives under `plugins.entries.<id>.config`
- config changes require a Gateway restart
- for local development, OpenClaw can install a plugin from a folder or link it with `openclaw plugins install -l <path>`

## Local development workflow

This is the workflow you can use if you want to exercise the rollback engine directly in code, outside a live OpenClaw Gateway.

### 1. Open the project

```bash
cd /Users/bin-mac/CodeX/SecureStepClaw
```

### 2. Run the test suite

```bash
npm test
```

Expected result: all tests pass.

### 3. Use the rollback engine in code

Besides the native OpenClaw runtime entry, the repository also exposes the rollback engine as a plain JavaScript API for direct local testing.

```js
import crypto from "node:crypto";
import { createStepRollbackPlugin } from "./dist/index.js";

const plugin = createStepRollbackPlugin({
  config: {
    workspaceRoots: ["/absolute/path/to/workspace"],
    checkpointDir: "/absolute/path/to/plugin-data/checkpoints",
    registryDir: "/absolute/path/to/plugin-data/registry",
    runtimeDir: "/absolute/path/to/plugin-data/runtime",
    reportsDir: "/absolute/path/to/plugin-data/reports"
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
```

### 4. Feed session and tool lifecycle events into it

```js
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

await plugin.hooks.afterToolCall({
  agentId: "main",
  sessionId: "session-1",
  entryId: "entry-1",
  nodeIndex: 1,
  toolName: "write",
  runId: "run-1",
  success: true
});
```

### 5. Call the rollback APIs

```js
const list = await plugin.methods["steprollback.checkpoints.list"]({
  agentId: "main",
  sessionId: "session-1"
});

const rollback = await plugin.methods["steprollback.rollback"]({
  agentId: "main",
  sessionId: "session-1",
  checkpointId: list.checkpoints[0].checkpointId
});

const resumed = await plugin.methods["steprollback.continue"]({
  agentId: "main",
  sessionId: "session-1",
  prompt: "Continue from here, but do not rewrite the config file yet."
});
```

## Configuration reference

The plugin config schema in [`openclaw.plugin.json`](./openclaw.plugin.json) supports these keys:

- `enabled`
- `workspaceRoots`
- `checkpointDir`
- `registryDir`
- `runtimeDir`
- `reportsDir`
- `maxCheckpointsPerSession`
- `allowContinuePrompt`
- `stopRunBeforeRollback`

Example config object:

```json
{
  "enabled": true,
  "workspaceRoots": [
    "/Users/you/.openclaw/workspace"
  ],
  "checkpointDir": "/Users/you/.openclaw/plugins/step-rollback/checkpoints",
  "registryDir": "/Users/you/.openclaw/plugins/step-rollback/registry",
  "runtimeDir": "/Users/you/.openclaw/plugins/step-rollback/runtime",
  "reportsDir": "/Users/you/.openclaw/plugins/step-rollback/reports",
  "maxCheckpointsPerSession": 100,
  "allowContinuePrompt": true,
  "stopRunBeforeRollback": true
}
```

## How to install this into OpenClaw

### 1. Keep the repo on the Gateway machine

The plugin runs inside the OpenClaw Gateway process, so install it on the same machine that runs Gateway.

### 2. Verify the local package first

```bash
cd /Users/bin-mac/CodeX/SecureStepClaw
npm test
```

### 3. Install the plugin

Development install by link:

```bash
openclaw plugins install -l /Users/bin-mac/CodeX/SecureStepClaw
```

Local copy install:

```bash
openclaw plugins install /Users/bin-mac/CodeX/SecureStepClaw
```

This repository advertises its native runtime entry through both:

- [`openclaw.plugin.json`](./openclaw.plugin.json)
- the `openclaw.extensions` field in [`package.json`](./package.json)

### 4. Verify the install

```bash
openclaw plugins list
openclaw plugins info step-rollback
openclaw plugins doctor
```

### 5. Configure the plugin

Update your OpenClaw config so `step-rollback` is enabled and uses real paths for your workspace and plugin storage:

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "step-rollback": {
        "enabled": true,
        "config": {
          "enabled": true,
          "workspaceRoots": [
            "/Users/you/.openclaw/workspace"
          ],
          "checkpointDir": "/Users/you/.openclaw/plugins/step-rollback/checkpoints",
          "registryDir": "/Users/you/.openclaw/plugins/step-rollback/registry",
          "runtimeDir": "/Users/you/.openclaw/plugins/step-rollback/runtime",
          "reportsDir": "/Users/you/.openclaw/plugins/step-rollback/reports",
          "maxCheckpointsPerSession": 100,
          "allowContinuePrompt": true,
          "stopRunBeforeRollback": true
        }
      }
    }
  }
}
```

### 6. Restart Gateway

If you run Gateway as a service:

```bash
openclaw gateway restart
```

If you run Gateway in the foreground:

```bash
openclaw gateway run
```

### 7. Verify the native RPC surface

```bash
openclaw gateway call steprollback.status
openclaw gateway call steprollback.checkpoints.list --params '{"agentId":"main","sessionId":"<session-id>"}'
openclaw gateway call steprollback.rollback.status --params '{"agentId":"main","sessionId":"<session-id>"}'
```

### 8. Use the rollback flow

1. Start a normal OpenClaw task.
2. Let the agent execute tools.
3. Query checkpoints:

```bash
openclaw gateway call steprollback.checkpoints.list --params '{"agentId":"main","sessionId":"<session-id>"}'
```

4. Roll back to a checkpoint:

```bash
openclaw gateway call steprollback.rollback --params '{"agentId":"main","sessionId":"<session-id>","checkpointId":"<checkpoint-id>"}'
```

5. Confirm the session is waiting for continue:

```bash
openclaw gateway call steprollback.rollback.status --params '{"agentId":"main","sessionId":"<session-id>"}'
```

6. Continue execution.

Without a prompt:

```bash
openclaw gateway call steprollback.continue --params '{"agentId":"main","sessionId":"<session-id>"}'
```

With a prompt:

```bash
openclaw gateway call steprollback.continue --params '{"agentId":"main","sessionId":"<session-id>","prompt":"Continue from here, but inspect dependencies first."}'
```

### 9. Use the checkout flow

List checkpoint-backed nodes:

```bash
openclaw gateway call steprollback.session.nodes.list --params '{"agentId":"main","sessionId":"<session-id>"}'
```

Create a new session from a node:

```bash
openclaw gateway call steprollback.session.checkout --params '{"agentId":"main","sourceSessionId":"<session-id>","sourceEntryId":"<entry-id>","continueAfterCheckout":true,"prompt":"Continue on a new branch from here."}'
```

Look up the branch record:

```bash
openclaw gateway call steprollback.session.branch.get --params '{"branchId":"<branch-id>"}'
```

## Remaining caveats

These are the main things to keep in mind when using the native plugin:

1. The native registration path is implemented and tested, but not verified against a live OpenClaw Gateway binary in this repository.
2. The documented plugin APIs do not describe a dedicated runtime helper for “resume this exact session from historical entry X”.
3. The plugin therefore uses native registration plus a best-effort runtime bridge in [`dist/native-plugin.js`](./dist/native-plugin.js), including Gateway `agent` calls when direct helpers are unavailable.
4. If your OpenClaw build exposes different runtime helper names, update the helper lookup table in [`dist/native-plugin.js`](./dist/native-plugin.js).

## Verification

Run this from the repo root:

```bash
npm test
```

At the time this README was last updated, the test suite verified:

- checkpoint creation
- rollback and continue
- checkpoint pruning
- checkout branch metadata

## OpenClaw references

These official OpenClaw docs are the basis for the installation and runtime notes above:

- Plugins: https://docs.openclaw.ai/tools/plugin
- Plugin manifest: https://docs.openclaw.ai/plugins/manifest
- Plugin CLI: https://docs.openclaw.ai/cli/plugins
- Gateway CLI: https://docs.openclaw.ai/cli/gateway
- Agent loop and plugin lifecycle hooks: https://docs.openclaw.ai/agent-loop
