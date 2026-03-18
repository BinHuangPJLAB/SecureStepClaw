export const defaultConfig = {
  enabled: true,
  workspaceRoots: ["~/.openclaw/workspace"],
  checkpointDir: "~/.openclaw/plugins/step-rollback/checkpoints",
  registryDir: "~/.openclaw/plugins/step-rollback/registry",
  runtimeDir: "~/.openclaw/plugins/step-rollback/runtime",
  reportsDir: "~/.openclaw/plugins/step-rollback/reports",
  maxCheckpointsPerSession: 100,
  allowContinuePrompt: true,
  stopRunBeforeRollback: true
};

export const CONFIG_DIRECTORY_KEYS = [
  "checkpointDir",
  "registryDir",
  "runtimeDir",
  "reportsDir"
];

export const manifest = {
  id: "step-rollback",
  name: "Step Rollback",
  version: "0.1.0",
  description: "Gateway rollback and session checkout plugin for OpenClaw.",
  runtime: {
    entry: "./dist/index.js"
  },
  configSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: defaultConfig.enabled },
      workspaceRoots: {
        type: "array",
        items: { type: "string" },
        default: defaultConfig.workspaceRoots
      },
      checkpointDir: {
        type: "string",
        default: defaultConfig.checkpointDir
      },
      registryDir: {
        type: "string",
        default: defaultConfig.registryDir
      },
      runtimeDir: {
        type: "string",
        default: defaultConfig.runtimeDir
      },
      reportsDir: {
        type: "string",
        default: defaultConfig.reportsDir
      },
      maxCheckpointsPerSession: {
        type: "number",
        default: defaultConfig.maxCheckpointsPerSession
      },
      allowContinuePrompt: {
        type: "boolean",
        default: defaultConfig.allowContinuePrompt
      },
      stopRunBeforeRollback: {
        type: "boolean",
        default: defaultConfig.stopRunBeforeRollback
      }
    },
    additionalProperties: false
  }
};

export const METHOD_NAMES = {
  status: "steprollback.status",
  checkpointsList: "steprollback.checkpoints.list",
  checkpointsGet: "steprollback.checkpoints.get",
  rollback: "steprollback.rollback",
  continue: "steprollback.continue",
  rollbackStatus: "steprollback.rollback.status",
  reportsGet: "steprollback.reports.get",
  sessionNodesList: "steprollback.session.nodes.list",
  sessionTree: "steprollback.session.tree",
  sessionCheckout: "steprollback.session.checkout",
  sessionBranchGet: "steprollback.session.branch.get"
};

export const GATEWAY_METHOD_NAMES = Object.values(METHOD_NAMES);

export const HOOK_BINDINGS = [
  { hookName: "session_start", handlerName: "sessionStart", kind: "session" },
  { hookName: "session_end", handlerName: "sessionEnd", kind: "session" },
  { hookName: "before_tool_call", handlerName: "beforeToolCall", kind: "tool" },
  { hookName: "after_tool_call", handlerName: "afterToolCall", kind: "tool" }
];
