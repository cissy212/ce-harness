import { existsSync } from "node:fs";
import { join } from "node:path";
import { CeError } from "../core/errors.js";
import {
  assertInsideHarnessHome,
  canonicalCwd,
  isPathInside,
  removeEmptyProjectDir,
  resolveCanonical,
  worktreesRoot,
  workspacesRoot,
} from "../core/paths.js";
import {
  deleteBranch,
  pruneWorktrees,
  removeWorktree,
  statusPorcelain,
} from "../core/git.js";
import {
  clearActivePointer,
  readActivePointer,
  readWorkspace,
  removeWorkspaceDir,
} from "../core/workspace.js";

export interface CleanupOptions {
  force?: boolean;
}

export async function cleanupCommand({ force = false }: CleanupOptions): Promise<void> {
  const pointer = await readActivePointer();
  if (!pointer) {
    console.log("No active workspace to clean up.");
    return;
  }

  const workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);

  // Safety: every path we delete must live inside the harness runtime root.
  await assertInsideHarnessHome(workspace.worktreePath);
  await assertInsideHarnessHome(workspace.workspacePath);

  // Refuse (even with --force) if the shell running this command is
  // sitting inside the worktree we're about to delete: removing it out
  // from under the current process leaves the shell in a dead directory
  // and causes getcwd/pyenv-style errors.
  if (existsSync(workspace.worktreePath)) {
    const canonicalWorktree = await resolveCanonical(workspace.worktreePath);
    const cwd = await canonicalCwd();
    if (isPathInside(cwd, canonicalWorktree)) {
      throw new CeError(
        `The current directory is inside the worktree being cleaned up ("${workspace.worktreePath}").`,
        `Run \`cd "${workspace.repositoryPath}"\` (or anywhere outside the worktree) and then re-run \`ce cleanup\`.`,
      );
    }
  }

  if (existsSync(workspace.worktreePath)) {
    const changes = await statusPorcelain(workspace.worktreePath);
    if (changes.length > 0 && !force) {
      throw new CeError(
        `Worktree at "${workspace.worktreePath}" has ${changes.length} tracked or untracked change(s).`,
        "Re-run with `ce cleanup --force` to discard these changes, or commit/copy them out first.",
      );
    }
  }

  if (existsSync(workspace.worktreePath)) {
    await removeWorktree(workspace.repositoryPath, workspace.worktreePath, force);
  }

  await deleteBranch(workspace.repositoryPath, workspace.internalBranch);
  await removeWorkspaceDir(workspace.project, workspace.sanitizedIssue);
  await clearActivePointer();
  await pruneWorktrees(workspace.repositoryPath);

  // Tidy up now-empty project-level directories, but never the top-level
  // worktrees/workspaces/state roots themselves.
  await removeEmptyProjectDir(join(worktreesRoot(), workspace.project));
  await removeEmptyProjectDir(join(workspacesRoot(), workspace.project));

  console.log(
    `Cleaned up workspace for project "${workspace.project}", issue "${workspace.issue}".`,
  );
}
