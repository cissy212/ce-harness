import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { CeError } from "../core/errors.js";
import { deriveProjectName, sanitizeIssue } from "../core/sanitize.js";
import {
  worktreePath as buildWorktreePath,
  workspacePath as buildWorkspacePath,
} from "../core/paths.js";
import {
  addWorktree,
  branchExists,
  deleteBranch,
  detectBaseBranch,
  isDirty,
  pruneWorktrees,
  removeWorktree,
  resolveRepoRoot,
} from "../core/git.js";
import {
  clearActivePointer,
  readActivePointer,
  removeWorkspaceDir,
  workspaceExistsOnDisk,
  writeActivePointer,
  writeWorkspace,
  type Workspace,
} from "../core/workspace.js";
import { expectedOpenSpecRoot, generateStoreId } from "../core/openspecId.js";
import {
  describeOpenSpecStatus,
  isOpenSpecAvailable,
  isStoreRegistered,
  setupStore,
  storeDoctor,
  unregisterStore,
} from "../core/openspec.js";
import { formatLaunchCommand, launchOpenCode } from "../core/opencode.js";

export interface StartOptions {
  repo: string;
  issue: string;
}

export async function startCommand({ repo, issue }: StartOptions): Promise<void> {
  if (!existsSync(repo)) {
    throw new CeError(
      `Repository path "${repo}" does not exist.`,
      "Check the path and try again.",
    );
  }

  const canonicalRepoPath = await realpath(repo);
  const repoRoot = await resolveRepoRoot(canonicalRepoPath);

  if (await isDirty(repoRoot)) {
    throw new CeError(
      `Repository at "${repoRoot}" has uncommitted or untracked changes.`,
      "Commit, stash, or discard your changes before running `ce start`.",
    );
  }

  const project = deriveProjectName(repoRoot);
  const sanitizedIssue = sanitizeIssue(issue);

  const baseBranch = await detectBaseBranch(repoRoot);
  if (!baseBranch) {
    throw new CeError(
      `Neither "main" nor "master" branch exists in "${repoRoot}".`,
      'Create a "main" or "master" branch in the target repository before running `ce start`.',
    );
  }

  const internalBranch = `ce-harness/${sanitizedIssue}`;
  const worktreePath = buildWorktreePath(project, sanitizedIssue);
  const workspacePath = buildWorkspacePath(project, sanitizedIssue);
  const openSpecStoreId = generateStoreId(project, sanitizedIssue, repoRoot);
  const openSpecRoot = expectedOpenSpecRoot(workspacePath);

  // Fail before creating any persistent resource (worktree, branch,
  // workspace) whenever possible.
  if (!(await isOpenSpecAvailable(repoRoot))) {
    throw new CeError(
      `The "openspec" executable is not installed or could not be run.`,
      "Install OpenSpec (e.g. `npm install -g @fission-ai/openspec`) and ensure it is on your PATH, then try again.",
    );
  }

  const existingActive = await readActivePointer();
  if (existingActive) {
    throw new CeError(
      `A workspace is already active for project "${existingActive.project}", issue "${existingActive.sanitizedIssue}".`,
      "Run `ce cleanup` to finish the active task before starting a new one.",
    );
  }
  if (existsSync(worktreePath)) {
    throw new CeError(
      `Worktree already exists at "${worktreePath}".`,
      "Run `ce cleanup` to remove the existing worktree before starting again.",
    );
  }
  if (workspaceExistsOnDisk(project, sanitizedIssue)) {
    throw new CeError(
      `Workspace already exists at "${workspacePath}".`,
      "Run `ce cleanup` to remove the existing workspace before starting again.",
    );
  }
  if (await branchExists(repoRoot, internalBranch)) {
    throw new CeError(
      `Branch "${internalBranch}" already exists in "${repoRoot}".`,
      `Delete the branch (git -C "${repoRoot}" branch -D ${internalBranch}) or run \`ce cleanup\`, then try again.`,
    );
  }
  if (await isStoreRegistered(repoRoot, openSpecStoreId)) {
    throw new CeError(
      `OpenSpec store "${openSpecStoreId}" is already registered.`,
      `Run \`openspec store unregister ${openSpecStoreId}\` first if this store is stale, then try again.`,
    );
  }

  let worktreeCreated = false;
  let workspaceDirCreated = false;
  let storeRegistered = false;
  let activePointerWritten = false;

  try {
    await mkdir(dirname(worktreePath), { recursive: true });
    await addWorktree(repoRoot, worktreePath, internalBranch, baseBranch);
    worktreeCreated = true;

    await mkdir(workspacePath, { recursive: true });
    workspaceDirCreated = true;

    const setupResult = await setupStore(workspacePath, openSpecStoreId, openSpecRoot);
    if (!setupResult.success) {
      throw new CeError(
        `Failed to create and register OpenSpec store "${openSpecStoreId}": ${describeOpenSpecStatus(setupResult.status, setupResult.stderr)}`,
      );
    }
    storeRegistered = true;

    const doctorResult = await storeDoctor(workspacePath, openSpecStoreId);
    if (!doctorResult.found || !doctorResult.healthy) {
      throw new CeError(
        `OpenSpec store "${openSpecStoreId}" failed its health check: ${describeOpenSpecStatus(doctorResult.status, doctorResult.stderr)}`,
      );
    }

    const workspace: Workspace = {
      project,
      repositoryPath: repoRoot,
      issue,
      sanitizedIssue,
      baseBranch,
      internalBranch,
      worktreePath,
      workspacePath,
      createdAt: new Date().toISOString(),
      openSpec: {
        storeId: openSpecStoreId,
        root: openSpecRoot,
      },
    };
    await writeWorkspace(workspace);

    await writeActivePointer({ project, sanitizedIssue });
    activePointerWritten = true;
  } catch (error) {
    await rollback({
      repoRoot,
      worktreePath,
      internalBranch,
      project,
      sanitizedIssue,
      workspacePath,
      openSpecStoreId,
      worktreeCreated,
      workspaceDirCreated,
      storeRegistered,
      activePointerWritten,
    });
    throw error;
  }

  console.log(`Workspace ready for project "${project}", issue "${issue}".`);
  console.log(`OpenSpec store: ${openSpecStoreId}`);
  console.log("");
  console.log(`Launching OpenCode in "${worktreePath}"...`);

  // Everything the workspace needs (worktree, workspace dir, OpenSpec
  // store, workspace.yml, active pointer) is fully created and committed
  // at this point. A failure to launch OpenCode from here on must never
  // roll any of that back.
  const openCodeEnv = {
    CE_WORKSPACE: workspacePath,
    CE_WORKTREE: worktreePath,
    CE_PROJECT: project,
    CE_ISSUE: issue,
    CE_OPENSPEC_STORE: openSpecStoreId,
  };
  const launchResult = await launchOpenCode({ cwd: worktreePath, env: openCodeEnv });
  if (!launchResult.launched) {
    throw new CeError(
      `Failed to launch OpenCode: ${launchResult.message}`,
      `The workspace was created successfully; enter it manually with:\n  ${formatLaunchCommand(worktreePath, openCodeEnv)}`,
    );
  }

  process.exitCode = launchResult.exitCode;
}

