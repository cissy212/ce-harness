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
  resolveTrustedOpenSpec,
} from "../core/workspace.js";
import {
  describeOpenSpecStatus,
  isOpenSpecAvailable,
  isStoreRegistered,
  unregisterStore,
} from "../core/openspec.js";
import { filterHarnessManagedChanges } from "../core/worktreeArtifacts.js";

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

  // OpenSpec store: unregister before touching any harness-owned files,
  // so a failure here (without --force) refuses cleanup entirely rather
  // than leaving things half torn-down.
  const trustedOpenSpec = resolveTrustedOpenSpec(workspace);
  if (workspace.openSpec && !trustedOpenSpec) {
    console.error(
      "Warning: OpenSpec metadata in workspace.yml does not match this workspace and will be ignored.",
    );
  }

  if (trustedOpenSpec) {
    const available = await isOpenSpecAvailable(workspace.workspacePath);
    if (!available) {
      if (!force) {
        throw new CeError(
          `Cannot verify or unregister OpenSpec store "${trustedOpenSpec.storeId}" because the "openspec" executable is not available.`,
          "Install or restore the openspec executable, or re-run with `ce cleanup --force` to remove harness-owned files anyway.",
        );
      }
      console.error(
        `Warning: proceeding without unregistering OpenSpec store "${trustedOpenSpec.storeId}" because the "openspec" executable is not available.`,
      );
    } else {
      // Idempotent: if the store was already manually unregistered (or
      // its root manually deleted), there is nothing left to do here.
      const registered = await isStoreRegistered(workspace.workspacePath, trustedOpenSpec.storeId);
      if (registered) {
        const result = await unregisterStore(workspace.workspacePath, trustedOpenSpec.storeId);
        if (!result.success && !result.notFound) {
          const detail = describeOpenSpecStatus(result.status, result.stderr);
          if (!force) {
            throw new CeError(
              `Failed to unregister OpenSpec store "${trustedOpenSpec.storeId}": ${detail}`,
              "Re-run with `ce cleanup --force` to remove harness-owned files anyway.",
            );
          }
          console.error(
            `Warning: failed to unregister OpenSpec store "${trustedOpenSpec.storeId}": ${detail}`,
          );
        }
      }
    }
  }

  // Git's own `worktree remove` refuses whenever *any* untracked or
  // modified file is present -- including a harmless, harness-managed
  // artifact like a CodeGraph index -- unless `--force` is passed at the
  // git level. `effectiveGitForce` auto-elevates only that git-level
  // call, and only in the one case already proven safe by the check
  // above: every raw change is accounted for by harness-managed
  // artifacts. It is never set just because the user's own `--force`
  // flag is absent, and a real, significant change always still requires
  // the user to pass `--force` themselves (the throw above already
  // guards that).
  let effectiveGitForce = force;
  if (existsSync(workspace.worktreePath)) {
    const changes = await statusPorcelain(workspace.worktreePath);
    // Excludes only entries proven, via cross-checked workspace metadata,
    // to be a harness-managed ephemeral artifact (e.g. a CodeGraph index
    // ce-harness itself provisioned inside this worktree) -- never a
    // by-name exclusion, and never anything that could hide a real
    // tracked-file change from this safety gate.
    const significantChanges = filterHarnessManagedChanges(changes, workspace);
    if (significantChanges.length > 0 && !force) {
      throw new CeError(
        `Worktree at "${workspace.worktreePath}" has ${significantChanges.length} tracked or untracked change(s).`,
        "Re-run with `ce cleanup --force` to discard these changes, or commit/copy them out first.",
      );
    }
    if (changes.length > 0 && significantChanges.length === 0) {
      effectiveGitForce = true;
    }
  }

  if (existsSync(workspace.worktreePath)) {
    await removeWorktree(workspace.repositoryPath, workspace.worktreePath, effectiveGitForce);
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
