import { existsSync } from "node:fs";
import { CeError } from "../core/errors.js";
import { readActivePointer, readWorkspace, resolveTrustedOpenSpec, type Workspace } from "../core/workspace.js";
import { buildLaunchEnv } from "../core/launchEnv.js";
import { resolveRunner } from "../core/runners/index.js";

/**
 * Re-enters the currently active workspace by relaunching the same
 * runner `ce start` used (see `workspace.runner`, resolved via
 * core/runners/index.js) with exactly the same environment -- without
 * creating, registering, or initializing anything. Purely "re-enter the
 * existing workspace": no worktree, workspace, OpenSpec store, or
 * CodeGraph index is created, and workspace.yml is never modified.
 *
 * Exists so that resuming a session after the runner exits is a normal,
 * one-command workflow instead of the user having to reconstruct the
 * long environment-variable launch command themselves.
 */
export async function resumeCommand(): Promise<void> {
  const pointer = await readActivePointer();
  if (!pointer) {
    throw new CeError(
      "No active workspace.",
      ["Start one with:", "", "  ce start <repo> <issue>"].join("\n"),
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
      "Run `ce cleanup --force` to discard this workspace, then `ce start` again.",
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
      "Run `ce cleanup --force` to discard this workspace, then `ce start` again.",
    );
  }

  const runner = resolveRunner(workspace.runner);

  console.log(
    `Resuming workspace for project "${workspace.project}", issue "${workspace.issue}".`,
  );
  console.log(`Launching ${runner.label} in "${workspace.worktreePath}"...`);

  // Built by the exact same helper `ce start` uses, from the workspace
  // metadata already on disk -- never rebuilt or reconstructed here.
  const launchEnv = buildLaunchEnv(workspace);
  const launchResult = await runner.launch({ cwd: workspace.worktreePath, env: launchEnv });
  if (!launchResult.launched) {
    throw new CeError(
      `Failed to launch ${runner.label}: ${launchResult.message}`,
      `Enter the workspace manually with:\n  ${runner.formatLaunchCommand(workspace.worktreePath, launchEnv)}`,
    );
  }

  process.exitCode = launchResult.exitCode;
}
