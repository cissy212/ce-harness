import { existsSync } from "node:fs";
import { expectedLensesDir } from "./lenses.js";
import { resolveTrustedCodeGraph } from "./codeGraph.js";
import { resolveRunner } from "./runners/index.js";
import { resolveTrustedOpenSpec, type Workspace } from "./workspace.js";

/**
 * Builds the exact environment ce-harness injects when launching OpenCode
 * for `workspace` -- the single source of truth for this shape, called by
 * both `ce start` (its first launch, immediately after writing the
 * workspace) and `ce resume` (re-entering an already-existing workspace).
 * Keeping this in one place is what guarantees the two commands can never
 * silently drift apart into two different launch environments.
 *
 * Pure and read-only: derives everything from `workspace` and a handful
 * of cheap, deterministic path/existence checks. Never mutates anything.
 */
export function buildLaunchEnv(workspace: Workspace): Record<string, string> {
  const launchEnv: Record<string, string> = {
    CE_WORKSPACE: workspace.workspacePath,
    CE_WORKTREE: workspace.worktreePath,
    CE_PROJECT: workspace.project,
    CE_ISSUE: workspace.issue,
    CE_LENSES_DIR: expectedLensesDir(workspace.workspacePath),
  };

  // Present for every workspace `ce start` itself creates (a store is
  // always registered); cross-checked rather than trusted blindly so a
  // corrupted/tampered workspace.yml can never inject a store id ce-harness
  // wouldn't itself have generated for this exact project/issue/repository.
  const trustedOpenSpec = resolveTrustedOpenSpec(workspace);
  if (trustedOpenSpec) {
    launchEnv.CE_OPENSPEC_STORE = trustedOpenSpec.storeId;
  }

  // Only present for an explicit --base/--head review range; the
  // workflow templates fall back to their own merge-base detection
  // against main/master when these are absent.
  if (workspace.diffBase && workspace.diffHead) {
    launchEnv.CE_DIFF_BASE = workspace.diffBase;
    launchEnv.CE_DIFF_HEAD = workspace.diffHead;
  }

  // Generic, provider-agnostic capability signal for templates -- never a
  // CodeGraph-specific variable name. Only present when a semantic code
  // navigation index was actually provisioned and wired up for this exact
  // workspace (cross-checked, same as OpenSpec above) AND its index still
  // exists on disk -- a cheap, read-only check that matters specifically
  // for `ce resume`, where time may have passed since the index was
  // created and it's not this function's job to recreate anything.
  const trustedCodeGraph = resolveTrustedCodeGraph(workspace);
  if (trustedCodeGraph?.indexPath && existsSync(trustedCodeGraph.indexPath)) {
    launchEnv.CE_CODE_NAV_AVAILABLE = "1";
    launchEnv.CE_CODE_NAV_PROVIDER = "codegraph";
  }

  // Runner-specific env vars (e.g. OpenCode's OPENCODE_CONFIG_DIR/
  // OPENCODE_CONFIG) are contributed by the runner itself -- never
  // hardcoded here -- so this function stays runner-agnostic. Resolved
  // from the workspace's own persisted `runner` field (absent for every
  // workspace created before runner selection existed, which resolves to
  // the same OpenCode default those workspaces have always used).
  Object.assign(launchEnv, resolveRunner(workspace.runner).buildEnv(workspace));

  return launchEnv;
}
