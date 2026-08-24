import type { Workspace } from "../workspace.js";

/**
 * A `RunnerSpec` is the only shape core workflow code (commands/start.ts,
 * commands/resume.ts, core/launchEnv.ts) is allowed to depend on for
 * launching a coding agent. No command or core module may import a
 * concrete runner module (runners/opencode.ts, runners/claude.ts)
 * directly -- only ./index.js's registry/resolveRunner.
 *
 * Modeled after core/editor.ts's `EditorSpec`, but slightly larger
 * because a coding-agent runner also owns on-disk workflow-config
 * provisioning (commands/skills materialization, optional CodeGraph MCP
 * wiring) that an editor never needs.
 */
export interface RunnerWorkspacePaths {
  workspacePath: string;
  worktreePath: string;
}

export type RunnerLaunchResult =
  | { launched: true; exitCode: number }
  | { launched: false; message: string };

export interface RunnerSpec {
  /** Stable identifier, persisted in workspace.yml and accepted by `--runner`. */
  readonly id: string;
  /** Human-readable name for console messages. */
  readonly label: string;

  /** Resolves the executable to invoke for this runner. Overridable for tests. */
  binary(): string;

  /**
   * Materializes this runner's on-disk workflow configuration (commands,
   * skills) for a freshly created workspace/worktree, from the harness's
   * canonical template library. Side-effecting; called exactly once, by
   * `ce start`, never by `ce resume`.
   *
   * Returns the worktree-relative paths, relative to this runner's own
   * config root, that this call actually wrote and now owns (e.g.
   * `"commands/adversarial-review.md"`, `"skills/openspec-sync-specs"`).
   * Collision-safe per individual path: an entry whose destination
   * already existed (e.g. the repository's own base branch tracks it) is
   * left untouched and simply absent from the returned list -- this is
   * never an all-or-nothing check against one directory, so a single
   * pre-existing, unrelated entry never blocks every other template from
   * being installed. A runner whose config never lives inside the
   * worktree (e.g. OpenCode's, which lives entirely under the workspace
   * directory) has no worktree-relative paths to report and always
   * returns `[]`.
   */
  writeConfig(paths: RunnerWorkspacePaths): Promise<string[]>;

  /**
   * Wires up CodeGraph's MCP server for this runner. Side-effecting;
   * called exactly once, by `ce start`, and only when CodeGraph
   * provisioning already succeeded for this workspace. Same `true`/
   * `false` (written vs. safely skipped) contract as `writeConfig`.
   */
  writeCodeGraphConfig(paths: RunnerWorkspacePaths, codeGraphBinary: string): Promise<boolean>;

  /**
   * Deterministic, side-effect-free: the worktree-relative paths (e.g.
   * `.claude`, `.mcp.json`) this runner actually wrote and owns for
   * `workspace`, derived only from `workspace.runnerWorktreeArtifacts`
   * (never re-derived from the filesystem, and never from a hardcoded
   * "always assume I own this path" shortcut). Used exclusively to keep
   * `ce cleanup`/`ce status`'s dirty-check from mistaking a harness-
   * written, worktree-local config file for a real user/tracked change
   * -- see core/worktreeArtifacts.ts. A runner that never writes
   * anything inside the worktree (e.g. OpenCode) always returns `[]`.
   */
  managedWorktreeRelativePaths(workspace: Workspace): string[];

  /**
   * Deterministic, side-effect-free: runner-specific environment
   * variables layered on top of the generic `CE_*` launch env built by
   * core/launchEnv.ts. Called by both `ce start` and `ce resume`, so it
   * must derive everything from `workspace` and cheap, read-only checks
   * only -- never from in-memory state a fresh `ce resume` process
   * wouldn't have.
   */
  buildEnv(workspace: Workspace): Record<string, string>;

  /**
   * Launches the runner with inherited stdio, handing the user's
   * terminal to it. Never throws: a spawn failure is reported as
   * `{ launched: false, message }`.
   */
  launch(options: { cwd: string; env: Record<string, string> }): Promise<RunnerLaunchResult>;

  /** Renders the exact command line `launch` would run, for recovery messages. */
  formatLaunchCommand(cwd: string, env: Record<string, string>): string;
}
