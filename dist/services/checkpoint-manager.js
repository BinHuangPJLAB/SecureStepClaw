import path from "node:path";

import { StepRollbackError, toStepRollbackError } from "../core/errors.js";
import {
  copyPath,
  nowIso,
  pathExists,
  readJson,
  removePath,
  replacePathWithCopy,
  snapshotEntryName,
  writeJson
} from "../core/utils.js";

export class CheckpointManager {
  constructor({ config, registry, runtimeCursorManager, sequenceStore }) {
    this.config = config;
    this.registry = registry;
    this.runtimeCursorManager = runtimeCursorManager;
    this.sequenceStore = sequenceStore;
  }

  async create(ctx) {
    const checkpointId = await this.sequenceStore.next("ckpt");
    const snapshotRoot = path.join(this.config.checkpointDir, checkpointId);
    const createdAt = nowIso();

    const runtimeState = await this.runtimeCursorManager.ensure(ctx.agentId, ctx.sessionId, {
      activeHeadEntryId: ctx.entryId ?? null,
      currentRunId: ctx.runId ?? null
    });

    const manifest = {
      checkpointId,
      createdAt,
      workspaceEntries: [],
      sessionRuntime: {
        included: true,
        fileName: "runtime-state.json"
      }
    };

    for (const rootPath of this.config.workspaceRoots) {
      const exists = await pathExists(rootPath);
      const snapshotName = snapshotEntryName(rootPath);
      let kind = null;

      if (exists) {
        const snapshotTarget = path.join(snapshotRoot, "workspace", snapshotName);
        kind = await copyPath(rootPath, snapshotTarget);
      }

      manifest.workspaceEntries.push({
        targetPath: rootPath,
        snapshotName,
        existed: exists,
        kind
      });
    }

    await writeJson(path.join(snapshotRoot, "runtime-state.json"), runtimeState);
    await writeJson(path.join(snapshotRoot, "snapshot.json"), manifest);

    const record = {
      checkpointId,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      entryId: ctx.entryId,
      nodeIndex: ctx.nodeIndex,
      toolName: ctx.toolName,
      createdAt,
      snapshotRef: snapshotRoot,
      status: "ready",
      summary: `before tool ${ctx.toolName}`
    };

    await this.registry.add(record);

    const removed = await this.registry.pruneSession(
      ctx.agentId,
      ctx.sessionId,
      this.config.maxCheckpointsPerSession
    );

    for (const item of removed) {
      await this.removeArtifacts(item);
    }

    return record;
  }

  async get(checkpointId) {
    return this.registry.get(checkpointId);
  }

  async list(agentId, sessionId) {
    return this.registry.list(agentId, sessionId);
  }

  async restore(checkpointId, options = {}) {
    const record = await this.registry.get(checkpointId);

    if (!record) {
      throw new StepRollbackError("CHECKPOINT_NOT_FOUND", `Checkpoint '${checkpointId}' was not found.`, {
        checkpointId
      });
    }

    const restoreWorkspace = options.restoreWorkspace ?? true;
    const restoreRuntimeState = options.restoreRuntimeState ?? true;

    await this.registry.update(checkpointId, (current) => {
      current.status = "restoring";
      return current;
    });

    try {
      const manifest = await readJson(path.join(record.snapshotRef, "snapshot.json"), null);

      if (!manifest) {
        throw new StepRollbackError(
          "SNAPSHOT_RESTORE_FAILED",
          `Snapshot manifest for checkpoint '${checkpointId}' is missing.`,
          { checkpointId }
        );
      }

      if (restoreWorkspace) {
        for (const entry of manifest.workspaceEntries) {
          await this.restoreWorkspaceEntry(record.snapshotRef, entry);
        }
      }

      if (restoreRuntimeState && manifest.sessionRuntime?.included) {
        const runtimeState = await readJson(path.join(record.snapshotRef, manifest.sessionRuntime.fileName), null);
        if (runtimeState) {
          await this.runtimeCursorManager.replace(record.agentId, record.sessionId, runtimeState);
        }
      }

      return this.registry.update(checkpointId, (current) => {
        current.status = "restored";
        return current;
      });
    } catch (error) {
      await this.registry.update(checkpointId, (current) => {
        current.status = "failed";
        return current;
      });

      throw toStepRollbackError(error, "SNAPSHOT_RESTORE_FAILED", { checkpointId });
    }
  }

  async restoreWorkspaceEntry(snapshotRoot, entry) {
    if (!entry.existed) {
      await removePath(entry.targetPath);
      return;
    }

    const snapshotPath = path.join(snapshotRoot, "workspace", entry.snapshotName);
    const exists = await pathExists(snapshotPath);

    if (!exists) {
      throw new StepRollbackError(
        "SNAPSHOT_RESTORE_FAILED",
        `Snapshot payload '${entry.snapshotName}' is missing.`,
        entry
      );
    }

    await replacePathWithCopy(snapshotPath, entry.targetPath, entry.kind);
  }

  async removeArtifacts(record) {
    if (!record?.snapshotRef) {
      return;
    }

    await removePath(record.snapshotRef);
  }
}
