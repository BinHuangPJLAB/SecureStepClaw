import crypto from "node:crypto";

import { StepRollbackError, toStepRollbackError } from "./core/errors.js";
import { readJson, resolveAbsolutePath } from "./core/utils.js";
import { createStepRollbackPlugin, manifest } from "./plugin.js";

const HOOK_BINDINGS = [
  { hookName: "session_start", handlerName: "sessionStart", kind: "session" },
  { hookName: "session_end", handlerName: "sessionEnd", kind: "session" },
  { hookName: "before_tool_call", handlerName: "beforeToolCall", kind: "tool" },
  { hookName: "after_tool_call", handlerName: "afterToolCall", kind: "tool" }
];

const GATEWAY_METHOD_NAMES = [
  "steprollback.status",
  "steprollback.checkpoints.list",
  "steprollback.checkpoints.get",
  "steprollback.rollback",
  "steprollback.continue",
  "steprollback.rollback.status",
  "steprollback.reports.get",
  "steprollback.session.nodes.list",
  "steprollback.session.checkout",
  "steprollback.session.branch.get"
];

function createLogger(api) {
  const noop = () => {};
  const logger = api?.logger ?? {};

  return {
    info: logger.info?.bind(logger) ?? noop,
    warn: logger.warn?.bind(logger) ?? noop,
    error: logger.error?.bind(logger) ?? noop,
    debug: logger.debug?.bind(logger) ?? noop
  };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

function pickInteger(...values) {
  for (const value of values) {
    if (Number.isInteger(value)) {
      return value;
    }
  }

  return undefined;
}

function resolveCallable(root, pathSegments) {
  let current = root;

  for (const segment of pathSegments) {
    if (!current || typeof current !== "object") {
      return null;
    }

    current = current[segment];
  }

  if (typeof current !== "function") {
    return null;
  }

  const thisArg = pathSegments.length > 1 ? pathSegments.slice(0, -1).reduce((acc, key) => acc?.[key], root) : root;
  return {
    fn: current,
    thisArg: thisArg ?? root
  };
}

async function callFirstHelper(root, candidates, payload) {
  for (const pathSegments of candidates) {
    const resolved = resolveCallable(root, pathSegments);

    if (!resolved) {
      continue;
    }

    return resolved.fn.call(resolved.thisArg, payload);
  }

  return undefined;
}

async function callGatewayMethod(api, method, params) {
  const callerPaths = [
    ["runtime", "gateway", "call"],
    ["runtime", "rpc", "call"],
    ["runtime", "callGatewayMethod"],
    ["gateway", "call"],
    ["rpc", "call"],
    ["callGatewayMethod"]
  ];

  let foundCaller = false;
  let lastError = null;

  for (const callerPath of callerPaths) {
    const resolved = resolveCallable(api, callerPath);

    if (!resolved) {
      continue;
    }

    foundCaller = true;

    const callPatterns = [
      () => resolved.fn.call(resolved.thisArg, method, params),
      () => resolved.fn.call(resolved.thisArg, { method, params }),
      () => resolved.fn.call(resolved.thisArg, method, { params })
    ];

    for (const attempt of callPatterns) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (foundCaller && lastError) {
    throw lastError;
  }

  return undefined;
}

function unwrapRpcResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }

  if ("ok" in result && "data" in result) {
    return result.ok ? result.data : result;
  }

  return result;
}

function resolvePluginConfig(api, pluginId) {
  const entryConfig = api?.config?.plugins?.entries?.[pluginId]?.config;
  const directConfig = api?.pluginConfig;

  return {
    ...(entryConfig && typeof entryConfig === "object" ? entryConfig : {}),
    ...(directConfig && typeof directConfig === "object" ? directConfig : {})
  };
}

function extractGatewayParams(request) {
  if (!request || typeof request !== "object") {
    return {};
  }

  return pickFirst(
    request.params,
    request.input,
    request.body?.params,
    request.request?.body?.params,
    request.payload,
    request
  ) ?? {};
}

