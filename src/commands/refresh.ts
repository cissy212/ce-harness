import { existsSync } from "node:fs";
import { CeError } from "../core/errors.js";
import { expectedLensesDir, refreshLensesDir } from "../core/lenses.js";
import { readActivePointer, readWorkspace, writeWorkspace } from "../core/workspace.js";
import { resolveRunner } from "../core/runners/index.js";

/**
 * Refreshes the active workspace's harness-managed runner configuration
 * (e.g. Claude Code's `.claude/commands/*.md`) against the harness's
 * *current* template library -- the supported way to bring an
 * already-existing workspace's generated files up to date with a newer
 * ce-harness version, without deleting or recreating the workspace,
 * worktree, or branch, and without touching anything the workspace
 * doesn't itself already own (product files, product Git history, the
 * external OpenSpec store). See `RunnerSpec.refreshConfig` for exactly
 * what "harness-managed" and "safe to overwrite" mean here.
 *
 * Also additively syncs the workspace's canonical, runner-agnostic
 * `lenses/` directory (see `core/lenses.ts`'s `refreshLensesDir`) --
 * unlike the runner-config refresh above, this only ever adds a lens
 * the template library has gained since this workspace was created; it
 * never overwrites or removes anything already there, harness-written or
 * user-added, since there is no hash-tracking scheme for lenses to prove
 * an existing one is still untouched.
 *
 * Deliberately never called automatically by `ce resume` -- see that
 * command's own docstring for why. This is the only command that ever
 * writes worktree-managed config files (or adds to the lenses directory)
 * after `ce start`.
 */
export async function refreshCommand(): Promise<void> {
  const pointer = await readActivePointer();
  if (!pointer) {
    throw new CeError(
      "No active workspace.",
      ["Start one with:", "", "  ce start <repo> <issue>"].join("\n"),
    );
  }

  let workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);

  if (!existsSync(workspace.worktreePath)) {
    throw new CeError(
      `Cannot refresh workspace for project "${workspace.project}", issue "${workspace.sanitizedIssue}" -- its worktree no longer exists at "${workspace.worktreePath}".`,
      "Run `ce cleanup --force` to discard this workspace, then `ce start` again.",
    );
  }

  const runner = resolveRunner(workspace.runner);
  const { result, commandsManaged, commandsManagedHashes } = await runner.refreshConfig(
    { workspacePath: workspace.workspacePath, worktreePath: workspace.worktreePath },
    workspace,
  );
  const lensResult = await refreshLensesDir(workspace.workspacePath);

  workspace = {
    ...workspace,
    runnerWorktreeArtifacts: {
      ...workspace.runnerWorktreeArtifacts,
      commandsManaged,
      commandsManagedHashes,
    },
  };
  await writeWorkspace(workspace);

  console.log(
    `Refreshed ${runner.label} configuration for project "${workspace.project}", issue "${workspace.issue}".`,
  );
  if (result.updated.length > 0) {
    console.log(`  Updated:   ${result.updated.join(", ")}`);
  }
  if (result.unchanged.length > 0) {
    console.log(`  Unchanged: ${result.unchanged.join(", ")}`);
  }
  if (result.skipped.length > 0) {
    console.log(
      `  Skipped (left untouched -- could not be proven to still be ce-harness's own): ${result.skipped.join(", ")}`,
    );
  }
  if (result.updated.length === 0 && result.unchanged.length === 0 && result.skipped.length === 0) {
    console.log("  Nothing to refresh for this runner.");
  }

  console.log("");
  if (lensResult.blockedByNonDirectory) {
    console.log(
      `  Reasoning lenses: could not sync -- "${expectedLensesDir(workspace.workspacePath)}" exists but is not a directory.`,
    );
  } else if (lensResult.written.length > 0) {
    console.log(`  Reasoning lenses added: ${lensResult.written.join(", ")}`);
  } else {
    console.log("  Reasoning lenses: already up to date.");
  }
}