interface RollbackContext {
  repoRoot: string;
  worktreePath: string;
  internalBranch: string;
  project: string;
  sanitizedIssue: string;
  workspacePath: string;
  openSpecStoreId: string;
  worktreeCreated: boolean;
  workspaceDirCreated: boolean;
  storeRegistered: boolean;
  activePointerWritten: boolean;
}

async function rollback(ctx: RollbackContext): Promise<void> {
  const rollbackErrors: string[] = [];
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      rollbackErrors.push(`${label}: ${(error as Error).message}`);
    }
  };

  if (ctx.activePointerWritten) {
    await attempt("clear active pointer", () => clearActivePointer());
  }
  if (ctx.storeRegistered) {
    await attempt("unregister OpenSpec store", async () => {
      const result = await unregisterStore(ctx.workspacePath, ctx.openSpecStoreId);
      if (!result.success && !result.notFound) {
        throw new Error(describeOpenSpecStatus(result.status, result.stderr));
      }
    });
  }
  if (ctx.workspaceDirCreated) {
    await attempt("remove workspace directory", () =>
      removeWorkspaceDir(ctx.project, ctx.sanitizedIssue),
    );
  }
  if (ctx.worktreeCreated) {
    await attempt("remove Git worktree", () => removeWorktree(ctx.repoRoot, ctx.worktreePath, true));
    await attempt("delete internal branch", () => deleteBranch(ctx.repoRoot, ctx.internalBranch));
    await attempt("prune worktree metadata", () => pruneWorktrees(ctx.repoRoot));
  }

  if (rollbackErrors.length > 0) {
    console.error("Warning: cleanup after the failed `ce start` was incomplete:");
    for (const message of rollbackErrors) {
      console.error(`  - ${message}`);
    }
    console.error("Run `ce cleanup --force` to finish removing any leftover resources.");
  }
}
