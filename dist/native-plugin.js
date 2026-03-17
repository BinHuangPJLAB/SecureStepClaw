import crypto from "node:crypto";

import { StepRollbackError, toStepRollbackError } from "./core/errors.js";
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
  if (typeof api?.on !== "function") {
    throw new StepRollbackError("CONTINUE_START_FAILED", "OpenClaw plugin API did not provide api.on(...).");
  }

  for (const binding of HOOK_BINDINGS) {
    api.on(binding.hookName, async (event, ctx) => {
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
        .command("checkpoints")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .action(async (options) => {
          const result = await engine.methods["steprollback.checkpoints.list"]({
            agentId: options.agent,
            sessionId: options.session
          });
          console.log(JSON.stringify(result, null, 2));
        });

      command
        .command("rollback-status")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .action(async (options) => {
          const result = await engine.methods["steprollback.rollback.status"]({
            agentId: options.agent,
            sessionId: options.session
          });
          console.log(JSON.stringify(result, null, 2));
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
