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
