import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, nowIso, readJson, removePath, writeJson } from "../core/utils.js";

function sortCheckpoints(checkpoints) {
  return [...checkpoints].sort((left, right) => {
    if (left.nodeIndex !== right.nodeIndex) {
      return left.nodeIndex - right.nodeIndex;
    }

    return left.createdAt.localeCompare(right.createdAt);
  });
}

function timestampValue(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortSessionIndexes(indexes) {
  return [...indexes].sort((left, right) => {
    const createdDelta = timestampValue(left.createdAt) - timestampValue(right.createdAt);

    if (createdDelta !== 0) {
      return createdDelta;
    }

    const updatedDelta = timestampValue(left.updatedAt) - timestampValue(right.updatedAt);

    if (updatedDelta !== 0) {
      return updatedDelta;
    }

    return String(left.sessionId ?? "").localeCompare(String(right.sessionId ?? ""));
  });
}

function sortBranches(branches) {
  return [...branches].sort((left, right) => {
    const createdDelta = timestampValue(left.createdAt) - timestampValue(right.createdAt);

    if (createdDelta !== 0) {
      return createdDelta;
    }

    return String(left.branchId ?? "").localeCompare(String(right.branchId ?? ""));
  });
}

export class CheckpointRegistry {
  constructor({ config }) {
    this.config = config;
  }

  checkpointFile(checkpointId) {
    return path.join(this.config.registryDir, "checkpoints", `${checkpointId}.json`);
  }

  sessionIndexFile(agentId, sessionId) {
    return path.join(this.config.registryDir, "sessions", agentId, `${sessionId}.json`);
  }

  branchFile(branchId) {
    return path.join(this.config.registryDir, "branches", `${branchId}.json`);
  }

  async get(checkpointId) {
    return readJson(this.checkpointFile(checkpointId), null);
  }

  async list(agentId, sessionId) {
    const sessionIndex = await readJson(this.sessionIndexFile(agentId, sessionId), null);
    return sortCheckpoints(sessionIndex?.checkpoints ?? []);
  }

  async listSessionIndexes(agentId = null) {
    const sessionsRoot = path.join(this.config.registryDir, "sessions");
    const requestedAgentId = typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
    const agentIds = [];

    if (requestedAgentId) {
      agentIds.push(requestedAgentId);
    } else {
      try {
        const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            agentIds.push(entry.name);
          }
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return [];
        }

        throw error;
      }
    }

    const indexes = [];

    for (const resolvedAgentId of agentIds) {
      const agentDir = path.join(sessionsRoot, resolvedAgentId);
      let entries;

      try {
        entries = await fs.readdir(agentDir, { withFileTypes: true });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          continue;
        }

        throw error;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        const sessionIndex = await readJson(path.join(agentDir, entry.name), null);

        if (!sessionIndex?.sessionId) {
          continue;
        }

        indexes.push({
          ...sessionIndex,
          agentId: sessionIndex.agentId ?? resolvedAgentId,
          sessionId: sessionIndex.sessionId,
          checkpoints: sortCheckpoints(sessionIndex.checkpoints ?? [])
        });
      }
    }

    return sortSessionIndexes(indexes);
  }

  async add(record) {
    await writeJson(this.checkpointFile(record.checkpointId), record);

    const currentIndex = await readJson(this.sessionIndexFile(record.agentId, record.sessionId), {
      agentId: record.agentId,
      sessionId: record.sessionId,
      createdAt: nowIso(),
      checkpoints: []
    });

    currentIndex.agentId = record.agentId;
    currentIndex.sessionId = record.sessionId;
    currentIndex.updatedAt = nowIso();
    currentIndex.checkpoints = sortCheckpoints([
      ...currentIndex.checkpoints.filter((item) => item.checkpointId !== record.checkpointId),
      record
    ]);

    await writeJson(this.sessionIndexFile(record.agentId, record.sessionId), currentIndex);
    return record;
  }

  async update(checkpointId, updater) {
    const current = await this.get(checkpointId);

    if (!current) {
      return null;
    }

    const nextRecord = updater(structuredClone(current)) ?? structuredClone(current);
    await writeJson(this.checkpointFile(checkpointId), nextRecord);

    const sessionIndex = await readJson(this.sessionIndexFile(current.agentId, current.sessionId), {
      agentId: current.agentId,
      sessionId: current.sessionId,
      checkpoints: []
    });

    sessionIndex.updatedAt = nowIso();
    sessionIndex.checkpoints = sortCheckpoints(
      sessionIndex.checkpoints.map((item) => (item.checkpointId === checkpointId ? nextRecord : item))
    );

    await writeJson(this.sessionIndexFile(current.agentId, current.sessionId), sessionIndex);
    return nextRecord;
  }

  async remove(checkpointId) {
    const current = await this.get(checkpointId);

    if (!current) {
      return null;
    }

    await removePath(this.checkpointFile(checkpointId));

    const sessionIndex = await readJson(this.sessionIndexFile(current.agentId, current.sessionId), {
      agentId: current.agentId,
      sessionId: current.sessionId,
      checkpoints: []
    });

    sessionIndex.updatedAt = nowIso();
    sessionIndex.checkpoints = sessionIndex.checkpoints.filter((item) => item.checkpointId !== checkpointId);
    await writeJson(this.sessionIndexFile(current.agentId, current.sessionId), sessionIndex);

    return current;
  }

  async pruneSession(agentId, sessionId, maxCheckpoints) {
    if (!Number.isFinite(maxCheckpoints) || maxCheckpoints < 1) {
      const checkpoints = await this.list(agentId, sessionId);
      return Promise.all(checkpoints.map((item) => this.remove(item.checkpointId)));
    }

    const checkpoints = await this.list(agentId, sessionId);

    if (checkpoints.length <= maxCheckpoints) {
      return [];
    }

    const staleCheckpoints = checkpoints.slice(0, checkpoints.length - maxCheckpoints);
    const removed = [];

    for (const checkpoint of staleCheckpoints) {
      const deleted = await this.remove(checkpoint.checkpointId);
      if (deleted) {
        removed.push(deleted);
      }
    }

    return removed;
  }

  async listNodes(agentId, sessionId) {
    const checkpoints = await this.list(agentId, sessionId);
    return checkpoints.map((checkpoint) => ({
      entryId: checkpoint.entryId,
      nodeIndex: checkpoint.nodeIndex,
      kind: "checkpoint",
      toolName: checkpoint.toolName,
      createdAt: checkpoint.createdAt,
      checkoutAvailable: checkpoint.status === "ready" || checkpoint.status === "restored"
    }));
  }

  async saveBranch(record) {
    await ensureDir(path.dirname(this.branchFile(record.branchId)));
    await writeJson(this.branchFile(record.branchId), record);
    return record;
  }

  async getBranch(branchId) {
    return readJson(this.branchFile(branchId), null);
  }

  async listBranches() {
    const branchesRoot = path.join(this.config.registryDir, "branches");
    let entries;

    try {
      entries = await fs.readdir(branchesRoot, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }

    const records = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const record = await readJson(path.join(branchesRoot, entry.name), null);

      if (record?.branchId) {
        records.push(record);
      }
    }

    return sortBranches(records);
  }
}
