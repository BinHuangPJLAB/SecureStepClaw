import crypto from "node:crypto";
import path from "node:path";

import { StepRollbackError, ensureCondition, toStepRollbackError } from "./core/errors.js";
import {
  createDefaultHostBridge,
  defaultConfig,
  nowIso,
  resolveConfig,
  SequenceStore
} from "./core/utils.js";
import { CheckpointManager } from "./services/checkpoint-manager.js";
import { CheckpointRegistry } from "./services/checkpoint-registry.js";
import { ReportWriter } from "./services/report-writer.js";
import { RuntimeCursorManager } from "./services/runtime-cursor-manager.js";
import { SessionLockManager } from "./services/session-lock-manager.js";

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
      enabled: { type: "boolean", default: true },
      workspaceRoots: {
        type: "array",
        items: { type: "string" },
        default: ["~/.openclaw/workspace"]
      },
      checkpointDir: {
        type: "string",
        default: "~/.openclaw/plugins/step-rollback/checkpoints"
      },
      registryDir: {
        type: "string",
        default: "~/.openclaw/plugins/step-rollback/registry"
      },
      runtimeDir: {
        type: "string",
        default: "~/.openclaw/plugins/step-rollback/runtime"
      },
      reportsDir: {
        type: "string",
        default: "~/.openclaw/plugins/step-rollback/reports"
      },
      maxCheckpointsPerSession: {
        type: "number",
        default: 100
      },
      allowContinuePrompt: {
        type: "boolean",
        default: true
      },
      stopRunBeforeRollback: {
        type: "boolean",
        default: true
      }
    },
    additionalProperties: false
  }
};

function createNoopLogger() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop
  };
}

const READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "read_many",
  "readmany",
  "glob",
  "grep",
  "ls",
  "list_dir",
  "listdir",
  "list_directory",
  "directory_tree",
  "stat"
]);

const EXEC_LIKE_TOOL_NAMES = new Set([
  "exec",
  "bash",
  "shell",
  "terminal",
  "command"
]);

const READ_ONLY_EXEC_COMMANDS = new Set([
  "cat",
  "diff",
  "du",
  "fd",
  "find",
  "grep",
  "head",
  "less",
  "ls",
  "more",
  "pwd",
  "rg",
  "stat",
  "tail",
  "tree",
  "wc",
  "whereis",
  "which"
]);

const NEUTRAL_EXEC_COMMANDS = new Set([
  "cd",
  "pushd",
  "popd",
  "true"
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "blame",
  "branch",
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "remote",
  "rev-parse",
  "show",
  "status"
]);

function normalizeToolToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findNestedValueByKeys(value, keys, seen = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) {
    return null;
  }

  seen.add(value);

  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
      return value[key];
    }
  }

  const entries = Array.isArray(value) ? value : Object.values(value);

  for (const entry of entries) {
    const nested = findNestedValueByKeys(entry, keys, seen, depth + 1);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function extractCommandText(params) {
  if (typeof params === "string") {
    const normalized = params.trim();
    return normalized || null;
  }

  if (!isPlainObject(params) && !Array.isArray(params)) {
    return null;
  }

  const command = findNestedValueByKeys(params, ["command", "cmd", "script", "shell", "input", "text"]);
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

function splitShellSegments(commandText) {
  return String(commandText ?? "")
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function unquoteShellToken(token) {
  return String(token ?? "").replace(/^['"]|['"]$/g, "");
}

function tokenizeShellSegment(segment) {
  return segment.match(/"[^"]+"|'[^']+'|\S+/g)?.map(unquoteShellToken) ?? [];
}

function stripEnvAssignments(tokens) {
  let index = 0;

  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
    index += 1;
  }

  return tokens.slice(index);
}

function resolveGitSubcommand(tokens) {
  let index = 1;

  while (index < tokens.length) {
    const token = tokens[index];

    if (["-C", "--git-dir", "--work-tree", "-c"].includes(token)) {
      index += 2;
      continue;
    }

    if (token.startsWith("-")) {
      index += 1;
      continue;
    }

    return normalizeToolToken(token);
  }

  return "";
}

function isReadOnlyFindInvocation(tokens) {
  return !tokens.some((token, index) =>
    token === "-delete" ||
    (token === "-exec" && tokens[index + 1] && normalizeToolToken(tokens[index + 1]) !== "echo") ||
    token === "-execdir" ||
    token === "-ok" ||
    token === "-okdir"
  );
}

function isReadOnlyExecSegment(segment) {
  const stripped = stripEnvAssignments(tokenizeShellSegment(segment));

  if (!stripped.length) {
    return true;
  }

  const command = normalizeToolToken(stripped[0]);

  if (!command) {
    return false;
  }

  if (NEUTRAL_EXEC_COMMANDS.has(command)) {
    return true;
  }

  if (command === "git") {
    return READ_ONLY_GIT_SUBCOMMANDS.has(resolveGitSubcommand(stripped));
  }

  if (command === "find") {
    return isReadOnlyFindInvocation(stripped);
  }

  return READ_ONLY_EXEC_COMMANDS.has(command);
}

function shouldCreateCheckpointForTool(ctx) {
  const toolName = normalizeToolToken(ctx?.toolName);

  if (!toolName) {
    return true;
  }

  if (READ_ONLY_TOOL_NAMES.has(toolName)) {
    return false;
  }

  if (!EXEC_LIKE_TOOL_NAMES.has(toolName)) {
    return true;
  }

  const commandText = extractCommandText(ctx?.params);

  if (!commandText) {
    return true;
  }

  const segments = splitShellSegments(commandText);

  if (!segments.length) {
    return true;
  }

  return !segments.every((segment) => isReadOnlyExecSegment(segment));
}

function toRollbackStatus(agentId, sessionId, state) {
  return {
    agentId,
    sessionId,
    rollbackInProgress: state?.rollbackInProgress ?? false,
    awaitingContinue: state?.awaitingContinue ?? false,
    activeHeadEntryId: state?.activeHeadEntryId ?? null,
    lastRollbackCheckpointId: state?.lastRollbackCheckpointId ?? undefined
  };
}

function timestampValue(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareTimeline(left, right, fallbackKeys = []) {
  const createdDelta = timestampValue(left?.createdAt) - timestampValue(right?.createdAt);

  if (createdDelta !== 0) {
    return createdDelta;
  }

  const updatedDelta = timestampValue(left?.updatedAt) - timestampValue(right?.updatedAt);

  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  for (const key of fallbackKeys) {
    const compare = String(left?.[key] ?? "").localeCompare(String(right?.[key] ?? ""));

    if (compare !== 0) {
      return compare;
    }
  }

  return 0;
}

function buildSessionTreeKey(agentId, sessionId) {
  return `${agentId}::${sessionId}`;
}

function appendMapValue(map, key, value) {
  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}

export class StepRollbackPlugin {
  constructor({ config, host, services, logger }) {
    this.config = config;
    this.host = host;
    this.services = services;
    this.manifest = manifest;
    this.logger = logger ?? createNoopLogger();

    this.hooks = {
      sessionStart: (ctx) => this.sessionStart(ctx),
      sessionEnd: (ctx) => this.sessionEnd(ctx),
      beforeToolCall: (ctx) => this.beforeToolCall(ctx),
      afterToolCall: (ctx) => this.afterToolCall(ctx)
    };

    this.methods = {
      "steprollback.status": () => this.status(),
      "steprollback.checkpoints.list": (input) => this.listCheckpoints(input),
      "steprollback.checkpoints.get": (input) => this.getCheckpoint(input),
      "steprollback.rollback": (input) => this.rollback(input),
      "steprollback.continue": (input) => this.continue(input),
      "steprollback.rollback.status": (input) => this.rollbackStatus(input),
      "steprollback.reports.get": (input) => this.getReport(input),
      "steprollback.session.nodes.list": (input) => this.listSessionNodes(input),
      "steprollback.session.tree": (input) => this.listSessionTree(input),
      "steprollback.session.checkout": (input) => this.checkoutSession(input),
      "steprollback.session.branch.get": (input) => this.getBranch(input)
    };
  }

  async status() {
    return {
      pluginId: manifest.id,
      enabled: this.config.enabled,
      gatewayModeOnly: true,
      allowContinuePrompt: this.config.allowContinuePrompt
    };
  }

  async sessionStart(ctx) {
    ensureCondition(ctx?.agentId, "SESSION_NOT_FOUND", "sessionStart requires agentId.");
    ensureCondition(ctx?.sessionId, "SESSION_NOT_FOUND", "sessionStart requires sessionId.");

    this.logger.info(
      `[${manifest.id}] session_start agent='${ctx.agentId}' session='${ctx.sessionId}' run='${ctx.runId ?? "-"}'`
    );

    return this.services.runtimeCursorManager.update(
      ctx.agentId,
      ctx.sessionId,
      (state) => {
        state.activeHeadEntryId = ctx.entryId ?? state.activeHeadEntryId ?? null;
        state.currentRunId = ctx.runId ?? state.currentRunId ?? null;
        return state;
      },
      {
        activeHeadEntryId: ctx.entryId ?? null,
        currentRunId: ctx.runId ?? null
      }
    );
  }

  async sessionEnd(ctx) {
    ensureCondition(ctx?.agentId, "SESSION_NOT_FOUND", "sessionEnd requires agentId.");
    ensureCondition(ctx?.sessionId, "SESSION_NOT_FOUND", "sessionEnd requires sessionId.");
    this.logger.info(
      `[${manifest.id}] session_end agent='${ctx.agentId}' session='${ctx.sessionId}' run='${ctx.runId ?? "-"}'`
    );
    return this.services.runtimeCursorManager.clearCurrentRun(ctx.agentId, ctx.sessionId);
  }

  async beforeToolCall(ctx) {
    if (!this.config.enabled) {
      return null;
    }

    this.assertToolContext(ctx, "before_tool_call");
    this.logger.info(
      `[${manifest.id}] before_tool_call agent='${ctx.agentId}' session='${ctx.sessionId}' entry='${ctx.entryId}' node='${ctx.nodeIndex}' tool='${ctx.toolName}' toolCallId='${ctx.toolCallId ?? "-"}'`
    );

    await this.services.runtimeCursorManager.update(
      ctx.agentId,
      ctx.sessionId,
      (state) => {
        state.activeHeadEntryId = ctx.entryId;
        state.currentRunId = ctx.runId ?? state.currentRunId ?? null;
        return state;
      },
      {
        activeHeadEntryId: ctx.entryId,
        currentRunId: ctx.runId ?? null
      }
    );

    if (!shouldCreateCheckpointForTool(ctx)) {
      this.logger.info(
        `[${manifest.id}] skipped checkpoint for read-only tool agent='${ctx.agentId}' session='${ctx.sessionId}' tool='${ctx.toolName}'`
      );
      return null;
    }

    const checkpoint = await this.services.checkpointManager.create(ctx);
    this.logger.info(
      `[${manifest.id}] created checkpoint '${checkpoint.checkpointId}' for session '${ctx.sessionId}' before tool '${ctx.toolName}'`
    );
    return checkpoint;
  }

  async afterToolCall(ctx) {
    if (!this.config.enabled) {
      return null;
    }

    this.assertToolContext(ctx, "after_tool_call");
    this.logger.debug(
      `[${manifest.id}] after_tool_call agent='${ctx.agentId}' session='${ctx.sessionId}' entry='${ctx.entryId}' node='${ctx.nodeIndex}' tool='${ctx.toolName}' toolCallId='${ctx.toolCallId ?? "-"}'`
    );

    const runtimeState = await this.services.runtimeCursorManager.update(
      ctx.agentId,
      ctx.sessionId,
      (state) => {
        state.activeHeadEntryId = ctx.entryId;
        state.currentRunId = ctx.runId ?? state.currentRunId ?? null;
        return state;
      },
      {
        activeHeadEntryId: ctx.entryId,
        currentRunId: ctx.runId ?? null
      }
    );

    if (ctx.toolCallId && shouldCreateCheckpointForTool(ctx)) {
      await this.services.checkpointManager.reconcile(ctx);
    }

    return runtimeState;
  }

  async listCheckpoints({ agentId, sessionId }) {
    this.assertSessionRequest(agentId, sessionId);
    const checkpoints = await this.services.checkpointManager.list(agentId, sessionId);
    return { agentId, sessionId, checkpoints };
  }

  async getCheckpoint({ checkpointId }) {
    ensureCondition(checkpointId, "CHECKPOINT_NOT_FOUND", "checkpointId is required.");
    const checkpoint = await this.services.checkpointManager.get(checkpointId);
    ensureCondition(
      checkpoint,
      "CHECKPOINT_NOT_FOUND",
      `Checkpoint '${checkpointId}' was not found.`,
      { checkpointId }
    );
    return { checkpoint };
  }

  async rollbackStatus({ agentId, sessionId }) {
    this.assertSessionRequest(agentId, sessionId);
    const state = await this.services.runtimeCursorManager.get(agentId, sessionId);
    return toRollbackStatus(agentId, sessionId, state);
  }

  async getReport({ rollbackId }) {
    ensureCondition(rollbackId, "ENTRY_NOT_FOUND", "rollbackId is required.");
    return this.services.reportWriter.get(rollbackId);
  }

  async rollback({ agentId, sessionId, checkpointId, restoreWorkspace = false }) {
    this.assertSessionRequest(agentId, sessionId);
    ensureCondition(checkpointId, "CHECKPOINT_NOT_FOUND", "checkpointId is required.");
    this.logger.info(
      `[${manifest.id}] rollback requested agent='${agentId}' session='${sessionId}' checkpoint='${checkpointId}' restoreWorkspace='${restoreWorkspace ? "true" : "false"}'`
    );

    return this.services.lockManager.withLock(agentId, sessionId, async () => {
      const checkpoint = await this.services.checkpointManager.get(checkpointId);
      ensureCondition(
        checkpoint,
        "CHECKPOINT_NOT_FOUND",
        `Checkpoint '${checkpointId}' was not found.`,
        { checkpointId }
      );
      ensureCondition(
        checkpoint.agentId === agentId && checkpoint.sessionId === sessionId,
        "CHECKPOINT_NOT_FOUND",
        `Checkpoint '${checkpointId}' does not belong to session '${sessionId}'.`,
        { checkpointId, agentId, sessionId }
      );

      const currentState = await this.services.runtimeCursorManager.ensure(agentId, sessionId);
      ensureCondition(
        !currentState.rollbackInProgress,
        "ROLLBACK_IN_PROGRESS",
        `Rollback is already running for session '${sessionId}'.`,
        { agentId, sessionId }
      );

      await this.services.runtimeCursorManager.setRollbackState(agentId, sessionId, true);

      let rollbackId = null;

      try {
        if (this.config.stopRunBeforeRollback && currentState.currentRunId) {
          const stopResult = await this.host.stopRun({
            agentId,
            sessionId,
            runId: currentState.currentRunId,
            checkpointId
          });
          const stopped = stopResult === undefined ? true : stopResult === true || stopResult.stopped !== false;

          ensureCondition(
            stopped,
            "RUN_STOP_FAILED",
            `Failed to stop run '${currentState.currentRunId}' before rollback.`,
            { agentId, sessionId, checkpointId, runId: currentState.currentRunId }
          );
        }

        await this.services.checkpointManager.restore(checkpointId, {
          restoreWorkspace: Boolean(restoreWorkspace),
          restoreRuntimeState: true
        });

        await this.services.runtimeCursorManager.applyRollback(agentId, sessionId, {
          entryId: checkpoint.entryId,
          checkpointId
        });

        rollbackId = await this.services.sequenceStore.next("rb");

        await this.services.reportWriter.save({
          rollbackId,
          agentId,
          sessionId,
          checkpointId,
          targetEntryId: checkpoint.entryId,
          triggeredAt: nowIso(),
          result: "success",
          message: restoreWorkspace ? "rollback completed" : "rollback completed without workspace restore",
          restoredWorkspace: Boolean(restoreWorkspace)
        });

        this.logger.info(
          `[${manifest.id}] rollback completed agent='${agentId}' session='${sessionId}' checkpoint='${checkpointId}' rollback='${rollbackId}'`
        );

        return {
          rollbackId,
          agentId,
          sessionId,
          checkpointId,
          targetEntryId: checkpoint.entryId,
          result: "success",
          restoredWorkspace: Boolean(restoreWorkspace),
          awaitingContinue: false,
          activeHeadEntryId: checkpoint.entryId
        };
      } catch (error) {
        const normalizedError = toStepRollbackError(error, "SNAPSHOT_RESTORE_FAILED", {
          agentId,
          sessionId,
          checkpointId
        });

        this.logger.error(
          `[${manifest.id}] rollback failed agent='${agentId}' session='${sessionId}' checkpoint='${checkpointId}': ${normalizedError.message}`
        );

        rollbackId = rollbackId ?? (await this.services.sequenceStore.next("rb"));
        await this.services.reportWriter.save({
          rollbackId,
          agentId,
          sessionId,
          checkpointId,
          targetEntryId: checkpoint?.entryId ?? null,
          triggeredAt: nowIso(),
          result: "failed",
          message: normalizedError.message,
          restoredWorkspace: Boolean(restoreWorkspace)
        });

        throw normalizedError;
      } finally {
        await this.services.runtimeCursorManager.setRollbackState(agentId, sessionId, false);
      }
    });
  }

  async continue({ agentId, sessionId, checkpointId, prompt, newAgentId, cloneAuth, log = false }) {
    this.assertSessionRequest(agentId, sessionId);
    this.logger.info(
      `[${manifest.id}] continue requested agent='${agentId}' session='${sessionId}' checkpoint='${checkpointId ?? "-"}' prompt='${prompt ?? "-"}' newAgent='${newAgentId ?? "-"}' log='${log ? "true" : "false"}'`
    );

    ensureCondition(
      checkpointId,
      "CHECKPOINT_NOT_FOUND",
      "checkpointId is required to continue from a checkpoint.",
      { agentId, sessionId }
    );
    ensureCondition(
      typeof prompt === "string" && prompt.trim(),
      "ERR_PROMPT_REQUIRED",
      "continue requires a non-empty prompt.",
      { agentId, sessionId, checkpointId }
    );
    if (!this.config.allowContinuePrompt) {
      throw new StepRollbackError(
        "CONTINUE_START_FAILED",
        "Continue prompt is disabled by plugin configuration.",
        { agentId, sessionId, checkpointId }
      );
    }
    await this.services.runtimeCursorManager.ensure(agentId, sessionId);
    const checkpoint = checkpointId === "latest"
      ? (await this.services.checkpointManager.list(agentId, sessionId)).at(-1) ?? null
      : await this.services.checkpointManager.get(checkpointId);

    ensureCondition(
      checkpoint,
      "CHECKPOINT_NOT_FOUND",
      `Checkpoint '${checkpointId}' was not found.`,
      { agentId, sessionId, checkpointId }
    );

    ensureCondition(
      checkpoint.agentId === agentId && checkpoint.sessionId === sessionId,
      "CHECKPOINT_NOT_FOUND",
      `Checkpoint '${checkpointId}' does not belong to session '${sessionId}'.`,
      { checkpointId, agentId, sessionId }
    );

    const branchId = await this.services.sequenceStore.next("br");
    const forkResult = await this.host.forkContinue({
      sourceAgentId: agentId,
      sourceSessionId: sessionId,
      sourceEntryId: checkpoint.entryId,
      checkpoint,
      prompt,
      newAgentId,
      cloneAuth,
      branchId,
      log
    });

    const started = forkResult === undefined ? true : forkResult === true || forkResult.started !== false;
    ensureCondition(
      started,
      "CONTINUE_START_FAILED",
      `Failed to fork a new agent from checkpoint '${checkpointId}'.`,
      { agentId, sessionId, checkpointId, newAgentId }
    );

    const resolvedAgentId = forkResult?.newAgentId ?? newAgentId ?? `${agentId}-cp-${branchId.slice(-4)}`;
    const resolvedSessionId = forkResult?.newSessionId ?? crypto.randomUUID();
    const resolvedSessionKey = forkResult?.newSessionKey ?? null;
    const resolvedWorkspacePath = forkResult?.newWorkspacePath ?? null;
    const resolvedAgentDir = forkResult?.newAgentDir ?? null;
    const resolvedLogFilePath = forkResult?.logFilePath ?? null;
    const createdNewAgent = forkResult?.createdNewAgent ?? true;
    const branchRecord = {
      branchId,
      branchType: "agent",
      sourceAgentId: agentId,
      sourceSessionId: sessionId,
      sourceEntryId: checkpoint.entryId,
      sourceCheckpointId: checkpoint.checkpointId,
      newAgentId: resolvedAgentId,
      newWorkspacePath: resolvedWorkspacePath,
      newAgentDir: resolvedAgentDir,
      logFilePath: resolvedLogFilePath,
      newSessionId: resolvedSessionId,
      newSessionKey: resolvedSessionKey,
      prompt,
      createdAt: nowIso(),
      reason: "continue",
      createdNewAgent
    };

    await this.services.registry.saveBranch(branchRecord);
    await this.services.runtimeCursorManager.replace(resolvedAgentId, resolvedSessionId, {
      activeHeadEntryId: checkpoint.entryId,
      currentRunId: forkResult?.runId ?? null,
      rollbackInProgress: false,
      awaitingContinue: false,
      lastRollbackCheckpointId: checkpoint.checkpointId
    });
    await this.services.runtimeCursorManager.update(agentId, sessionId, (currentState) => {
      currentState.awaitingContinue = false;
      currentState.rollbackInProgress = false;
      currentState.lastContinuePrompt = prompt;
      currentState.currentRunId = null;
      currentState.lastContinuedBranchId = branchId;
      currentState.lastContinueSessionId = resolvedSessionId;
      currentState.lastContinueSessionKey = resolvedSessionKey ?? undefined;
      return currentState;
    });

    this.logger.info(
      `[${manifest.id}] continue forked parentAgent='${agentId}' session='${sessionId}' branch='${branchId}' newAgent='${resolvedAgentId}' newSession='${resolvedSessionId}'`
    );

    return {
      ok: true,
      parentAgentId: agentId,
      parentSessionId: sessionId,
      sourceEntryId: checkpoint.entryId,
      checkpointId: checkpoint.checkpointId,
      branchId,
      newAgentId: resolvedAgentId,
      newWorkspacePath: resolvedWorkspacePath,
      newAgentDir: resolvedAgentDir,
      logFilePath: resolvedLogFilePath,
      newSessionId: resolvedSessionId,
      newSessionKey: resolvedSessionKey,
      createdNewAgent,
      continued: true,
      started: forkResult?.started !== false,
      usedPrompt: true
    };
  }

  async listSessionNodes({ agentId, sessionId }) {
    this.assertSessionRequest(agentId, sessionId);
    const nodes = await this.services.registry.listNodes(agentId, sessionId);
    return { agentId, sessionId, nodes };
  }

  async listSessionTree({ agentId, sessionId, nodeId, checkpointId }) {
    const requestedAgentId = typeof agentId === "string" ? agentId.trim() : "";
    const requestedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    const requestedNodeId = typeof nodeId === "string" && nodeId.trim()
      ? nodeId.trim()
      : typeof checkpointId === "string" && checkpointId.trim()
        ? checkpointId.trim()
        : "";
    const sessionIndexes = await this.services.registry.listSessionIndexes();
    const sessionIndexByKey = new Map();
    const sessionKeysBySessionId = new Map();
    const checkpointsById = new Map();
    const checkpointsBySessionKey = new Map();

    for (const sessionIndex of sessionIndexes) {
      const sessionKey = buildSessionTreeKey(sessionIndex.agentId, sessionIndex.sessionId);
      sessionIndexByKey.set(sessionKey, sessionIndex);
      appendMapValue(sessionKeysBySessionId, sessionIndex.sessionId, sessionKey);
      checkpointsBySessionKey.set(sessionKey, sessionIndex.checkpoints ?? []);

      for (const checkpoint of sessionIndex.checkpoints ?? []) {
        checkpointsById.set(checkpoint.checkpointId, checkpoint);
      }
    }

    const resolveSessionKey = (resolvedAgentId, resolvedSessionId) => {
      if (!resolvedSessionId) {
        return null;
      }

      if (resolvedAgentId) {
        const directKey = buildSessionTreeKey(resolvedAgentId, resolvedSessionId);
        return sessionIndexByKey.has(directKey) ? directKey : null;
      }

      const matches = sessionKeysBySessionId.get(resolvedSessionId) ?? [];
      return matches[0] ?? null;
    };

    const resolveCheckpointByEntry = (resolvedAgentId, resolvedSessionId, entryId) => {
      if (!resolvedSessionId || !entryId) {
        return null;
      }

      const resolvedSessionKey = resolveSessionKey(resolvedAgentId, resolvedSessionId);
      const checkpoints = resolvedSessionKey ? checkpointsBySessionKey.get(resolvedSessionKey) ?? [] : [];
      return checkpoints.find((checkpoint) => checkpoint.entryId === entryId) ?? null;
    };

    const rawBranches = await this.services.registry.listBranches();
    const normalizedBranches = rawBranches
      .map((branch) => {
        const resolvedChildSessionKey = resolveSessionKey(branch.newAgentId, branch.newSessionId);
        const resolvedSourceSessionKey = resolveSessionKey(branch.sourceAgentId, branch.sourceSessionId);
        const sourceCheckpoint = branch.sourceCheckpointId
          ? checkpointsById.get(branch.sourceCheckpointId) ?? null
          : resolveCheckpointByEntry(branch.sourceAgentId, branch.sourceSessionId, branch.sourceEntryId);
        const childRootCheckpoint = resolvedChildSessionKey
          ? (checkpointsBySessionKey.get(resolvedChildSessionKey) ?? [])[0] ?? null
          : null;

        return {
          ...branch,
          reason: branch.reason ?? branch.branchType ?? "branch",
          sourceSessionKey: resolvedSourceSessionKey,
          childSessionKey: resolvedChildSessionKey,
          sourceCheckpointId: sourceCheckpoint?.checkpointId ?? branch.sourceCheckpointId ?? null,
          childRootCheckpointId: childRootCheckpoint?.checkpointId ?? null
        };
      })
      .filter((branch) => branch.childSessionKey || branch.sourceSessionKey || branch.sourceCheckpointId);
    const childSessionKeys = new Set(
      normalizedBranches
        .map((branch) => branch.childSessionKey)
        .filter(Boolean)
    );
    let rootCheckpoint = requestedNodeId ? checkpointsById.get(requestedNodeId) ?? null : null;
    let resolvedBy = requestedNodeId ? "node" : requestedSessionId ? "session" : "default";

    if (requestedNodeId && !rootCheckpoint) {
      rootCheckpoint = await this.services.checkpointManager.get(requestedNodeId);
    }

    if (!requestedNodeId) {
      let targetSessionIndex = null;

      if (requestedSessionId) {
        const sessionKey = resolveSessionKey(requestedAgentId, requestedSessionId);
        targetSessionIndex = sessionKey ? sessionIndexByKey.get(sessionKey) ?? null : null;
        ensureCondition(
          targetSessionIndex,
          "SESSION_NOT_FOUND",
          requestedAgentId
            ? `Session '${requestedSessionId}' was not found for agent '${requestedAgentId}'.`
            : `Session '${requestedSessionId}' was not found in checkpoint history.`,
          { agentId: requestedAgentId || undefined, sessionId: requestedSessionId }
        );
      } else {
        const candidates = sessionIndexes.filter((entry) => !requestedAgentId || entry.agentId === requestedAgentId);

        ensureCondition(
          candidates.length > 0,
          "SESSION_NOT_FOUND",
          requestedAgentId
            ? `No checkpoint sessions were found for agent '${requestedAgentId}'.`
            : "No checkpoint sessions were found.",
          { agentId: requestedAgentId || undefined }
        );

        const rootCandidates = candidates.filter(
          (entry) => !childSessionKeys.has(buildSessionTreeKey(entry.agentId, entry.sessionId))
        );
        const sortedCandidates = [...(rootCandidates.length > 0 ? rootCandidates : candidates)]
          .sort((left, right) => compareTimeline(left, right, ["agentId", "sessionId"]));
        targetSessionIndex = sortedCandidates[0] ?? null;
      }

      rootCheckpoint = targetSessionIndex?.checkpoints?.[0] ?? null;
    }

    ensureCondition(
      rootCheckpoint,
      "CHECKPOINT_NOT_FOUND",
      requestedNodeId
        ? `Node '${requestedNodeId}' was not found.`
        : requestedSessionId
          ? `Session '${requestedSessionId}' does not have any checkpoints.`
          : requestedAgentId
            ? `Agent '${requestedAgentId}' does not have any checkpoints yet.`
            : "No checkpoints were found.",
      {
        agentId: requestedAgentId || undefined,
        sessionId: requestedSessionId || undefined,
        checkpointId: requestedNodeId || undefined
      }
    );

    const rootSessionKey = buildSessionTreeKey(rootCheckpoint.agentId, rootCheckpoint.sessionId);

    if (!sessionIndexByKey.has(rootSessionKey)) {
      const rootSessionCheckpoints = await this.services.checkpointManager.list(rootCheckpoint.agentId, rootCheckpoint.sessionId);
      sessionIndexByKey.set(rootSessionKey, {
        agentId: rootCheckpoint.agentId,
        sessionId: rootCheckpoint.sessionId,
        checkpoints: rootSessionCheckpoints
      });
      checkpointsBySessionKey.set(rootSessionKey, rootSessionCheckpoints);

      for (const checkpoint of rootSessionCheckpoints) {
        checkpointsById.set(checkpoint.checkpointId, checkpoint);
      }
    }

    const branchesBySourceCheckpointId = new Map();

    for (const branch of normalizedBranches) {
      if (!branch.sourceCheckpointId || !branch.childRootCheckpointId) {
        continue;
      }

      appendMapValue(branchesBySourceCheckpointId, branch.sourceCheckpointId, branch);
    }

    for (const [sourceCheckpointId, branches] of branchesBySourceCheckpointId.entries()) {
      branches.sort((left, right) => {
        const leftCheckpoint = checkpointsById.get(left.childRootCheckpointId) ?? left;
        const rightCheckpoint = checkpointsById.get(right.childRootCheckpointId) ?? right;
        return compareTimeline(leftCheckpoint, rightCheckpoint, ["branchId", "childRootCheckpointId"]);
      });
      branchesBySourceCheckpointId.set(sourceCheckpointId, branches);
    }

    const buildTree = (currentCheckpointId, incoming = null, lineage = new Set()) => {
      if (lineage.has(currentCheckpointId)) {
        return null;
      }

      const checkpoint = checkpointsById.get(currentCheckpointId) ?? null;

      if (!checkpoint) {
        return null;
      }

      const nextLineage = new Set(lineage);
      nextLineage.add(currentCheckpointId);

      const sessionKey = buildSessionTreeKey(checkpoint.agentId, checkpoint.sessionId);
      const sessionCheckpoints = checkpointsBySessionKey.get(sessionKey) ?? [];
      const position = sessionCheckpoints.findIndex((item) => item.checkpointId === currentCheckpointId);
      const linearChild = position >= 0 ? sessionCheckpoints[position + 1] ?? null : null;
      const branchChildren = branchesBySourceCheckpointId.get(currentCheckpointId) ?? [];
      const children = [];

      if (linearChild) {
        const child = buildTree(linearChild.checkpointId, { type: "linear" }, nextLineage);

        if (child) {
          children.push(child);
        }
      }

      for (const branch of branchChildren) {
        const child = buildTree(branch.childRootCheckpointId, {
          type: "branch",
          branchId: branch.branchId,
          reason: branch.reason
        }, nextLineage);

        if (child) {
          children.push(child);
        }
      }

      return {
        checkpointId: checkpoint.checkpointId,
        agentId: checkpoint.agentId,
        sessionId: checkpoint.sessionId,
        entryId: checkpoint.entryId,
        nodeIndex: checkpoint.nodeIndex,
        toolName: checkpoint.toolName,
        summary: checkpoint.summary,
        status: checkpoint.status,
        createdAt: checkpoint.createdAt,
        incomingType: incoming?.type ?? "root",
        incomingReason: incoming?.reason ?? null,
        branchId: incoming?.branchId ?? null,
        children
      };
    };

    const tree = buildTree(rootCheckpoint.checkpointId);
    const seenCheckpoints = new Set();
    const seenSessions = new Set();
    let totalBranches = 0;

    const visit = (node) => {
      if (!node || seenCheckpoints.has(node.checkpointId)) {
        return;
      }

      seenCheckpoints.add(node.checkpointId);
      seenSessions.add(buildSessionTreeKey(node.agentId, node.sessionId));

      if (node.incomingType === "branch") {
        totalBranches += 1;
      }

      for (const child of node.children ?? []) {
        visit(child);
      }
    };

    visit(tree);

    return {
      agentId: rootCheckpoint.agentId,
      sessionId: rootCheckpoint.sessionId,
      root: {
        checkpointId: rootCheckpoint.checkpointId,
        agentId: rootCheckpoint.agentId,
        sessionId: rootCheckpoint.sessionId,
        entryId: rootCheckpoint.entryId,
        nodeIndex: rootCheckpoint.nodeIndex,
        resolvedBy,
        usedDefaultRoot: resolvedBy === "default"
      },
      tree,
      totalNodes: seenCheckpoints.size,
      totalSessions: seenSessions.size,
      totalBranches
    };
  }

  async checkoutSession({
    agentId,
    sourceSessionId,
    sourceEntryId,
    continueAfterCheckout = false,
    prompt
  }) {
    ensureCondition(agentId, "SESSION_NOT_FOUND", "agentId is required.");
    ensureCondition(sourceSessionId, "SESSION_NOT_FOUND", "sourceSessionId is required.");
    ensureCondition(sourceEntryId, "ENTRY_NOT_FOUND", "sourceEntryId is required.");

    return this.services.lockManager.withLock(agentId, sourceSessionId, async () => {
      const checkpoints = await this.services.checkpointManager.list(agentId, sourceSessionId);
      const checkpoint = checkpoints.find((item) => item.entryId === sourceEntryId);

      ensureCondition(
        checkpoint,
        "ENTRY_NOT_FOUND",
        `Entry '${sourceEntryId}' was not found in session '${sourceSessionId}'.`,
        { agentId, sourceSessionId, sourceEntryId }
      );
      ensureCondition(
        checkpoint.status === "ready" || checkpoint.status === "restored",
        "CHECKOUT_NOT_SUPPORTED",
        `Entry '${sourceEntryId}' is not available for checkout.`,
        { agentId, sourceSessionId, sourceEntryId, checkpointId: checkpoint.checkpointId }
      );

      await this.services.checkpointManager.restore(checkpoint.checkpointId, {
        restoreWorkspace: true,
        restoreRuntimeState: false
      });

      const branchId = await this.services.sequenceStore.next("br");
      const createdSession = await this.host.createSession({
        agentId,
        sourceSessionId,
        sourceEntryId,
        checkpointId: checkpoint.checkpointId,
        branchId,
        purpose: "checkout"
      });

      const provisionalSessionId = createdSession?.sessionId ?? crypto.randomUUID();
      const provisionalSessionKey = createdSession?.sessionKey ?? null;

      let continued = false;
      let usedPrompt = false;
      let resolvedSessionId = provisionalSessionId;
      let resolvedSessionKey = provisionalSessionKey;

      if (continueAfterCheckout) {
        const runResult = await this.host.startContinueRun({
          agentId,
          sessionId: provisionalSessionId,
          sessionKey: provisionalSessionKey,
          entryId: sourceEntryId,
          prompt,
          checkpointId: checkpoint.checkpointId,
          sourceSessionId,
          sourceEntryId,
          branchId,
          label: createdSession?.label
        });
        const started = runResult === undefined ? true : runResult === true || runResult.started !== false;

        ensureCondition(
          started,
          "CONTINUE_START_FAILED",
          `Failed to continue newly checked out session '${provisionalSessionId}'.`,
          { agentId, sourceSessionId, newSessionId: provisionalSessionId, sourceEntryId }
        );

        resolvedSessionId = runResult?.sessionId ?? provisionalSessionId;
        resolvedSessionKey = runResult?.sessionKey ?? provisionalSessionKey ?? null;
        await this.services.runtimeCursorManager.replace(agentId, resolvedSessionId, {
          activeHeadEntryId: sourceEntryId,
          currentRunId: runResult?.runId ?? null,
          rollbackInProgress: false,
          awaitingContinue: false,
          lastRollbackCheckpointId: checkpoint.checkpointId
        });
        await this.services.runtimeCursorManager.applyContinue(agentId, resolvedSessionId, {
          prompt,
          runId: runResult?.runId ?? null
        });
        continued = true;
        usedPrompt = Boolean(prompt);
      } else {
        await this.services.runtimeCursorManager.replace(agentId, resolvedSessionId, {
          activeHeadEntryId: sourceEntryId,
          currentRunId: null,
          rollbackInProgress: false,
          awaitingContinue: false,
          lastRollbackCheckpointId: checkpoint.checkpointId
        });
      }

      const branchRecord = {
        branchId,
        branchType: "session",
        sourceAgentId: agentId,
        sourceSessionId,
        sourceEntryId,
        sourceCheckpointId: checkpoint.checkpointId,
        newAgentId: agentId,
        newSessionId: resolvedSessionId,
        newSessionKey: resolvedSessionKey,
        createdAt: nowIso(),
        reason: continueAfterCheckout ? "checkout-continue" : "checkout"
      };
      await this.services.registry.saveBranch(branchRecord);

      return {
        branchId,
        sourceSessionId,
        sourceEntryId,
        newSessionId: resolvedSessionId,
        newSessionKey: resolvedSessionKey,
        continued,
        usedPrompt
      };
    });
  }

  async getBranch({ branchId }) {
    ensureCondition(branchId, "ENTRY_NOT_FOUND", "branchId is required.");
    return this.services.registry.getBranch(branchId);
  }

  assertToolContext(ctx, hookName) {
    ensureCondition(ctx?.agentId, "SESSION_NOT_FOUND", `${hookName} requires agentId.`);
    ensureCondition(ctx?.sessionId, "SESSION_NOT_FOUND", `${hookName} requires sessionId.`);
    ensureCondition(ctx?.entryId, "ENTRY_NOT_FOUND", `${hookName} requires entryId.`);
    ensureCondition(
      Number.isInteger(ctx?.nodeIndex),
      "ENTRY_NOT_FOUND",
      `${hookName} requires an integer nodeIndex.`
    );
    ensureCondition(ctx?.toolName, "ENTRY_NOT_FOUND", `${hookName} requires toolName.`);
  }

  assertSessionRequest(agentId, sessionId) {
    ensureCondition(agentId, "SESSION_NOT_FOUND", "agentId is required.");
    ensureCondition(sessionId, "SESSION_NOT_FOUND", "sessionId is required.");
  }
}

export function createStepRollbackPlugin(options = {}) {
  const config = resolveConfig(options.config);
  const host = createDefaultHostBridge(options.host);
  const logger = options.logger ?? createNoopLogger();
  const sequenceStore = new SequenceStore(path.join(config.registryDir, "_sequences.json"));
  const runtimeCursorManager = new RuntimeCursorManager({ config });
  const registry = new CheckpointRegistry({ config });
  const checkpointManager = new CheckpointManager({
    config,
    registry,
    runtimeCursorManager,
    sequenceStore,
    logger
  });
  const reportWriter = new ReportWriter({ config });
  const lockManager = new SessionLockManager({ config });

  return new StepRollbackPlugin({
    config,
    host,
    logger,
    services: {
      sequenceStore,
      runtimeCursorManager,
      registry,
      checkpointManager,
      reportWriter,
      lockManager
    }
  });
}

export { defaultConfig };
