import { existsSync } from "node:fs";
import { CeError } from "../core/errors.js";
import { detectReviewTransition } from "../core/diffScope.js";
import {
  isDirty,
  resetWorktreeToCommit,
  resolveCommit,
  resolveMergeBase,
  resolveTargetRepo,
} from "../core/git.js";
import {
  fetchPrCommits,
  isGhAuthenticated,
  isGhAvailable,
  resolvePrSnapshot,
  verifyPrCommitsFetched,
  type PrSnapshot,
} from "../core/github.js";
import { buildLaunchEnv } from "../core/launchEnv.js";
import { resolveRunner } from "../core/runners/index.js";
import { deriveProjectName, sanitizeIssue } from "../core/sanitize.js";
import {
  readWorkspace,
  resolveTrustedOpenSpec,
  reviewIssueName,
  workspaceExistsOnDisk,
  writeActivePointer,
  writeWorkspace,
  type Workspace,
} from "../core/workspace.js";
import { presentAndLaunch } from "../core/workspacePresenter.js";
import { startCommand } from "./start.js";

export interface ReviewOptions {
  repo: string;
  /** Raw CLI argument -- validated as a positive integer before use. */
  prNumber: string;
  /**
   * Coding-agent runner id (e.g. "opencode", "claude"), passed through to
   * `startCommand` unchanged. Left `undefined` here, `resolveRunner`'s own
   * fallback ("opencode") applies -- but the `ce` CLI itself always
   * supplies "claude" when `--runner` is omitted (see cliMain.ts), so this
   * is undefined in practice only when `reviewCommand` is called directly.
   * Ignored entirely when this call turns out to be a follow-up refresh of
   * an already-existing review workspace (see `refreshReviewWorkspace`) --
   * exactly like `ce resume`, re-entering an existing workspace always
   * relaunches whichever runner it already used, never a different one.
   */
  runner?: string;
}

const PR_NUMBER_PATTERN = /^[1-9]\d*$/;

/**
 * `ce review <repo> <pr-number>`: the convenient, GitHub-specific path
 * to an Existing PR review workspace. A user who knows only the local
 * repository path and the PR number should never have to manually
 * resolve branch names/SHAs, fetch refs, or pass `--base`/`--head`
 * themselves.
 *
 * This command's entire job is: validate input, resolve the PR's exact
 * base/head commits via `gh`, fetch only what's needed to make them
 * available locally (never touching the original repository's branch,
 * HEAD, or working tree), and then delegate to the exact same
 * `startCommand({ base, head })` flow `ce start --base --head` already
 * uses -- so worktree/workspace/OpenSpec-store/CodeGraph/launch/rollback
 * logic is never duplicated. `ce start` itself remains entirely
 * GitHub-independent; `ce review` and `ce status` are the only callers
 * of `../core/github.js`.
 *
 * When a review workspace for this exact PR already exists, this is no
 * longer purely a "create" path: if the PR's live head still matches
 * what that workspace was last configured to review, behavior is
 * unchanged (surfaces `startCommand`'s own "already exists" collision
 * error, pointing at `ce resume`) -- but if the PR has moved (new
 * commits pushed since), this instead refreshes that same workspace in
 * place for a follow-up review (see `refreshReviewWorkspace`), rather
 * than erroring or inventing a second workspace for the same PR.
 */
