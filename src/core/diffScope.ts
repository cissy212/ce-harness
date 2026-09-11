import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { activeChangeRoot, resolveActiveChangesForWorkspace } from "./activeChange.js";
import { isAncestor, tryMergeBase } from "./git.js";

/**
 * The sidecar `/apply` itself writes, once, the first time it actually
 * begins implementing a change -- see `templates/commands/apply.md`'s
 * Step 4. This is deliberately the *only* signal `detectReviewTransition`
 * trusts as evidence of a real transition: neither an OpenSpec change
 * existing, nor `/propose` having validated a plan, nor the worktree
 * merely differing from the original PR head, are sufficient on their
 * own -- a user could run `/propose` and then hand-edit any file,
 * satisfying all three without `/apply` ever running. Only `/apply`
 * ever writes this file, at a specific, deterministic point in its own
 * lifecycle, so its mere presence is proof the harness's own pipeline
 * produced the current implementation.
 */
export const IMPLEMENTATION_BASE_FILENAME = ".ce-implementation-base.yml";

export interface ImplementationBaseStamp {
  /**
   * The worktree's `HEAD` commit at the moment `/apply` first began
   * implementing this change -- i.e. the true starting point of the
   * current implementation. For a workspace that started as a review of
   * an external PR, this can be entirely unrelated to that PR's own
   * recorded `diffBase`/`diffHead` (e.g. the reviewer reset the worktree
   * to a fresh branch off the target repository's current trunk before
   * running `/apply`) -- which is exactly why this, and not the
   * original review's `diffBase`, is what a transitioned workspace's
   * diff-scope must be resolved against.
   */
  baseCommit: string;
  /** YYYY-MM-DD, from the same deterministic `date -u +%Y-%m-%d` source every other durable artifact date uses. */
  recordedAt: string;
}

/**
 * Best-effort read of a change's implementation-base marker. Never
 * throws: a missing file (every change/workspace that predates this
 * mechanism, or simply never transitioned) or a malformed one both
 * simply mean "no marker" -- callers degrade to "not detected", never
 * crash or error.
 */
export async function readImplementationBase(changeRoot: string): Promise<ImplementationBaseStamp | null> {
  try {
    const raw = await readFile(join(changeRoot, IMPLEMENTATION_BASE_FILENAME), "utf8");
    const parsed = parse(raw) as Record<string, unknown> | null;
    if (typeof parsed?.baseCommit === "string" && typeof parsed?.recordedAt === "string") {
      return { baseCommit: parsed.baseCommit, recordedAt: parsed.recordedAt };
    }
    return null;
  } catch {
    return null;
  }
}

export interface ReviewTransitionResult {
  /** True once real, deterministic evidence shows this workspace's review has transitioned into implementation. */
  detected: boolean;
  /** The active change whose evidence triggered detection, or `null` if none did. */
  changeName: string | null;
  /**
   * The recorded implementation-base commit (see `ImplementationBaseStamp`)
   * when `detected` -- the reference a transitioned workspace's
   * diff-scope must resolve against, never the original review's own
   * `diffBase`. `null` when not detected.
   */
  implementationBase: string | null;
  /** Human-readable explanation -- surfaced in `/verify`'s and `/adversarial-review`'s own reports for transparency. */
  reason: string;
}

export interface DiffScopeResult {
  /**
   * "explicit" -- `CE_DIFF_BASE`/`CE_DIFF_HEAD` were both set (an existing
   * pull request injected by `ce start --base --head`) and no review
   * transition (see `reviewTransition`) was detected.
   * "merge-base" -- no explicit range, or one was set but a review
   * transition was detected and deliberately overridden it; a merge base
   * against `CE_BASE_BRANCH` (or, after a detected transition, the
   * recorded implementation base -- never the original review's own
   * `diffBase`), its `origin/` form, `main`, or `master` was found.
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
  /**
   * Set only when `diffBase`/`diffHead` were both given -- whether this
   * Existing PR review workspace has transitioned into implementation,
   * and why (or why not). `null` when the question doesn't apply (a
   * plain Implementation workspace, with no explicit range at all).
   */
  reviewTransition: ReviewTransitionResult | null;
}

export interface DiffScopeOptions {
  diffBase?: string;
  diffHead?: string;
  baseBranch?: string;
  /**
   * Set only when `diffBase`/`diffHead` were both provided -- see
   * `detectReviewTransition`. Its `detected: true` makes this function
   * skip the explicit range and fall through to merge-base resolution
   * instead, exactly as if `diffBase`/`diffHead` had never been set --
   * the workspace is no longer being reviewed as the original external
   * range once real implementation has landed on top of it.
   */
  reviewTransition?: ReviewTransitionResult | null;
}

