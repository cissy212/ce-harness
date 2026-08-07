import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { execa } from "execa";
import { CeError } from "./errors.js";

async function git(cwd: string, args: string[]) {
  return execa("git", args, { cwd, reject: false });
}

/** True if `stderr` shows the operation's target was already gone -- a no-op, not a failure. */
function isAlreadyGone(stderr: string, pattern: RegExp): boolean {
  return pattern.test(stderr);
}

/** Resolves the canonical Git repository root for `path`, or throws. */
export async function resolveRepoRoot(path: string): Promise<string> {
  const result = await git(path, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    throw new CeError(
      `"${path}" is not inside a Git repository.`,
      "Point ce start at a directory that is (or is inside) a Git repository.",
    );
  }
  return result.stdout.trim();
}

/**
 * Validates and resolves a user-supplied repository path down to its
 * canonical Git repository root: the path must exist, and must be (or
 * be inside) a Git repository. Shared by every command that takes a
 * `<repo>` argument (`ce start`, `ce review`) so this validation is
 * never duplicated or allowed to drift between them.
 */
export async function resolveTargetRepo(repoPath: string): Promise<string> {
  if (!existsSync(repoPath)) {
    throw new CeError(
      `Repository path "${repoPath}" does not exist.`,
      "Check the path and try again.",
    );
  }
  const canonicalRepoPath = await realpath(repoPath);
  return resolveRepoRoot(canonicalRepoPath);
}

/** Returns porcelain status lines; empty array means a clean tree. */
export async function statusPorcelain(repoPath: string): Promise<string[]> {
  const result = await git(repoPath, ["status", "--porcelain", "--untracked-files=all"]);
  if (result.exitCode !== 0) {
    throw new CeError(
      `Failed to read Git status for "${repoPath}": ${result.stderr.trim()}`,
    );
  }
  const trimmed = result.stdout.trim();
  return trimmed.length === 0 ? [] : trimmed.split("\n");
}

export async function isDirty(repoPath: string): Promise<boolean> {
  return (await statusPorcelain(repoPath)).length > 0;
}

/** Returns "main", "master", or null if neither exists as a local branch. */
export async function detectBaseBranch(repoPath: string): Promise<string | null> {
  for (const candidate of ["main", "master"]) {
    if (await branchExists(repoPath, candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves `ref` (a branch, tag, or SHA) to its full commit SHA in
 * `repoPath`. Never fetches -- if `ref` isn't already present locally
 * (e.g. it lives on a remote and hasn't been fetched), this throws
 * rather than reaching out over the network.
 */
export async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  const result = await git(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (result.exitCode !== 0) {
    throw new CeError(
      `Could not resolve "${ref}" to a commit in "${repoPath}".`,
      `ce-harness never fetches automatically. If "${ref}" lives on a remote, fetch it first (e.g. \`git -C "${repoPath}" fetch origin ${ref}\`), then try again.`,
    );
  }
  return result.stdout.trim();
}

/**
 * Resolves the merge base of `baseSha` and `headSha` in `repoPath`.
 * Does not require either to be an ancestor of the other -- this is the
 * same "where did these two histories diverge" question `git diff
 * A...B` answers, which is what makes it correct for an open PR whose
 * base branch has advanced since the PR's branch point. Throws if the
 * two commits share no common history at all (no merge base exists).
 */
export async function resolveMergeBase(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  const result = await git(repoPath, ["merge-base", baseSha, headSha]);
  if (result.exitCode !== 0) {
    throw new CeError(
      `"${baseSha}" and "${headSha}" share no common history in "${repoPath}" -- no merge base exists between them.`,
      "Confirm both refs are reachable from a common ancestor in this repository (e.g. they both descend from the same initial commit), then try again.",
    );
  }
  return result.stdout.trim();
}

/**
 * Fetches `refspec` from `remote` into `repoPath`. This is the only
 * function in ce-harness that ever fetches over the network -- used
 * exclusively by `ce review` (never by `ce start`, which requires refs
 * to already exist locally). Callers are expected to pass an explicit
 * destination (e.g. `+refs/pull/123/head:refs/ce-harness/reviews/pr-123/head`)
 * so the fetched commit is durably reachable via a real ref rather than
 * the ephemeral `FETCH_HEAD`, and so nothing under `refs/heads/*` (a
 * local branch) is ever created or moved by a fetch.
 */
export async function fetchRefspec(repoPath: string, remote: string, refspec: string): Promise<void> {
  const result = await git(repoPath, ["fetch", remote, refspec]);
  if (result.exitCode !== 0) {
    throw new CeError(
      `Failed to fetch "${refspec}" from "${remote}" in "${repoPath}": ${result.stderr.trim()}`,
      `Confirm "${remote}" is a valid remote for this repository and that the ref exists there, then try again.`,
    );
  }
}

/** True if `sha` resolves to a commit already present locally. Never fetches, never throws. */
export async function commitExists(repoPath: string, sha: string): Promise<boolean> {
  const result = await git(repoPath, ["cat-file", "-e", `${sha}^{commit}`]);
  return result.exitCode === 0;
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const result = await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.exitCode === 0;
}

/** Creates `worktreePath` with a new branch `branch` based on `baseBranch`. */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  const result = await git(repoPath, [
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    baseBranch,
  ]);
  if (result.exitCode !== 0) {
    throw new CeError(
      `Failed to create Git worktree at "${worktreePath}": ${result.stderr.trim()}`,
    );
  }
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force: boolean,
): Promise<void> {
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  const result = await git(repoPath, args);
  if (result.exitCode !== 0 && !isAlreadyGone(result.stderr, /is not a working tree/i)) {
    throw new CeError(
      `Failed to remove Git worktree at "${worktreePath}": ${result.stderr.trim()}`,
    );
  }
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  const result = await git(repoPath, ["branch", "-D", branch]);
  if (result.exitCode !== 0 && !isAlreadyGone(result.stderr, /not found/i)) {
    throw new CeError(`Failed to delete branch "${branch}": ${result.stderr.trim()}`);
  }
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(repoPath, ["worktree", "prune"]);
}

export function isGitRepoPathExisting(path: string): Promise<boolean> {
  return git(path, ["rev-parse", "--is-inside-work-tree"]).then((r) => r.exitCode === 0);
}
