import { existsSync } from "node:fs";
import { CeError } from "../core/errors.js";
import { parseWorkspaceSelector } from "../core/sanitize.js";
import {
  describeAvailableWorkspaces,
  readActivePointer,
  readWorkspace,
  resolveTrustedOpenSpec,
  workspaceExistsOnDisk,
  writeActivePointer,
  type ActivePointer,
  type Workspace,
} from "../core/workspace.js";
import { buildLaunchEnv } from "../core/launchEnv.js";
import { resolveRunner } from "../core/runners/index.js";
import { presentAndLaunch } from "../core/workspacePresenter.js";

export interface ResumeOptions {
  /**
   * `<project>/<issue>` selector (see `ce status`), e.g.
   * `"market-audit-tool/130"`, to resume a specific workspace instead
   * of the current default. Once resolved, this becomes the new
   * default -- explicitly resuming a workspace means "work on this
   * now," so a later bare `ce resume`/`ce status`/etc. continues here,
   * not wherever the default pointed before.
   */
  workspace?: string;
}

/**
 * Re-enters a workspace -- the one given by `options.workspace`
 * (`<project>/<issue>`), or the current default if omitted -- by
 * relaunching the same runner `ce start` used (see `workspace.runner`,
 * resolved via core/runners/index.js) with exactly the same
 * environment. Never creates, registers, or initializes a workspace;
 * only ever mutates the active-default pointer (see
 * core/workspace.ts's `ActivePointer` doc comment), never
 * `workspace.yml` itself.
 *
 * Exists so that resuming a session after the runner exits -- or
 * switching which of several preserved workspaces you're working on --
 * is a normal, one-command workflow instead of the user having to
 * reconstruct the long environment-variable launch command by hand.
 */
export async function resumeCommand(options: ResumeOptions = {}): Promise<void> {
  const pointer: ActivePointer | null = options.workspace
    ? parseWorkspaceSelector(options.workspace)
    : await readActivePointer();

  if (!pointer) {
    throw new CeError(
      "No active workspace.",
      ["Start one with:", "", "  ce start <repo> <issue>"].join("\n"),
    );
  }

  if (options.workspace && !workspaceExistsOnDisk(pointer.project, pointer.sanitizedIssue)) {
    throw new CeError(
      `No workspace found for "${pointer.project}/${pointer.sanitizedIssue}".`,
      await describeAvailableWorkspaces(),
    );
  }

  // Never repairs anything found to be wrong here -- only ever reports it
  // and points at `ce cleanup --force`, exactly like every other read
  // this command performs. `readWorkspace` itself already covers a
  // missing/corrupt workspace.yml (which also covers a deleted workspace
  // directory, since workspace.yml lives inside it) -- re-thrown here with
  // the recorded project/issue for context, since the underlying error
  // can't know those once the file it would read them from is gone.
  let workspace: Workspace;
  try {
    workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);
  } catch (error) {
    const detail = error instanceof CeError ? error.message : (error as Error).message;
    throw new CeError(
      `Cannot resume workspace for project "${pointer.project}", issue "${pointer.sanitizedIssue}" -- its metadata could not be read: ${detail}`,
      `Run \`ce cleanup --force ${pointer.project}/${pointer.sanitizedIssue}\` to discard this workspace, then \`ce start\` again.`,
    );
  }

  const problems: string[] = [];
  if (!existsSync(workspace.worktreePath)) {
    problems.push(`Worktree not found at "${workspace.worktreePath}".`);
  }
  if (workspace.openSpec && !resolveTrustedOpenSpec(workspace)) {
    problems.push(
      "OpenSpec metadata in workspace.yml does not match what ce-harness would itself " +
        `generate for project "${workspace.project}", issue "${workspace.sanitizedIssue}" -- ` +
        "the workspace metadata may be corrupt or tampered.",
    );
  }

  if (problems.length > 0) {
    throw new CeError(
      [
        `Cannot resume workspace for project "${workspace.project}", issue "${workspace.sanitizedIssue}" -- it is no longer valid:`,
        "",
        ...problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
      `Run \`ce cleanup --force ${workspace.project}/${workspace.sanitizedIssue}\` to discard this workspace, then \`ce start\` again.`,
    );
  }

  const runner = resolveRunner(workspace.runner);

  // Only now that the workspace is confirmed to exist and be valid --
  // resolving successfully is what "work on this now" means here.
  // Resuming the already-default workspace (no selector, or a selector
  // matching it) is a harmless no-op overwrite of the same value.
  await writeActivePointer({ project: workspace.project, sanitizedIssue: workspace.sanitizedIssue });

  console.log(
    `Resuming workspace for project "${workspace.project}", issue "${workspace.issue}".`,
  );

  // Built by the exact same helper `ce start` uses, from the workspace
  // metadata already on disk -- never rebuilt or reconstructed here.
  const launchEnv = buildLaunchEnv(workspace);
  await presentAndLaunch({
    repoPath: workspace.repositoryPath,
    worktreePath: workspace.worktreePath,
    runner,
    launchEnv,
    launchFailureRecoveryIntro: "Enter the workspace manually with:",
    project: workspace.project,
    issue: workspace.issue,
  });
}
