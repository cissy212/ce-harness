import { basename } from "node:path";
import { CeError } from "../core/errors.js";
import { detectReviewTransition, resolveDiffScope, type ReviewTransitionResult } from "../core/diffScope.js";
import { readWorkspace, resolveTrustedOpenSpec } from "../core/workspace.js";

/**
 * Thin CLI surface over core/diffScope.ts's `resolveDiffScope`, for
 * `/verify` and `/adversarial-review` to invoke via a plain shell call
 * instead of each restating the merge-base/base-branch-fallback algorithm
 * as inline bash+prose. Reads exactly the environment variables `ce
 * start`/`ce review` already inject for this purpose (see
 * core/launchEnv.ts) -- no new state, and no arguments to get wrong.
 *
 * When `CE_DIFF_BASE`/`CE_DIFF_HEAD` are both set (an Existing PR review
 * workspace), also resolves this exact workspace (via `CE_WORKTREE`'s own
 * basename -- the sanitized issue segment every worktree path already
 * ends in, see core/paths.ts's `worktreePath`) to check whether it has
 * transitioned into implementation (`detectReviewTransition`). This is
 * best-effort: any failure resolving the workspace/store degrades to
 * `reviewTransition: null`, which `resolveDiffScope` treats exactly like
 * "not detected" -- a workspace-resolution hiccup must never silently
 * override a real review's explicit range.
 */
export async function diffScopeCommand(): Promise<void> {
  const worktree = process.env.CE_WORKTREE;
  if (!worktree) {
    throw new CeError(
      "CE_WORKTREE is not set.",
      "Run `ce start` (or `ce review`) first, then invoke this from within that workspace's environment.",
    );
  }

  const diffBase = process.env.CE_DIFF_BASE;
  const diffHead = process.env.CE_DIFF_HEAD;

  let reviewTransition: ReviewTransitionResult | null = null;
  if (diffBase && diffHead && process.env.CE_PROJECT) {
    try {
      const sanitizedIssue = basename(worktree);
      const workspace = await readWorkspace(process.env.CE_PROJECT, sanitizedIssue);
      const trusted = resolveTrustedOpenSpec(workspace);
      if (trusted) {
        reviewTransition = await detectReviewTransition(trusted.root, workspace.project, workspace.issue);
      }
    } catch {
      reviewTransition = null;
    }
  }

  const result = await resolveDiffScope(worktree, {
    diffBase,
    diffHead,
    baseBranch: process.env.CE_BASE_BRANCH,
    reviewTransition,
  });

  console.log(JSON.stringify(result, null, 2));
}