export async function reviewCommand({ repo, prNumber, runner }: ReviewOptions): Promise<void> {
  const trimmed = prNumber.trim();
  if (!PR_NUMBER_PATTERN.test(trimmed)) {
    throw new CeError(
      `"${prNumber}" is not a valid pull request number.`,
      "Provide the PR number as a positive integer, e.g. `ce review <repo> 119`.",
    );
  }
  const number = Number(trimmed);

  const repoRoot = await resolveTargetRepo(repo);

  // All GitHub/ref-resolution/fetch work happens here, entirely before
  // `startCommand` is ever called -- so a failure at any point below
  // leaves zero ce-harness state (no active workspace, branch, worktree,
  // or workspace directory), without needing any dedicated rollback
  // logic of its own.
  if (!(await isGhAvailable())) {
    throw new CeError(
      'The "gh" (GitHub CLI) executable is not installed or could not be run.',
      "Install the GitHub CLI (https://cli.github.com) and ensure it is on your PATH, then try again.",
    );
  }
  if (!(await isGhAuthenticated())) {
    throw new CeError(
      '"gh" is not authenticated with GitHub.',
      "Run `gh auth login` and try again.",
    );
  }

  const pr = await resolvePrSnapshot(repoRoot, number);

  const project = deriveProjectName(repoRoot);
  const issue = reviewIssueName(pr.number);
  const sanitizedIssue = sanitizeIssue(issue);

  if (workspaceExistsOnDisk(project, sanitizedIssue)) {
    const existing = await readWorkspace(project, sanitizedIssue);
    if (existing.diffHead && existing.diffHead !== pr.headRefOid) {
      await refreshReviewWorkspace(repoRoot, pr, existing);
      return;
    }
    // Same head (or -- defensively, not a real code path for a workspace
    // this naming convention would ever produce -- no diffHead at all):
    // nothing has changed, so fall straight through to the unchanged
    // fetch/startCommand path below, exactly as before this feature
    // existed. `startCommand`'s own collision guard reports this exactly
    // as it always has.
  }

  await fetchPrCommits(repoRoot, pr);
  await verifyPrCommitsFetched(repoRoot, pr);

  console.log(`GitHub PR #${pr.number}`);
  console.log(pr.title);
  console.log("");
  const nameWidth = Math.max(pr.baseRefName.length, pr.headRefName.length) + 2;
  console.log(`Base: ${pr.baseRefName.padEnd(nameWidth)}${shortSha(pr.baseRefOid)}`);
  console.log(`Head: ${pr.headRefName.padEnd(nameWidth)}${shortSha(pr.headRefOid)}`);
  console.log("");
  console.log("Workspace type: Existing PR review");
  console.log("");

  // Reuses the existing --base/--head review-workspace flow verbatim:
  // same worktree/workspace/OpenSpec-store/CodeGraph provisioning,
  // launch environment, and rollback guarantees `ce start --base --head`
  // already has. The default issue identifier is never invented with a
  // suffix on collision -- `startCommand`'s existing collision checks
  // (active workspace, worktree/workspace/branch/store already exist)
  // apply exactly as they do for any other issue name.
  await startCommand({
    repo: repoRoot,
    issue,
    base: pr.baseRefOid,
    head: pr.headRefOid,
    runner,
    prReview: { number: pr.number, initialDiffHead: pr.headRefOid },
  });
}

/**
 * Re-enters `existing` -- a review workspace already reviewing an
 * earlier head of the same pull request -- and moves it forward to
 * `pr`'s current head, in place, for a follow-up review. Never called
 * for a brand-new workspace, and never called when the PR's head hasn't
 * actually moved (see `reviewCommand` above).
 *
 * Refuses outright, before touching anything, in the two cases where
 * silently moving the worktree forward would discard something this
 * command has no business touching:
 *  - the workspace already transitioned into real implementation (see
 *    `core/diffScope.ts`'s `detectReviewTransition`) -- it is no longer
 *    a pure review of the original PR range;
 *  - the worktree is dirty, or its `HEAD` no longer matches the head
 *    this workspace was last configured to review -- either means
 *    something outside ce-harness's own pipeline touched it since.
 */
