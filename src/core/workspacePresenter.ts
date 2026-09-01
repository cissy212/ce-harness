import { CeError } from "./errors.js";
import type { RunnerSpec } from "./runners/types.js";
import { isITerm2Available, openTwoPaneWorkspace, parseTabColor } from "./terminal/iterm2.js";
import { resolveTabColor, resolveTerminalLayoutPreference } from "./terminalPreference.js";

export interface PresentAndLaunchOptions {
  /** Absolute path of the target repository, used to resolve the terminal-layout preference and tab color (git config is read against it). */
  repoPath: string;
  /** Absolute path of the worktree to present/launch in. */
  worktreePath: string;
  runner: RunnerSpec;
  launchEnv: Record<string, string>;
  /**
   * First line of the recovery text when the direct-launch fallback
   * itself fails to launch -- `ce start`'s and `ce resume`'s prior
   * direct-launch code paths phrased this differently (a workspace was
   * just created vs. one already existed), so callers supply their own.
   */
  launchFailureRecoveryIntro: string;
  /** `workspace.project` -- the tab/session title's first half, e.g. the `"MAT"` in `"MAT · 130"`. */
  project: string;
  /** `workspace.issue` (the raw, human-readable identifier, not `sanitizedIssue`) -- the tab/session title's second half, e.g. the `"130"` in `"MAT · 130"`. */
  issue: string;
}

/**
 * Prepares the user's working environment for a just-created/resolved
 * workspace, called by `ce start`/`ce resume` in place of a direct
 * `runner.launch(...)` call. Owns *where* the prepared workspace is
 * presented -- a two-pane iTerm2 tab (in the frontmost window if one is
 * open, a new window otherwise -- see core/terminal/iterm2.ts; never a
 * second window per workspace, and never a reused/split existing tab),
 * or today's single-terminal direct launch -- never *how* a runner is
 * invoked, which stays entirely owned by `RunnerSpec` (see
 * core/runners/types.ts).
 *
 * Terminal presentation is convenience, not workspace correctness: by
 * the time this is called the worktree, workspace.yml, and active
 * pointer are already fully created and committed, so nothing here ever
 * rolls any of that back. When the iTerm2 layout can't be attempted or
 * fails for any reason (wrong platform, iTerm2 not installed, Automation
 * permission denied, a scripting error), this falls back to exactly the
 * launch behavior that existed before this feature -- the runner is
 * always left running somewhere by the time this returns successfully.
 */
export async function presentAndLaunch(options: PresentAndLaunchOptions): Promise<void> {
  const { repoPath, worktreePath, runner, launchEnv, launchFailureRecoveryIntro, project, issue } = options;

  const preference = await resolveTerminalLayoutPreference(repoPath);

  if (preference !== "none") {
    const fallbackReason = await unavailabilityReason();
    if (!fallbackReason) {
      const rawTabColor = await resolveTabColor(repoPath);
      const tabColor = parseTabColor(rawTabColor);
      if (rawTabColor && !tabColor) {
        console.error(
          `Ignoring unrecognized "${rawTabColor}" from ce-harness.tab-color -- using iTerm2's normal appearance.`,
        );
      }
      const title = `${project} · ${issue}`;
      const opened = await openTwoPaneWorkspace({
        worktreePath,
        leftEnv: launchEnv,
        rightCommand: runner.formatLaunchCommand(worktreePath, launchEnv),
        tabColor,
        title,
      });
      if (opened.opened) {
        console.log(`Opened iTerm2 tab "${title}": left = shell, right = ${runner.label}, both in "${worktreePath}".`);
        return;
      }
      // Presentation was genuinely attempted (iTerm2 is available) and
      // failed -- an actual anomaly (e.g. an Automation permission
      // prompt denied), worth a warning, unlike the routine
      // "not applicable here" case below.
      console.error(`Could not open the iTerm2 layout: ${opened.message}`);
      printFallbackReference(worktreePath, runner, launchEnv);
    } else {
      // Routine: iTerm2 presentation simply isn't applicable in this
      // environment (wrong platform, iTerm2 not installed) -- not a
      // warning, just informational, so this never trips a caller's
      // "no console.error calls" expectation for an ordinary run.
      console.log(`iTerm2 layout not used: ${fallbackReason}`);
      printFallbackReference(worktreePath, runner, launchEnv);
    }
  }

  console.log(`Launching ${runner.label} in "${worktreePath}"...`);
  const launchResult = await runner.launch({ cwd: worktreePath, env: launchEnv });
  if (!launchResult.launched) {
    throw new CeError(
      `Failed to launch ${runner.label}: ${launchResult.message}`,
      `${launchFailureRecoveryIntro}\n  ${runner.formatLaunchCommand(worktreePath, launchEnv)}`,
    );
  }
  process.exitCode = launchResult.exitCode;
}

/** Returns why the iTerm2 layout can't even be attempted, or `undefined` when it can. */
async function unavailabilityReason(): Promise<string | undefined> {
  if (process.platform !== "darwin") {
    return "iTerm2 presentation requires macOS.";
  }
  if (!(await isITerm2Available())) {
    return "iTerm2 does not appear to be installed or scriptable.";
  }
  return undefined;
}

function printFallbackReference(
  worktreePath: string,
  runner: RunnerSpec,
  launchEnv: Record<string, string>,
): void {
  console.log(`Worktree: ${worktreePath}`);
  console.log(`Relaunch ${runner.label} any time with:\n  ${runner.formatLaunchCommand(worktreePath, launchEnv)}`);
}
