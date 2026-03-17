import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { StepRollbackError, toStepRollbackError } from "../core/errors.js";
import {
  copyPath,
  ensureDir,
  nowIso,
  pathExists,
  readJson,
  removePath,
  replacePathWithCopy,
  snapshotEntryName,
  writeJson
} from "../core/utils.js";

const execFileAsync = promisify(execFile);

export class CheckpointManager {
  constructor({ config, registry, runtimeCursorManager, sequenceStore, logger }) {
    this.config = config;
    this.registry = registry;
    this.runtimeCursorManager = runtimeCursorManager;
    this.sequenceStore = sequenceStore;
    this.logger = logger ?? {
      info() {},
      warn() {},
      error() {},
      debug() {}
    };
  }

  async create(ctx) {
    const checkpointId = await this.sequenceStore.next("ckpt");
    const snapshotRoot = path.join(this.config.checkpointDir, checkpointId);
    const createdAt = nowIso();
    this.logger.info(
      `[step-rollback] checkpoint create start checkpoint='${checkpointId}' session='${ctx.sessionId}' tool='${ctx.toolName}'`
    );

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
      manifest.workspaceEntries.push(
        await this.createWorkspaceSnapshotEntry(snapshotRoot, checkpointId, ctx, rootPath)
      );
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
      workspaceSnapshots: manifest.workspaceEntries.map((entry) => ({
        targetPath: entry.targetPath,
        existed: entry.existed,
        kind: entry.kind,
        backend: entry.backend,
        snapshotName: entry.snapshotName ?? null,
        repoDir: entry.repoDir ?? null,
        commitId: entry.commitId ?? null
      })),
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

    this.logger.info(
      `[step-rollback] checkpoint create complete checkpoint='${checkpointId}' session='${ctx.sessionId}' snapshotRef='${snapshotRoot}'`
    );

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

    this.logger.info(`[step-rollback] checkpoint restore start checkpoint='${checkpointId}'`);

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
      this.logger.error(
        `[step-rollback] checkpoint restore failed checkpoint='${checkpointId}': ${error instanceof Error ? error.message : error}`
      );
      await this.registry.update(checkpointId, (current) => {
        current.status = "failed";
        return current;
      });

      throw toStepRollbackError(error, "SNAPSHOT_RESTORE_FAILED", { checkpointId });
    }
  }

  async restoreWorkspaceEntry(snapshotRoot, entry) {
    if (entry.backend === "git") {
      await this.restoreGitWorkspaceEntry(entry);
      return;
    }

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

  async createWorkspaceSnapshotEntry(snapshotRoot, checkpointId, ctx, rootPath) {
    const exists = await pathExists(rootPath);

    if (!exists) {
      this.logger.warn(
        `[step-rollback] workspace root '${rootPath}' did not exist while creating checkpoint '${checkpointId}'`
      );
      return {
        backend: "git",
        targetPath: rootPath,
        existed: false,
        kind: null,
        repoDir: this.gitRepoDir(rootPath),
        commitId: null
      };
    }

    const stats = await fs.lstat(rootPath);

    if (stats.isDirectory()) {
      const repoDir = this.gitRepoDir(rootPath);
      const commitId = await this.captureGitSnapshot(repoDir, rootPath, checkpointId, ctx.toolName);
      this.logger.info(
        `[step-rollback] git snapshot committed checkpoint='${checkpointId}' root='${rootPath}' commit='${commitId}' repo='${repoDir}'`
      );

      return {
        backend: "git",
        targetPath: rootPath,
        existed: true,
        kind: "directory",
        repoDir,
        commitId
      };
    }

    const snapshotName = snapshotEntryName(rootPath);
    const snapshotTarget = path.join(snapshotRoot, "workspace", snapshotName);
    const kind = await copyPath(rootPath, snapshotTarget);
    this.logger.info(
      `[step-rollback] copied snapshot checkpoint='${checkpointId}' target='${rootPath}' kind='${kind}'`
    );

    return {
      backend: "copy",
      targetPath: rootPath,
      snapshotName,
      existed: true,
      kind
    };
  }

  gitRepoDir(rootPath) {
    return path.join(this.config.checkpointDir, "_git", `${snapshotEntryName(rootPath)}.git`);
  }

  async captureGitSnapshot(repoDir, rootPath, checkpointId, toolName) {
    await this.ensureGitRepository(repoDir);

    await this.runGit(
      [
        "--git-dir",
        repoDir,
        "--work-tree",
        rootPath,
        "add",
        "-A",
        "-f",
        "--",
        "."
      ],
      { cwd: rootPath }
    );

    await this.runGit(
      [
        "--git-dir",
        repoDir,
        "--work-tree",
        rootPath,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=OpenClaw Step Rollback",
        "-c",
        "user.email=step-rollback@openclaw.local",
        "commit",
        "--allow-empty",
        "-m",
        `checkpoint ${checkpointId} before tool ${toolName}`
      ],
      { cwd: rootPath }
    );

    const { stdout } = await this.runGit(["--git-dir", repoDir, "rev-parse", "HEAD"], { cwd: rootPath });
    return stdout.trim();
  }

  async restoreGitWorkspaceEntry(entry) {
    if (!entry.existed) {
      await removePath(entry.targetPath);
      return;
    }

    if (!entry.commitId || !entry.repoDir) {
      throw new StepRollbackError(
        "SNAPSHOT_RESTORE_FAILED",
        `Git snapshot metadata is missing for '${entry.targetPath}'.`,
        entry
      );
    }

    const repoExists = await pathExists(entry.repoDir);
    if (!repoExists) {
      throw new StepRollbackError(
        "SNAPSHOT_RESTORE_FAILED",
        `Git snapshot repository '${entry.repoDir}' is missing.`,
        entry
      );
    }

    await removePath(entry.targetPath);
    await ensureDir(entry.targetPath);

    const archivePath = path.join(os.tmpdir(), `step-rollback-${path.basename(entry.repoDir)}-${Date.now()}.tar`);

    try {
      await this.runGit(
        ["--git-dir", entry.repoDir, "archive", "--format=tar", "-o", archivePath, entry.commitId],
        { cwd: entry.targetPath }
      );
      await execFileAsync("tar", ["-xf", archivePath, "-C", entry.targetPath], {
        cwd: entry.targetPath
      });
    } finally {
      await removePath(archivePath);
    }
  }

  async ensureGitRepository(repoDir) {
    const headPath = path.join(repoDir, "HEAD");
    if (await pathExists(headPath)) {
      return;
    }

    await ensureDir(path.dirname(repoDir));
    this.logger.info(`[step-rollback] initializing snapshot git repository '${repoDir}'`);
    await this.runGit(["init", "--bare", repoDir], {
      cwd: path.dirname(repoDir)
    });
  }

  async runGit(args, options = {}) {
    try {
      return await execFileAsync("git", args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "OpenClaw Step Rollback",
          GIT_AUTHOR_EMAIL: "step-rollback@openclaw.local",
          GIT_COMMITTER_NAME: "OpenClaw Step Rollback",
          GIT_COMMITTER_EMAIL: "step-rollback@openclaw.local"
        },
        maxBuffer: 16 * 1024 * 1024
      });
    } catch (error) {
      throw new StepRollbackError(
        "SNAPSHOT_RESTORE_FAILED",
        error instanceof Error ? error.message : String(error),
        { args, cwd: options.cwd }
      );
    }
  }

  async removeArtifacts(record) {
    if (!record?.snapshotRef) {
      return;
    }

    await removePath(record.snapshotRef);
  }
}