function normalizeHookContext(kind, event, ctx) {
  const payload = {
    agentId: pickFirst(
      event?.agentId,
      event?.agent?.id,
      event?.session?.agentId,
      ctx?.agentId,
      ctx?.agent?.id,
      ctx?.session?.agentId
    ),
    sessionId: pickFirst(
      event?.sessionId,
      event?.session?.id,
      ctx?.sessionId,
      ctx?.session?.id
    ),
    runId: pickFirst(
      event?.runId,
      event?.run?.id,
      ctx?.runId,
      ctx?.run?.id
    ),
    entryId: pickFirst(
      event?.entryId,
      event?.entry?.id,
      event?.toolCall?.entryId,
      event?.toolCall?.entry?.id,
      ctx?.entryId,
      ctx?.entry?.id
    ),
    nodeIndex: pickInteger(
      event?.nodeIndex,
      event?.entry?.nodeIndex,
      event?.toolCall?.nodeIndex,
      ctx?.nodeIndex,
      ctx?.entry?.nodeIndex
    ),
    toolName: pickFirst(
      event?.toolName,
      event?.tool?.name,
      event?.toolCall?.name,
      event?.call?.toolName,
      ctx?.toolName,
      ctx?.tool?.name
    ),
    success: pickFirst(event?.success, ctx?.success)
  };

  if (kind === "session") {
    return {
      agentId: payload.agentId,
      sessionId: payload.sessionId,
      runId: payload.runId,
      entryId: payload.entryId
    };
  }

  return payload;
}

function toNativeErrorPayload(error) {
  const normalized = toStepRollbackError(error, "CONTINUE_START_FAILED");

  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details
    }
  };
}

function normalizeRecordArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value?.sessions)) {
    return value.sessions;
  }

  if (Array.isArray(value?.items)) {
    return value.items;
  }

  if (value && typeof value === "object") {
    return Object.values(value);
  }

  return [];
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        const date = new Date(numeric);
        return Number.isNaN(date.getTime()) ? null : date;
      }
    }

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function formatTimestamp(value) {
  const date = normalizeTimestamp(value);

  if (!date) {
    return "-";
  }

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function timestampSortValue(...values) {
  for (const value of values) {
    const date = normalizeTimestamp(value);
    if (date) {
      return date.getTime();
    }
  }

  return 0;
}

function getConfiguredAgents(api) {
  const configured = pickFirst(
    api?.config?.agents?.list,
    api?.config?.agents?.entries,
    api?.config?.agents
  );

  if (Array.isArray(configured)) {
    return configured
      .map((entry) => {
        if (typeof entry === "string") {
          return { id: entry, name: entry };
        }

        if (entry && typeof entry === "object") {
          return {
            id: pickFirst(entry.id, entry.name, entry.agentId),
            name: pickFirst(entry.name, entry.id, entry.agentId),
            workspace: pickFirst(entry.workspace, entry.workspaceRoot, entry.cwd, entry.root),
            model: pickFirst(entry.model, entry.defaultModel)
          };
        }

        return null;
      })
      .filter((entry) => entry?.id);
  }

  if (configured && typeof configured === "object") {
    return Object.entries(configured).map(([id, entry]) => ({
      id,
      name: pickFirst(entry?.name, id),
      workspace: pickFirst(entry?.workspace, entry?.workspaceRoot, entry?.cwd, entry?.root),
      model: pickFirst(entry?.model, entry?.defaultModel)
    }));
  }

  return [{ id: "main", name: "main" }];
}

function resolveSessionIndexPath(api, agentId) {
  const configuredPath = pickFirst(
    api?.config?.session?.storePath,
    api?.config?.session?.indexPath,
    api?.config?.sessions?.storePath,
    api?.config?.sessions?.indexPath
  );
  const template = typeof configuredPath === "string"
    ? configuredPath
    : "~/.openclaw/agents/{agentId}/sessions/sessions.json";

  return resolveAbsolutePath(
    template
      .replaceAll("{agentId}", agentId)
      .replaceAll("{agent}", agentId)
  );
}

async function listSessionsForAgent(api, agentId) {
  const sessionIndexPath = resolveSessionIndexPath(api, agentId);
  const contents = await readJson(sessionIndexPath, []);

  const sessions = normalizeRecordArray(contents)
    .map((entry) => ({
      sessionId: pickFirst(entry?.sessionId, entry?.id),
      title: pickFirst(entry?.title, entry?.summary, entry?.label) || "(untitled)",
      createdAtRaw: pickFirst(entry?.createdAt, entry?.startedAt),
      updatedAtRaw: pickFirst(entry?.updatedAt, entry?.lastUpdatedAt, entry?.lastActivityAt),
      branchOf: pickFirst(entry?.branchOf, entry?.sourceSessionId)
    }))
    .filter((entry) => entry.sessionId)
    .sort(
      (left, right) =>
        timestampSortValue(right.updatedAtRaw, right.createdAtRaw) -
        timestampSortValue(left.updatedAtRaw, left.createdAtRaw)
    )
    .map((entry, index) => ({
      sessionId: entry.sessionId,
      marker: index === 0 ? "latest" : "",
      title: entry.title,
      updatedAt: formatTimestamp(entry.updatedAtRaw),
      createdAt: formatTimestamp(entry.createdAtRaw),
      branchOf: entry.branchOf ?? "-"
    }));

  return sessions;
}

function formatValue(value) {
  if (value === undefined || value === null || value === "") {
    return "-";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function renderTable(rows, columns) {
  const widths = columns.map((column) => {
    const headerWidth = column.label.length;
    const valueWidth = rows.reduce((max, row) => Math.max(max, formatValue(row[column.key]).length), 0);
    return Math.max(headerWidth, valueWidth);
  });

  const header = columns
    .map((column, index) => column.label.padEnd(widths[index], " "))
    .join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const lines = rows.map((row) =>
    columns
      .map((column, index) => formatValue(row[column.key]).padEnd(widths[index], " "))
      .join("  ")
  );

  return [header, divider, ...lines].join("\n");
}

function printRows(rows, columns, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (!rows.length) {
    console.log(options.emptyMessage ?? "No records found.");
    return;
  }

  console.log(renderTable(rows, columns));
}

function printObject(value, options = {}) {
  if (options.json || !value || typeof value !== "object" || Array.isArray(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  const rows = Object.entries(value).map(([key, entryValue]) => ({
    field: key,
    value: formatValue(entryValue)
  }));
  console.log(renderTable(rows, [
    { key: "field", label: "Field" },
    { key: "value", label: "Value" }
  ]));
}

function optionalBoolean(value) {
  return value === undefined ? undefined : Boolean(value);
}

function createNativeHostBridge(api, logger) {
  return {
    async stopRun({ agentId, sessionId, runId }) {
      const directResult = await callFirstHelper(api, [
        ["runtime", "agent", "stopRun"],
        ["runtime", "agent", "stop"],
        ["runtime", "runs", "stop"],
        ["runtime", "runControl", "stopRun"]
      ], {
        agentId,
        sessionId,
        runId
      });

      if (directResult !== undefined) {
        return directResult;
      }

      const rpcResult = await callGatewayMethod(api, "agent", {
        agentId,
        sessionId,
        message: "/stop"
      });

      if (rpcResult !== undefined) {
        const unwrapped = unwrapRpcResult(rpcResult);
        return {
          stopped: true,
          via: "agent:/stop",
          runId: unwrapped?.runId ?? runId
        };
      }

      logger.warn(
        `[${manifest.id}] No documented runtime stop helper was found. Assuming run '${runId ?? "unknown"}' is already stopped.`
      );

      return {
        stopped: true,
        assumed: true,
        runId
      };
    },

    async startContinueRun({ agentId, sessionId, entryId, prompt }) {
      const directResult = await callFirstHelper(api, [
        ["runtime", "agent", "continueRun"],
        ["runtime", "agent", "startContinueRun"],
        ["runtime", "agent", "startRun"],
        ["runtime", "runs", "start"],
        ["runtime", "runControl", "startContinueRun"]
      ], {
        agentId,
        sessionId,
        entryId,
        prompt
      });

      if (directResult !== undefined) {
        return directResult;
      }

      const syntheticMessage = prompt?.trim() || "Continue from the restored checkpoint.";
      const rpcResult = await callGatewayMethod(api, "agent", {
        agentId,
        sessionId,
        sessionIdOverride: sessionId,
        message: syntheticMessage,
        prompt: syntheticMessage,
        resumeFromEntryId: entryId,
        activeHeadEntryId: entryId
      });

      if (rpcResult !== undefined) {
        return unwrapRpcResult(rpcResult);
      }

      throw new StepRollbackError(
        "CONTINUE_START_FAILED",
        "OpenClaw did not expose a runtime helper or Gateway caller that the plugin could use to continue the run.",
        { agentId, sessionId, entryId }
      );
    },

    async createSession({ agentId, sourceSessionId, sourceEntryId }) {
      const directResult = await callFirstHelper(api, [
        ["runtime", "sessions", "createSession"],
        ["runtime", "session", "create"],
        ["runtime", "sessionUtils", "createSession"]
      ], {
        agentId,
        sourceSessionId,
        sourceEntryId
      });

      if (directResult !== undefined) {
        return directResult;
      }

      const sessionId = crypto.randomUUID();
      logger.warn(
        `[${manifest.id}] No documented session-create helper was found. Falling back to a generated session id '${sessionId}'.`
      );

      return { sessionId, assumed: true };
    }
  };
}

function registerGatewayMethods(api, engine, logger) {
  if (typeof api?.registerGatewayMethod !== "function") {
    throw new StepRollbackError(
      "CONTINUE_START_FAILED",
      "OpenClaw plugin API did not provide registerGatewayMethod(...)."
    );
  }

  for (const methodName of GATEWAY_METHOD_NAMES) {
    api.registerGatewayMethod(methodName, async (request = {}) => {
      try {
        const result = await engine.methods[methodName](extractGatewayParams(request));

        if (typeof request.respond === "function") {
          request.respond(true, result);
          return;
        }

        return result;
      } catch (error) {
        logger.error?.(`[${manifest.id}] Gateway method '${methodName}' failed: ${error instanceof Error ? error.message : error}`);

        const payload = toNativeErrorPayload(error);

        if (typeof request.respond === "function") {
          request.respond(false, payload.error);
          return;
        }

        throw error;
      }
    });
  }
}

function registerLifecycleHooks(api, engine, logger) {
  if (typeof api?.registerHook !== "function" && typeof api?.on !== "function") {
    throw new StepRollbackError(
      "CONTINUE_START_FAILED",
      "OpenClaw plugin API did not provide registerHook(...) or api.on(...)."
    );
  }

  for (const binding of HOOK_BINDINGS) {
    const handler = async (event, ctx) => {
      const normalized = normalizeHookContext(binding.kind, event, ctx);

      try {
        if (!normalized.agentId || !normalized.sessionId) {
          logger.debug?.(`[${manifest.id}] Skipping hook '${binding.hookName}' because agent/session ids were missing.`);
          return null;
        }

        if (binding.kind === "tool") {
          if (!normalized.entryId || !Number.isInteger(normalized.nodeIndex) || !normalized.toolName) {
            logger.warn?.(
              `[${manifest.id}] Skipping hook '${binding.hookName}' because entryId, nodeIndex, or toolName was missing.`
            );
            return null;
          }
        }

        return engine.hooks[binding.handlerName](normalized);
      } catch (error) {
        logger.error?.(
          `[${manifest.id}] Hook '${binding.hookName}' failed: ${error instanceof Error ? error.message : error}`
        );
        throw error;
      }
    };

    if (typeof api?.on === "function") {
      api.on(binding.hookName, handler);
      continue;
    }

    api.registerHook(binding.hookName, handler, {
      name: `${manifest.id}.${binding.hookName}`,
      description: `Step Rollback handler for ${binding.hookName}`
    });
  }
}

function registerService(api, engine, logger) {
  if (typeof api?.registerService !== "function") {
    return;
  }

  api.registerService({
    id: `${manifest.id}-runtime`,
    start: () => {
      logger.info?.(`[${manifest.id}] native runtime ready`);
      return engine.status();
    },
    stop: () => {
      logger.info?.(`[${manifest.id}] native runtime stopped`);
    }
  });
}

function registerCli(api, engine) {
  if (typeof api?.registerCli !== "function") {
    return;
  }

  api.registerCli(
    ({ program }) => {
      const command = program.command("steprollback").description("Inspect the Step Rollback native plugin.");

      command.command("status").action(async () => {
        const result = await engine.status();
        console.log(JSON.stringify(result, null, 2));
      });

      command
        .command("agents")
        .description("List configured OpenClaw agents.")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const agents = getConfiguredAgents(api);
          printRows(
            agents,
            [
              { key: "id", label: "Agent" },
              { key: "name", label: "Name" },
              { key: "workspace", label: "Workspace" },
              { key: "model", label: "Model" }
            ],
            {
              json: options.json,
              emptyMessage: "No agents were found in the OpenClaw config."
            }
          );
        });

      command
        .command("sessions")
        .description("List sessions for an agent without passing JSON.")
        .requiredOption("--agent <agentId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const sessions = await listSessionsForAgent(api, options.agent);
          printRows(
            sessions,
            [
              { key: "marker", label: "Mark" },
              { key: "sessionId", label: "Session" },
              { key: "title", label: "Title" },
              { key: "updatedAt", label: "Updated" },
              { key: "createdAt", label: "Created" },
              { key: "branchOf", label: "Branch Of" }
            ],
            {
              json: options.json,
              emptyMessage: `No sessions were found for agent '${options.agent}'.`
            }
          );
        });

      command
        .command("checkpoints")
        .description("List checkpoints for a session.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await engine.methods["steprollback.checkpoints.list"]({
            agentId: options.agent,
            sessionId: options.session
          });
          printRows(
            result.checkpoints,
            [
              { key: "checkpointId", label: "Checkpoint" },
              { key: "nodeIndex", label: "Node" },
              { key: "toolName", label: "Tool" },
              { key: "status", label: "Status" },
              { key: "createdAt", label: "Created" },
              { key: "summary", label: "Summary" }
            ],
            {
              json: options.json,
              emptyMessage: `No checkpoints were found for session '${options.session}'.`
            }
          );
        });

      command
        .command("checkpoint")
        .description("Show one checkpoint by id.")
        .requiredOption("--checkpoint <checkpointId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await engine.methods["steprollback.checkpoints.get"]({
            checkpointId: options.checkpoint
          });
          printObject(result.checkpoint, options);
        });

      command
        .command("rollback-status")
        .description("Show rollback state for a session.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await engine.methods["steprollback.rollback.status"]({
            agentId: options.agent,
            sessionId: options.session
          });
          printObject(result, options);
        });

      command
        .command("rollback")
        .description("Rollback a session to a checkpoint.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .requiredOption("--checkpoint <checkpointId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await engine.methods["steprollback.rollback"]({
            agentId: options.agent,
            sessionId: options.session,
            checkpointId: options.checkpoint
          });
          printObject(result, options);
        });

      command
        .command("continue")
        .description("Continue a rolled back session, with an optional prompt.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .option("--prompt <text>", "Optional continuation prompt.")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await engine.methods["steprollback.continue"]({
            agentId: options.agent,
            sessionId: options.session,
            prompt: options.prompt
          });
          printObject(result, options);
        });

      command
        .command("nodes")
        .description("List checkpoint-backed nodes for checkout.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await engine.methods["steprollback.session.nodes.list"]({
            agentId: options.agent,
            sessionId: options.session
          });
          printRows(
            result.nodes,
            [
              { key: "entryId", label: "Entry" },
              { key: "nodeIndex", label: "Node" },
              { key: "toolName", label: "Tool" },
              { key: "checkoutAvailable", label: "Checkout" },
              { key: "createdAt", label: "Created" }
            ],
            {
              json: options.json,
              emptyMessage: `No checkpoint-backed nodes were found for session '${options.session}'.`
            }
          );
        });

      command
        .command("checkout")
        .description("Create a new session from a checkpoint-backed entry.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--source-session <sessionId>")
        .requiredOption("--entry <entryId>")
        .option("--continue", "Continue immediately after checkout.")
        .option("--prompt <text>", "Optional prompt used when continuing after checkout.")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await engine.methods["steprollback.session.checkout"]({
            agentId: options.agent,
            sourceSessionId: options.sourceSession,
            sourceEntryId: options.entry,
            continueAfterCheckout: optionalBoolean(options.continue) ?? false,
            prompt: options.prompt
          });
          printObject(result, options);
        });

      command
        .command("report")
        .description("Show a rollback report.")
        .requiredOption("--rollback <rollbackId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await engine.methods["steprollback.reports.get"]({
            rollbackId: options.rollback
          });
          printObject(result, options);
        });

      command
        .command("branch")
        .description("Show a checkout branch record.")
        .requiredOption("--branch <branchId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await engine.methods["steprollback.session.branch.get"]({
            branchId: options.branch
          });
          printObject(result, options);
        });
    },
    { commands: ["steprollback"] }
  );
}

export function createNativeStepRollbackPlugin(options = {}) {
  return {
    id: manifest.id,
    name: manifest.name,
    configSchema: manifest.configSchema,
    async register(api) {
      const logger = createLogger(api);
      const config = {
        ...resolvePluginConfig(api, manifest.id),
        ...(options.config ?? {})
      };
      const engine = createStepRollbackPlugin({
        config,
        host: {
          ...createNativeHostBridge(api, logger),
          ...(options.host ?? {})
        }
      });

      registerGatewayMethods(api, engine, logger);
      registerLifecycleHooks(api, engine, logger);
      registerService(api, engine, logger);
      registerCli(api, engine);

      logger.info?.(`[${manifest.id}] registered native OpenClaw plugin surfaces`);

      return engine;
    }
  };
}

export const nativeStepRollbackPlugin = createNativeStepRollbackPlugin();

export default nativeStepRollbackPlugin;
