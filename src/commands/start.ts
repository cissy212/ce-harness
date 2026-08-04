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

  let worktreeCreated = false;
  let workspaceDirCreated = false;
  let activePointerWritten = false;

  try {
    await mkdir(dirname(worktreePath), { recursive: true });
    await addWorktree(repoRoot, worktreePath, internalBranch, baseBranch);
    worktreeCreated = true;

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
    };
    await writeWorkspace(workspace);
    workspaceDirCreated = true;

    await writeActivePointer({ project, sanitizedIssue });
    activePointerWritten = true;
  } catch (error) {
    await rollback({
      repoRoot,
      worktreePath,
      internalBranch,
      project,
      sanitizedIssue,
      worktreeCreated,
      workspaceDirCreated,
      activePointerWritten,
    });
    throw error;
  }

  console.log(`Workspace ready for project "${project}", issue "${issue}".`);
  console.log("");
  console.log("Next step:");
  console.log(`  cd "${worktreePath}" && opencode`);
}

interface RollbackContext {
  repoRoot: string;
  worktreePath: string;
  internalBranch: string;
  project: string;
  sanitizedIssue: string;
  worktreeCreated: boolean;
  workspaceDirCreated: boolean;
  activePointerWritten: boolean;
}

async function rollback(ctx: RollbackContext): Promise<void> {
  if (ctx.activePointerWritten) {
    await clearActivePointer().catch(() => undefined);
  }
  if (ctx.workspaceDirCreated) {
    await removeWorkspaceDir(ctx.project, ctx.sanitizedIssue).catch(() => undefined);
  }
  if (ctx.worktreeCreated) {
    await removeWorktree(ctx.repoRoot, ctx.worktreePath, true).catch(() => undefined);
    await deleteBranch(ctx.repoRoot, ctx.internalBranch).catch(() => undefined);
  }
}
