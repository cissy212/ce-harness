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
  // workflow templates fall back to CE_BASE_BRANCH (below), then finally
  // to their own main/master guess, when these are absent.
  if (workspace.diffBase && workspace.diffHead) {
    launchEnv.CE_DIFF_BASE = workspace.diffBase;
    launchEnv.CE_DIFF_HEAD = workspace.diffHead;
  }

  // The logical base branch/ref for this Implementation workspace -- the
  // single canonical source `/verify` and `/adversarial-review` should
  // compute their fallback `git merge-base` against, instead of
  // independently re-guessing "main" or "master" (a repository whose real
  // trunk is e.g. "develop", but which happens to also have a
  // stale/unrelated local "main" branch, would otherwise silently diff
  // against the wrong history). Populated identically whether it came
  // from `detectBaseBranch`'s auto-detection or an explicit
  // `ce start --from <ref>` (see `workspace.baseRefExplicit` for that
  // provenance, which this deliberately does not need to check -- both
  // cases are "the logical base", equally canonical). Gated on
  // `baseBranchCommit` rather than just checking `diffBase`/`diffHead`
  // directly: it mirrors the schema's own invariant (`baseBranchCommit`
  // and `diffBase` are never both set) and is robust even if that
  // invariant is why the check exists in the first place --
  // `workspace.baseBranch` is overloaded with the review's head commit
  // (not a branch name at all) for an explicit --base/--head workspace,
  // so it must never leak out as CE_BASE_BRANCH there.
  if (workspace.baseBranchCommit) {
    launchEnv.CE_BASE_BRANCH = workspace.baseBranch;
  }

  // Only present for an Existing PR review workspace created (or
  // refreshed) by `ce review` -- lets `/adversarial-review` write its
  // report under the PR-scoped filename convention (see
  // core/reviewReports.ts's `prScopedReportSuffix`) and detect a
  // follow-up review, without hardcoding or re-deriving the PR number
  // itself. Absent for a plain `ce start --base --head` workspace and
  // for a review workspace created before this field existed.
  if (workspace.prReview) {
    launchEnv.CE_PR_NUMBER = String(workspace.prReview.number);
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
