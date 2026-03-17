# SecureStepClaw

Chinese version: [`README.zh-CN.md`](./README.zh-CN.md)

`SecureStepClaw` is a local implementation of the `step-rollback` plugin described in [`docs/`](./docs). It gives you the rollback engine, storage model, manifest, and tests for the Phase 1 and Phase 2 API surface described in the project docs.

## Current status

This repository is very close to an OpenClaw native plugin, but it is not yet a drop-in Gateway plugin.

What is already here:

- the plugin manifest: [`openclaw.plugin.json`](./openclaw.plugin.json)
- the rollback engine and API implementation: [`dist/plugin.js`](./dist/plugin.js)
- the public entry exports: [`dist/index.js`](./dist/index.js)
- local tests that verify checkpoint, rollback, continue, prune, and checkout flows: [`tests/plugin.test.js`](./tests/plugin.test.js)

What is still missing for a live OpenClaw install:

- a native OpenClaw runtime adapter that exports `register(api)`
- wiring from OpenClaw hook events like `before_tool_call`, `after_tool_call`, `session_start`, and `session_end` into this rollback engine
- a host bridge for real OpenClaw run control:
  - stop the active run before rollback
  - continue a run from a rollback point
  - create a new session for checkout

Because of that, this repo is accurate to use today as:

- a tested rollback engine
- a reference implementation for the API in `docs/`
- the code you will wrap with an OpenClaw SDK adapter

It is not yet accurate to present this as a fully installable production OpenClaw plugin without that adapter layer.

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

This is the workflow you can use right now with the repository exactly as it exists.

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

The current entry point is a JavaScript API, not an OpenClaw `register(api)` runtime yet.

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

This section is split into two parts:

1. what you can do today with this repository
2. what the live OpenClaw install will look like once the native adapter is added

### Today: prepare and verify the engine locally

1. Keep the repo on the same machine that runs the OpenClaw Gateway.
2. Run `npm test` in this directory.
3. Decide where your plugin state should live.
4. Make sure your OpenClaw workspace path is known, because that is what the plugin snapshots and restores.
5. Add the future plugin config values now if you want to standardize paths ahead of the adapter work.

Suggested future config:

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

### After the native OpenClaw adapter is added

Once this repo exports a proper OpenClaw runtime entry with `register(api)`, the installation flow should look like this.

#### Option A: install by link for development

```bash
openclaw plugins install -l /Users/bin-mac/CodeX/SecureStepClaw
```

Use this when you want OpenClaw to load the plugin from your working copy without copying files.

#### Option B: install by local copy

```bash
openclaw plugins install /Users/bin-mac/CodeX/SecureStepClaw
```

Use this when you want OpenClaw to copy the plugin into its managed extensions directory.

#### Verify the install

```bash
openclaw plugins list
openclaw plugins info step-rollback
openclaw plugins doctor
```

#### Configure the plugin

Update your OpenClaw config so `step-rollback` is enabled and has concrete directories:

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

#### Restart the Gateway

If you run Gateway as a service:

```bash
openclaw gateway restart
```

If you run it in the foreground:

```bash
openclaw gateway run
```

#### Verify the RPC surface

Once the adapter is present and the plugin is live, these commands should work:

```bash
openclaw gateway call steprollback.status
openclaw gateway call steprollback.checkpoints.list --params '{"agentId":"main","sessionId":"<session-id>"}'
openclaw gateway call steprollback.rollback.status --params '{"agentId":"main","sessionId":"<session-id>"}'
```

#### Use the rollback flow from OpenClaw

1. Start a task in OpenClaw as usual.
2. Let the agent run tools.
3. Query the checkpoints for the current session:

```bash
openclaw gateway call steprollback.checkpoints.list --params '{"agentId":"main","sessionId":"<session-id>"}'
```

4. Pick a checkpoint id and roll back:

```bash
openclaw gateway call steprollback.rollback --params '{"agentId":"main","sessionId":"<session-id>","checkpointId":"<checkpoint-id>"}'
```

5. Confirm the session is waiting for continue:

```bash
openclaw gateway call steprollback.rollback.status --params '{"agentId":"main","sessionId":"<session-id>"}'
```

6. Continue from the restored point.

Without a prompt:

```bash
openclaw gateway call steprollback.continue --params '{"agentId":"main","sessionId":"<session-id>"}'
```

With a prompt:

```bash
openclaw gateway call steprollback.continue --params '{"agentId":"main","sessionId":"<session-id>","prompt":"Continue from here, but inspect dependencies first."}'
```

#### Use the checkout flow

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

## What still needs to be built

To make the "After the native OpenClaw adapter is added" section fully real, the next code step is:

1. export a native OpenClaw plugin object or default function from the runtime entry
2. register the `steprollback.*` Gateway methods with `api.registerGatewayMethod(...)`
3. connect OpenClaw lifecycle hooks via `api.on(...)`
4. bind OpenClaw's real run/session controls to:
   - `stopRun`
   - `startContinueRun`
   - `createSession`

Once that adapter exists, the install flow above becomes the actual production flow.

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
