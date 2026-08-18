import { CeError } from "../core/errors.js";
import { resolveTargetRepo } from "../core/git.js";
import {
  fetchPrCommits,
  isGhAuthenticated,
  isGhAvailable,
  resolvePrSnapshot,
  verifyPrCommitsFetched,
} from "../core/github.js";
import { startCommand } from "./start.js";

export interface ReviewOptions {
  repo: string;
  /** Raw CLI argument -- validated as a positive integer before use. */
  prNumber: string;
  /** Coding-agent runner id (e.g. "opencode", "claude"). Defaults to "opencode". */
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
 * GitHub-independent; this module is the only caller of `../core/github.js`.
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
    issue: `review-pr-${pr.number}`,
    base: pr.baseRefOid,
    head: pr.headRefOid,
    runner,
  });
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
