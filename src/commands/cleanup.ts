import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
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
  isRegisteredWorktree,
  pruneWorktrees,
  removeWorktree,
  statusPorcelain,
} from "../core/git.js";
import { parseWorkspaceSelector } from "../core/sanitize.js";
import {
  clearActivePointer,
  describeAvailableWorkspaces,
  readActivePointer,
  readWorkspace,
  removeWorkspaceDir,
  resolveTrustedOpenSpec,
  workspaceExistsOnDisk,
  type ActivePointer,
} from "../core/workspace.js";
import {
  describeOpenSpecStatus,
  isOpenSpecAvailable,
  isStoreRegistered,
  unregisterStore,
} from "../core/openspec.js";
import { filterHarnessManagedChanges } from "../core/worktreeArtifacts.js";
import { findRunningContainersMountingPath } from "../core/docker.js";

export interface CleanupOptions {
  force?: boolean;
  /**
   * `<project>/<issue>` selector (see `ce status`) to remove a specific
   * workspace instead of the current default. The active-default
   * pointer is only ever cleared if the workspace removed is the one it
   * currently points at -- cleaning up a non-default workspace never
   * disturbs which one is default (see core/workspace.ts's
   * `ActivePointer` doc comment).
   */
  workspace?: string;
}

export async function cleanupCommand({ force = false, workspace: selector }: CleanupOptions): Promise<void> {
  const pointer: ActivePointer | null = selector
    ? parseWorkspaceSelector(selector)
    : await readActivePointer();

  if (!pointer) {
    console.log("No active workspace to clean up.");
    console.log(await describeAvailableWorkspaces());
    return;
  }

  if (selector && !workspaceExistsOnDisk(pointer.project, pointer.sanitizedIssue)) {
    throw new CeError(
      `No workspace found for "${pointer.project}/${pointer.sanitizedIssue}".`,
      await describeAvailableWorkspaces(),
    );
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

  // A running container with a bind mount inside this worktree can make
  // `git worktree remove`'s recursive delete fail partway through
  // (macOS/Docker Desktop protects the host-side mount point for as
  // long as a container holds it), which can leave Git's own worktree
  // registration removed while the physical directory survives --
  // exactly the state that leaves `ce cleanup` and `ce status` stuck.
  // Checked here, before any state (OpenSpec registration, Git, or
  // workspace files) is touched, so a blocker is reported cleanly with
  // nothing mutated -- never a silent `docker stop` on the user's
  // behalf, and never gated on `--force` (force only ever means "discard
  // uncommitted changes," never "ignore an OS-level mount"). Never
  // repository/application-specific: this knows nothing about Docker
  // Compose projects or service names, only "is any running container's
  // bind-mount source at or inside this exact path."
  if (existsSync(workspace.worktreePath)) {
    const blockers = await findRunningContainersMountingPath(workspace.worktreePath);
    if (blockers.length > 0) {
      const names = [...new Set(blockers.map((b) => b.name))];
      throw new CeError(
        `Cannot clean up: ${names.length} running Docker container(s) still have a bind mount ` +
          `inside the worktree at "${workspace.worktreePath}": ${blockers
            .map((b) => `"${b.name}" (${b.source})`)
            .join(", ")}.`,
        `Stop the container(s) first (e.g. \`docker stop ${names.join(" ")}\`), then re-run \`ce cleanup\`.`,
      );
    }
  }

  // OpenSpec store: unregister before touching any harness-owned files,
  // so a failure here (without --force) refuses cleanup entirely rather
  // than leaving things half torn-down. A *durable*, project-scoped store
  // (see resolveTrustedOpenSpec/openspecId.ts) is never unregistered or
  // touched here at all -- it lives outside workspacesRoot()/
  // worktreesRoot() entirely (see core/paths.ts's openspecRoot()), so the
  // removeWorkspaceDir() call further down structurally cannot reach it
  // regardless of this branch. Only a legacy, per-workspace store (created
  // before durable storage existed) is still unregistered here, exactly
  // as before.
  const trustedOpenSpec = resolveTrustedOpenSpec(workspace);
  if (workspace.openSpec && !trustedOpenSpec) {
    console.error(
      "Warning: OpenSpec metadata in workspace.yml does not match this workspace and will be ignored.",
    );
  }

  if (trustedOpenSpec?.durable) {
    console.log(
      `OpenSpec store "${trustedOpenSpec.storeId}" is this project's durable store (${trustedOpenSpec.root}) -- left registered and untouched.`,
    );
  }

  if (trustedOpenSpec && !trustedOpenSpec.durable) {
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
          const detail = describeOpenSpecStatus(result);
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

  if (existsSync(workspace.worktreePath)) {
    // `existsSync` alone is never proof this is still a usable Git
    // worktree: a *previous* `ce cleanup`/`git worktree remove` attempt
    // can already have deregistered it while its directory survived
    // (see `recoverFromWorktreeRemovalFailure` below) -- in which case
    // this run's own `git status` (below) would fail outright (it is
    // not a Git repository anymore), exactly the crash this same check
    // fixes in `ce status`. Checked once, up front, so this run never
    // even attempts a `git` operation against an already-orphaned
    // directory.
    const worktreeRegistered = await isRegisteredWorktree(workspace.repositoryPath, workspace.worktreePath);

    if (!worktreeRegistered) {
      // Nothing left to remove "as a worktree", and no `git status` to
      // safely consult -- go straight to the same plain-filesystem
      // recovery a fresh removal failure below would use.
      await finishOrphanedWorktreeRemoval(workspace.worktreePath, force);
    } else {
      // Git's own `worktree remove` refuses whenever *any* untracked or
      // modified file is present -- including a harmless, harness-managed
      // artifact like a CodeGraph index -- unless `--force` is passed at
      // the git level. `effectiveGitForce` auto-elevates only that
      // git-level call, and only in the one case already proven safe by
      // the check below: every raw change is accounted for by
      // harness-managed artifacts. It is never set just because the
      // user's own `--force` flag is absent, and a real, significant
      // change always still requires the user to pass `--force`
      // themselves (the throw below already guards that).
      let effectiveGitForce = force;
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

      try {
        await removeWorktree(workspace.repositoryPath, workspace.worktreePath, effectiveGitForce);
      } catch (error) {
        await recoverFromWorktreeRemovalFailure(
          workspace.repositoryPath,
          workspace.worktreePath,
          force,
          error,
        );
      }
    }
  }

  await deleteBranch(workspace.repositoryPath, workspace.internalBranch);
  await removeWorkspaceDir(workspace.project, workspace.sanitizedIssue);

  // Only clear the default pointer if the workspace just removed is the
  // one it currently points at -- read fresh (never reuse the `pointer`
  // resolved above, which came from `selector` when one was given, not
  // necessarily from the actual current default) so cleaning up a
  // non-default workspace never disturbs an unrelated default.
  const currentDefault = await readActivePointer();
  if (
    currentDefault &&
    currentDefault.project === workspace.project &&
    currentDefault.sanitizedIssue === workspace.sanitizedIssue
  ) {
    await clearActivePointer();
  }
  await pruneWorktrees(workspace.repositoryPath);

  // Tidy up now-empty project-level directories, but never the top-level
  // worktrees/workspaces/state roots themselves.
  await removeEmptyProjectDir(join(worktreesRoot(), workspace.project));
  await removeEmptyProjectDir(join(workspacesRoot(), workspace.project));

  console.log(
    `Cleaned up workspace for project "${workspace.project}", issue "${workspace.issue}".`,
  );
}

/**
 * Decides what to do after `git worktree remove` has thrown `originalError`
 * for `worktreePath` inside `repoPath`. `git worktree remove` failing does
 * not mean nothing changed: on `--force`, Git can remove its own
 * worktree-registration bookkeeping before (or regardless of whether) it
 * manages to finish the recursive filesystem delete, so the two can end up
 * disagreeing. Re-checks the actual, current registration state rather
 * than assuming either "fully failed" or "fully succeeded" from the
 * exit code alone.
 *
 * - Still registered: genuinely failed, nothing torn down. Rethrows
 *   `originalError` unchanged, preserving branch/workspace metadata/the
 *   active pointer exactly as before this call -- cleanup must never
 *   pretend to have made progress it didn't.
 * - No longer registered: a partial removal. Delegates to
 *   `finishOrphanedWorktreeRemoval`, which recovers what it safely can.
 *
 * Exported (and taking the already-thrown error as a plain parameter,
 * not re-deriving it) specifically so this decision can be tested
 * deterministically against a real, cheaply-constructed registration
 * state, without needing to reproduce Git's own exact partial-failure
 * behavior under a real permission/mount obstruction.
 */
export async function recoverFromWorktreeRemovalFailure(
  repoPath: string,
  worktreePath: string,
  force: boolean,
  originalError: unknown,
): Promise<void> {
  const stillRegistered = await isRegisteredWorktree(repoPath, worktreePath);
  if (stillRegistered) {
    throw originalError;
  }
  // Recoverable, but only ever by finishing a plain filesystem delete
  // ourselves (Git can't remove it *as a worktree* a second time) --
  // and only when it's either already empty of real content, or the
  // user explicitly accepts discarding what's left via --force.
  // Refusing (without --force) leaves the branch/workspace/active-
  // pointer state fully intact, so a later `ce cleanup` (once the
  // blocker is resolved, or with --force) can pick up exactly where
  // this one left off, rather than the workspace becoming permanently
  // unrecoverable just because Git already dropped its own bookkeeping.
  await finishOrphanedWorktreeRemoval(worktreePath, force);
}

/** True if `dir` contains at least one regular file anywhere in its tree (symlinks/dirs don't count). */
async function directoryContainsAnyFile(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.some((entry) => entry.isFile());
}

/**
 * Finishes removing a worktree directory Git no longer registers as a
 * worktree at all (see the caller): since it isn't a worktree anymore,
 * this is a plain filesystem delete, never a Git operation, and never a
 * `git status`-based safety check either (there is no `.git` left to
 * run one against). Refuses -- preserving the directory exactly as-is
 * -- when it still holds real file content and `--force` wasn't given,
 * since there is no way left to verify what that content is. An
 * already-empty directory (just leftover directory scaffolding, no
 * files) is always safe to remove outright, `--force` or not.
 */
async function finishOrphanedWorktreeRemoval(worktreePath: string, force: boolean): Promise<void> {
  const hasFiles = await directoryContainsAnyFile(worktreePath);
  if (hasFiles && !force) {
    throw new CeError(
      `Git no longer registers a worktree at "${worktreePath}" (a previous ce cleanup or ` +
        "git worktree remove likely partially succeeded), but the directory still exists and " +
        "contains file(s) that can no longer be safety-checked via git status -- it is not a " +
        "Git repository anymore.",
      `Inspect "${worktreePath}" yourself, or re-run \`ce cleanup --force\` to remove it outright.`,
    );
  }

  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch (error) {
    throw new CeError(
      `Git no longer registers a worktree at "${worktreePath}", and removing the leftover directory ` +
        `failed: ${(error as Error).message}`,
      "Something outside ce-harness (e.g. a running process, an ACL, or a still-mounted volume) may " +
        "still be holding this path open. Resolve that, then re-run `ce cleanup`.",
    );
  }
}
