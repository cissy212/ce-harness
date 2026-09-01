import { CeError } from "../errors.js";
import { CLAUDE_RUNNER } from "./claude.js";
import { OPENCODE_RUNNER } from "./opencode.js";
import type { RunnerSpec } from "./types.js";

export type { RunnerSpec, RunnerWorkspacePaths, RunnerLaunchResult } from "./types.js";

/**
 * `resolveRunner`'s fallback when no runner id is given at all -- used
 * for interpreting a pre-existing `workspace.yml` with no `runner`
 * field (from before this field existed) as the OpenCode workspace it
 * always was, and for any other caller that leaves `runner` unset. This
 * is deliberately narrower than "the runner a brand-new workspace
 * gets": the `ce` CLI itself (cliMain.ts's `--runner` option default)
 * supplies "claude" explicitly for a real `ce start`/`ce review`
 * invocation with no `--runner` flag, so this constant's value never
 * actually reaches a new workspace created through the CLI. Changing it
 * would silently change which runner `ce resume`/`ce refresh` launch
 * for every already-existing workspace predating the `runner` field --
 * see `resolveRunner` below.
 */
export const DEFAULT_RUNNER_ID = OPENCODE_RUNNER.id;

const REGISTRY: Record<string, RunnerSpec> = {
  [OPENCODE_RUNNER.id]: OPENCODE_RUNNER,
  [CLAUDE_RUNNER.id]: CLAUDE_RUNNER,
};

/** Every runner id `--runner` and workspace.yml's `runner` field may name. */
export function supportedRunnerIds(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * Resolves a runner id (from `--runner`, or a workspace's persisted
 * `runner` field) to its `RunnerSpec`. `undefined` resolves to
 * `DEFAULT_RUNNER_ID` ("opencode") -- this is what keeps every
 * pre-existing workspace created before the `runner` field existed
 * behaving exactly as it always has. A real `ce start`/`ce review`
 * invocation never actually passes `undefined` here: the CLI's own
 * `--runner` option default ("claude") is what a brand-new workspace
 * gets when `--runner` is omitted -- see cliMain.ts.
 */
export function resolveRunner(id: string | undefined): RunnerSpec {
  const key = id ?? DEFAULT_RUNNER_ID;
  const runner = REGISTRY[key];
  if (!runner) {
    throw new CeError(
      `Unknown runner "${key}".`,
      `Supported runners: ${supportedRunnerIds().join(", ")}.`,
    );
  }
  return runner;
}