/**
 * Detects whether an Existing PR review workspace (one created with
 * `ce review`/`ce start --base --head`) has legitimately transitioned
 * into implementation work through the harness's own
 * `/explore -> /enrich -> /propose -> /apply` pipeline, rather than
 * remaining a pure, comment-only review of the original external commit
 * range. This is what lets `/verify` verify -- and `/adversarial-review`
 * review the right diff for -- a fix produced *inside* a review
 * workspace, without weakening the guard for a workspace that is still
 * genuinely just reviewing the original range.
 *
 * Relies on exactly one signal: an active OpenSpec change owned by this
 * workspace has an `.ce-implementation-base.yml` marker (see
 * `IMPLEMENTATION_BASE_FILENAME`), written only by `/apply` itself, only
 * once, the first time it actually begins implementing. Deliberately
 * does **not** infer a transition from an OpenSpec change merely
 * existing, from `/propose` having validated a plan, or from the
 * worktree merely differing from the original PR head -- a user could
 * run `/propose` and then hand-edit any file, satisfying all of those
 * without `/apply` ever running, which would incorrectly unlock
 * `/verify` on work the harness never actually produced or checked the
 * provenance of. The marker's mere presence already implies `/propose`
 * validated a plan (`/apply`'s own Step 4 gate requires that before it
 * ever reaches the point where it writes this marker) -- so nothing
 * else needs to be independently re-checked here.
 */
export async function detectReviewTransition(
  durableRoot: string,
  project: string,
  issue: string,
): Promise<ReviewTransitionResult> {
  const activeChanges = await resolveActiveChangesForWorkspace(durableRoot, project, issue);
  if (activeChanges.length === 0) {
    return {
      detected: false,
      changeName: null,
      implementationBase: null,
      reason: "no active OpenSpec change is owned by this workspace",
    };
  }

  for (const changeName of activeChanges) {
    const stamp = await readImplementationBase(activeChangeRoot(durableRoot, changeName));
    if (stamp) {
      return {
        detected: true,
        changeName,
        implementationBase: stamp.baseCommit,
        reason:
          `active change "${changeName}" has an implementation-base marker recorded by /apply -- ` +
          "treating this workspace as having transitioned from review into implementation",
      };
    }
  }

  return {
    detected: false,
    changeName: null,
    implementationBase: null,
    reason:
      "no active change has an /apply-recorded implementation-base marker yet -- exploratory review " +
      "artifacts, a validated /propose plan, or a worktree that merely differs from the original PR head " +
      "do not, on their own, count as implementation",
  };
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
  const { diffBase, diffHead, baseBranch, reviewTransition = null } = options;

  if (diffBase && diffHead && !reviewTransition?.detected) {
    return {
      mode: "explicit",
      diffRange: `${diffBase}...${diffHead}`,
      logRange: `${diffBase}..${diffHead}`,
      base: diffBase,
      baseSource: "explicit CE_DIFF_BASE/CE_DIFF_HEAD",
      scopeLimitation: null,
      reviewTransition,
    };
  }

  let base: string | null = null;
  let baseSource: string | null = null;

  // A transitioned review workspace never has CE_BASE_BRANCH at all (see
  // core/launchEnv.ts -- it's mutually exclusive with diffBase/diffHead),
  // so there is no stored trunk-branch name to fall back to here. Use the
  // recorded implementation base instead of the original review's own
  // diffBase: `/apply` may have started implementing from a completely
  // different point in history than the original PR (e.g. a fresh branch
  // off the target repository's *current* trunk, well past diffBase) --
  // merge-basing against the stale diffBase would silently pull in every
  // unrelated commit that landed on the trunk between diffBase and the
  // real implementation start, exactly the history a review workspace
  // exists to exclude.
  if (diffBase && diffHead && reviewTransition?.detected && reviewTransition.implementationBase) {
    const implementationBase = reviewTransition.implementationBase;
    const mb = await tryMergeBase(repoPath, "HEAD", implementationBase);
    if (mb) {
      base = mb;
      baseSource = `the recorded implementation base (${implementationBase})`;
    }
  }

  if (!base && baseBranch) {
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
    const tried = [
      ...(diffBase && diffHead && reviewTransition?.detected && reviewTransition.implementationBase
        ? [`the recorded implementation base (${reviewTransition.implementationBase})`]
        : []),
      ...(baseBranch ? [baseBranch, `origin/${baseBranch}`] : []),
      "main",
      "master",
    ];
    return {
      mode: "no-base",
      diffRange: null,
      logRange: null,
      base: null,
      baseSource: null,
      scopeLimitation: `No merge base found against any of: ${tried.join(", ")}.`,
      reviewTransition,
    };
  }

  return {
    mode: "merge-base",
    diffRange: `${base}...HEAD`,
    logRange: null,
    base,
    baseSource,
    scopeLimitation: null,
    reviewTransition,
  };
}