async function refreshReviewWorkspace(repoRoot: string, pr: PrSnapshot, existing: Workspace): Promise<void> {
  const selector = `${existing.project}/${existing.sanitizedIssue}`;

  const trusted = resolveTrustedOpenSpec(existing);
  if (trusted) {
    const transition = await detectReviewTransition(trusted.root, existing.project, existing.issue);
    if (transition.detected) {
      throw new CeError(
        `Workspace "${selector}" has already transitioned into implementation (active change "${transition.changeName}") -- it is no longer a pure review of the original pull request range.`,
        `Continue working in it normally with \`ce resume ${selector}\`. If you specifically want to review pull request #${pr.number}'s newest commits, clean up this workspace and run \`ce review\` again to start a fresh one.`,
      );
    }
  }

  if (!existsSync(existing.worktreePath)) {
    throw new CeError(
      `Cannot refresh workspace "${selector}" -- its worktree is missing at "${existing.worktreePath}".`,
      `Run \`ce cleanup ${selector}\` to remove this workspace, then \`ce review\` again to start fresh.`,
    );
  }
  if (await isDirty(existing.worktreePath)) {
    throw new CeError(
      `Cannot refresh workspace "${selector}" -- its worktree has uncommitted or untracked changes.`,
      "Commit, stash, or discard those changes first, then run `ce review` again.",
    );
  }
  const currentWorktreeHead = await resolveCommit(existing.worktreePath, "HEAD");
  if (existing.diffHead && currentWorktreeHead !== existing.diffHead) {
    throw new CeError(
      `Cannot refresh workspace "${selector}" -- its worktree HEAD (${currentWorktreeHead}) no longer matches the head this workspace was configured to review (${existing.diffHead}).`,
      `This usually means commits were made directly in the worktree outside ce-harness's own pipeline. Inspect it manually, or run \`ce cleanup ${selector}\` and \`ce review\` again to start fresh.`,
    );
  }

  await fetchPrCommits(repoRoot, pr);
  await verifyPrCommitsFetched(repoRoot, pr);
  await resetWorktreeToCommit(existing.worktreePath, pr.headRefOid);

  const diffMergeBase = await resolveMergeBase(existing.worktreePath, pr.baseRefOid, pr.headRefOid);

  // `initialDiffHead` is the head this workspace's `diffHead` was *first*
  // ever set to -- preserved verbatim across every refresh, never
  // overwritten with the new head. This is what lets a legacy report (one
  // predating PR-number scoping, with no `**Reviewed PR head:**` field of
  // its own) still be correctly attributed to the exact head it reviewed
  // even after this workspace has since been refreshed one or more times
  // -- see `core/workspace.ts`'s `PrReviewMetadataSchema` doc comment.
  // Backfilled from `existing.diffHead` only the *first* time this
  // workspace ever gains a `prReview` block (a legacy workspace that
  // predates the field entirely) -- `existing.diffHead` is still correct
  // for that one-time backfill specifically because, before this
  // refresh capability existed, nothing could ever have moved it.
  const initialDiffHead = existing.prReview?.initialDiffHead ?? existing.diffHead;
  if (!initialDiffHead) {
    // Defensive only: `existing.diffHead` is required alongside
    // `diffBase` for every Existing PR review workspace (see
    // `WorkspaceSchema`'s own refine) -- this workspace's type already
    // guarantees it's set. Not a real code path.
    throw new CeError(`Workspace "${selector}" has no recorded diffHead -- its metadata is invalid.`);
  }

  const updated: Workspace = {
    ...existing,
    diffBase: pr.baseRefOid,
    diffHead: pr.headRefOid,
    diffMergeBase,
    // Backfills a legacy workspace (created before `prReview` existed)
    // with structured PR identity -- we already know the number for
    // certain here, since it's exactly the CLI argument this call was
    // given. `number` and `initialDiffHead` are both stable across every
    // future refresh once set here.
    prReview: { number: pr.number, initialDiffHead },
  };
  await writeWorkspace(updated);

  console.log(`Pull request #${pr.number} has new commits since workspace "${selector}" was last reviewed.`);
  console.log("");
  console.log(`Previous head: ${shortSha(existing.diffHead ?? "unknown")}`);
  console.log(`New head:      ${shortSha(pr.headRefOid)}`);
  console.log("");
  console.log("Workspace refreshed for a follow-up review.");
  console.log("");

  await writeActivePointer({ project: updated.project, sanitizedIssue: updated.sanitizedIssue });

  const launchRunner = resolveRunner(updated.runner);
  const launchEnv = buildLaunchEnv(updated);
  await presentAndLaunch({
    repoPath: updated.repositoryPath,
    worktreePath: updated.worktreePath,
    runner: launchRunner,
    launchEnv,
    launchFailureRecoveryIntro: "Enter the workspace manually with:",
    project: updated.project,
    issue: updated.issue,
  });
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
