import { isAncestor, tryMergeBase } from "./git.js";

export interface DiffScopeResult {
  /**
   * "explicit" -- `CE_DIFF_BASE`/`CE_DIFF_HEAD` were both set (an existing
   * pull request injected by `ce start --base --head`).
   * "merge-base" -- no explicit range; a merge base against
   * `CE_BASE_BRANCH`, its `origin/` form, `main`, or `master` was found.
   * "no-base" -- none of the above resolved; there is no principled range
   * to diff against.
   */
  mode: "explicit" | "merge-base" | "no-base";
  /** Three-dot range for `git diff`, or `null` in "no-base" mode. */
  diffRange: string | null;
  /** Two-dot range for `git log`. Only ever set in "explicit" mode -- the
   * merge-base fallback never had a log command of its own to preserve. */
  logRange: string | null;
  /** The resolved base ref or SHA, or `null` in "no-base" mode. */
  base: string | null;
  /** Human-readable description of where `base` came from, or `null`. */
  baseSource: string | null;
  /** Set only in "no-base" mode: what was tried and why nothing resolved. */
  scopeLimitation: string | null;
}

export interface DiffScopeOptions {
  diffBase?: string;
  diffHead?: string;
  baseBranch?: string;
}

/**
 * Resolves which range `/verify` and `/adversarial-review` should review.
 * This is the single source of truth for an algorithm both templates
 * previously restated independently as inline bash+prose, kept in sync
 * only by `test/unit/commandConsistency.test.ts`'s "Diff-scope algorithm"
 * checks (see that file's git history) -- itself flagged there as
 * "backlog item H2." Both templates now call `ce diff-scope` (see
 * `src/commands/diffScope.ts`) instead of restating this.
 *
 * Algorithm, preserved exactly:
 * 1. If both `diffBase` and `diffHead` are given, use them directly --
 *    three-dot for the diff, two-dot for the log -- and skip base-branch
 *    detection entirely.
 * 2. Otherwise, if `baseBranch` is given, try its merge base with HEAD
 *    both locally and as `origin/<baseBranch>`. If both resolve and
 *    differ, prefer whichever of the two is the more current (a
 *    descendant of the other, determined by ancestry in both directions,
 *    never by name); if they've diverged in both directions, keep the
 *    local one as the existing default.
 * 3. If that yields nothing (no `baseBranch`, or neither of its forms
 *    resolves), fall back to `main`, then `master`.
 * 4. If nothing resolves at all, report a scope limitation instead of
 *    guessing.
 */
export async function resolveDiffScope(
  repoPath: string,
  options: DiffScopeOptions,
): Promise<DiffScopeResult> {
  const { diffBase, diffHead, baseBranch } = options;

  if (diffBase && diffHead) {
    return {
      mode: "explicit",
      diffRange: `${diffBase}...${diffHead}`,
      logRange: `${diffBase}..${diffHead}`,
      base: diffBase,
      baseSource: "explicit CE_DIFF_BASE/CE_DIFF_HEAD",
      scopeLimitation: null,
    };
  }

  let base: string | null = null;
  let baseSource: string | null = null;

  if (baseBranch) {
    const originRef = `origin/${baseBranch}`;
    const localMb = await tryMergeBase(repoPath, "HEAD", baseBranch);
    const originMb = await tryMergeBase(repoPath, "HEAD", originRef);

    if (localMb && originMb && localMb !== originMb) {
      if (await isAncestor(repoPath, baseBranch, originRef)) {
        base = originMb; // origin/<baseBranch> is ahead -- the more current base
        baseSource = originRef;
      } else if (await isAncestor(repoPath, originRef, baseBranch)) {
        base = localMb; // <baseBranch> is ahead -- the more current base
        baseSource = baseBranch;
      } else {
        base = localMb; // diverged in both directions -- no principled winner; keep the default
        baseSource = baseBranch;
      }
    } else if (localMb) {
      base = localMb;
      baseSource = baseBranch;
    } else if (originMb) {
      base = originMb;
      baseSource = originRef;
    }
  }

  if (!base) {
    for (const candidate of ["main", "master"]) {
      const mb = await tryMergeBase(repoPath, "HEAD", candidate);
      if (mb) {
        base = mb;
        baseSource = candidate;
        break;
      }
    }
  }

  if (!base) {
    const tried = baseBranch ? [baseBranch, `origin/${baseBranch}`, "main", "master"] : ["main", "master"];
    return {
      mode: "no-base",
      diffRange: null,
      logRange: null,
      base: null,
      baseSource: null,
      scopeLimitation: `No merge base found against any of: ${tried.join(", ")}.`,
    };
  }

  return {
    mode: "merge-base",
    diffRange: `${base}...HEAD`,
    logRange: null,
    base,
    baseSource,
    scopeLimitation: null,
  };
}
