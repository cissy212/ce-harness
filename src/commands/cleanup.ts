import { existsSync } from "node:fs";
import { CeError } from "../core/errors.js";
import { assertInsideHarnessHome } from "../core/paths.js";
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

  console.log(
    `Cleaned up workspace for project "${workspace.project}", issue "${workspace.issue}".`,
  );
}
