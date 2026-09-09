import { CeError } from "../core/errors.js";
import { resolveDiffScope } from "../core/diffScope.js";

/**
 * Thin CLI surface over core/diffScope.ts's `resolveDiffScope`, for
 * `/verify` and `/adversarial-review` to invoke via a plain shell call
 * instead of each restating the merge-base/base-branch-fallback algorithm
 * as inline bash+prose. Reads exactly the environment variables `ce
 * start`/`ce review` already inject for this purpose (see
 * core/launchEnv.ts) -- no new state, and no arguments to get wrong.
 */
export async function diffScopeCommand(): Promise<void> {
  const worktree = process.env.CE_WORKTREE;
  if (!worktree) {
    throw new CeError(
      "CE_WORKTREE is not set.",
      "Run `ce start` (or `ce review`) first, then invoke this from within that workspace's environment.",
    );
  }

  const result = await resolveDiffScope(worktree, {
    diffBase: process.env.CE_DIFF_BASE,
    diffHead: process.env.CE_DIFF_HEAD,
    baseBranch: process.env.CE_BASE_BRANCH,
  });

  console.log(JSON.stringify(result, null, 2));
}
