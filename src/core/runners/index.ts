import { CeError } from "../errors.js";
import { CLAUDE_RUNNER } from "./claude.js";
import { OPENCODE_RUNNER } from "./opencode.js";
import type { RunnerSpec } from "./types.js";

export type { RunnerSpec, RunnerWorkspacePaths, RunnerLaunchResult } from "./types.js";

/** The runner every workspace uses unless `--runner` says otherwise, and every pre-existing workspace.yml (no `runner` field) is treated as having used. */
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
 * `DEFAULT_RUNNER_ID` -- this is what keeps every workspace created
 * before this field existed, and every `ce start` invoked without
 * `--runner`, behaving exactly as an OpenCode workspace always has.
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
