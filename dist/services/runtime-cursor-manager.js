import path from "node:path";

import { nowIso, readJson, writeJson } from "../core/utils.js";

function createInitialState(agentId, sessionId, seed = {}) {
  return {
    agentId,
    sessionId,
    activeHeadEntryId: seed.activeHeadEntryId ?? null,
    currentRunId: seed.currentRunId ?? null,
    rollbackInProgress: false,
    awaitingContinue: false,
    lastContinuePrompt: seed.lastContinuePrompt,
    lastRollbackCheckpointId: seed.lastRollbackCheckpointId,
    updatedAt: nowIso()
  };
}

export class RuntimeCursorManager {
  constructor({ config }) {
    this.config = config;
  }

  filePath(agentId, sessionId) {
    return path.join(this.config.runtimeDir, "sessions", agentId, `${sessionId}.json`);
  }

  async get(agentId, sessionId) {
    return readJson(this.filePath(agentId, sessionId), null);
  }

  async ensure(agentId, sessionId, seed = {}) {
    const existing = await this.get(agentId, sessionId);

    if (existing) {
      return existing;
    }

    const state = createInitialState(agentId, sessionId, seed);
    await writeJson(this.filePath(agentId, sessionId), state);
    return state;
  }

  async replace(agentId, sessionId, state) {
    const nextState = {
      ...createInitialState(agentId, sessionId),
      ...state,
      agentId,
      sessionId,
      updatedAt: nowIso()
    };

    await writeJson(this.filePath(agentId, sessionId), nextState);
    return nextState;
  }

  async update(agentId, sessionId, updater, seed = {}) {
    const current = await this.ensure(agentId, sessionId, seed);
    const nextState = updater(structuredClone(current)) ?? structuredClone(current);
    nextState.agentId = agentId;
    nextState.sessionId = sessionId;
    nextState.updatedAt = nowIso();

    await writeJson(this.filePath(agentId, sessionId), nextState);
    return nextState;
  }

  async setActiveHead(agentId, sessionId, entryId) {
    return this.update(agentId, sessionId, (state) => {
      state.activeHeadEntryId = entryId ?? null;
      return state;
    });
  }

  async setCurrentRun(agentId, sessionId, runId) {
    return this.update(agentId, sessionId, (state) => {
      state.currentRunId = runId ?? null;
      return state;
    });
  }

  async setRollbackState(agentId, sessionId, inProgress) {
    return this.update(agentId, sessionId, (state) => {
      state.rollbackInProgress = Boolean(inProgress);
      return state;
    });
  }

  async setAwaitingContinue(agentId, sessionId, awaiting) {
    return this.update(agentId, sessionId, (state) => {
      state.awaitingContinue = Boolean(awaiting);
      return state;
    });
  }

  async applyRollback(agentId, sessionId, { entryId, checkpointId }) {
    return this.update(agentId, sessionId, (state) => {
      state.activeHeadEntryId = entryId ?? null;
      state.currentRunId = null;
      state.rollbackInProgress = false;
      state.awaitingContinue = true;
      state.lastRollbackCheckpointId = checkpointId;
      return state;
    });
  }

  async applyContinue(agentId, sessionId, { prompt, runId }) {
    return this.update(agentId, sessionId, (state) => {
      state.awaitingContinue = false;
      state.rollbackInProgress = false;
      state.lastContinuePrompt = prompt || undefined;
      state.currentRunId = runId ?? null;
      return state;
    });
  }

  async clearCurrentRun(agentId, sessionId) {
    return this.setCurrentRun(agentId, sessionId, null);
  }
}
