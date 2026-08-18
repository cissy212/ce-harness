import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { CeError } from "./errors.js";

async function git(cwd: string, args: string[]) {
  return execa("git", args, { cwd, reject: false });
}

/**
 * Resolves `path` to the same canonical (symlink-free) form Git itself
 * stores when a worktree is added -- e.g. macOS's `/tmp`/`/var` are
 * themselves symlinks, so a plain lexical `path.resolve` alone is not
 * enough to match what `git worktree list` reports. Falls back to
 * resolving just the parent directory (which -- for every path this is
 * ever called with -- was created before the leaf could ever have been
 * deleted) when `path` itself no longer exists on disk, since `realpath`
 * requires the full path to exist. Never throws: the last resort is a
 * plain lexical resolve, which is still strictly better than comparing
 * two arbitrarily-spelled paths as raw strings.
 */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
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

/**
 * Queries `remote` directly for the branch its `HEAD` symref currently
 * points at -- a lightweight, read-only round trip (`git ls-remote
 * --symref`) that downloads no objects and updates no local refs. This
 * reflects the remote's *current* default branch, unaffected by
 * whatever was true when this repository was last cloned or fetched.
 * Returns null if there is no such remote, the query fails (offline,
 * unreachable, no such remote, etc.), or the response can't be parsed.
 */
export async function queryRemoteDefaultBranch(repoPath: string, remote = "origin"): Promise<string | null> {
  const result = await git(repoPath, ["ls-remote", "--symref", remote, "HEAD"]);
  if (result.exitCode !== 0) return null;
  const match = result.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  return match ? match[1] : null;
}

/**
 * Reads the locally-cached remote default branch at
 * `refs/remotes/<remote>/HEAD` -- set automatically by `git clone` (or
 * `git remote set-head`), and readable entirely offline. This can be
 * stale if the remote's default branch changed since this repository
 * was cloned; `queryRemoteDefaultBranch` reflects current truth and is
 * preferred whenever it succeeds. Returns null if the symref doesn't
 * exist (e.g. no such remote, or it was never set).
 */
export async function readCachedRemoteDefaultBranch(
  repoPath: string,
  remote = "origin",
): Promise<string | null> {
  const result = await git(repoPath, ["symbolic-ref", `refs/remotes/${remote}/HEAD`]);
  if (result.exitCode !== 0) return null;
  const match = result.stdout.trim().match(new RegExp(`^refs/remotes/${remote}/(.+)$`));
  return match ? match[1] : null;
}

/**
 * Resolves the exact local ref to seed a worktree from, for a candidate
 * base-branch name: prefers a local branch of that name, then falls
 * back to `<remote>/<branch>` (a remote-tracking ref, present after any
 * prior fetch even without a local branch checked out). Returns null if
 * neither resolves locally -- ce-harness never fetches automatically to
 * make one exist; callers surface a clear error instead.
 */
async function resolveLocalRefForBranch(
  repoPath: string,
  branch: string,
  remote: string,
): Promise<string | null> {
  if (await commitExists(repoPath, branch)) return branch;
  const remoteRef = `${remote}/${branch}`;
  if (await commitExists(repoPath, remoteRef)) return remoteRef;
  return null;
}

export interface DetectedBaseBranch {
  /** Clean branch name (e.g. "develop", "main"), for display/metadata. */
  name: string;
  /** The exact local ref to seed the worktree from (e.g. "develop" or "origin/develop"). */
  ref: string;
}

/**
 * Determines the repository's intended base branch, preferring
 * automatic, repository-agnostic detection over any hardcoded name:
 *
 * 1. Ask `remote` directly what its current default branch is (a live,
 *    read-only query -- see `queryRemoteDefaultBranch`).
 * 2. If that fails (offline, no such remote), fall back to the locally
 *    cached remote default branch (see `readCachedRemoteDefaultBranch`).
 * 3. If neither yields a signal at all (no remote configured -- a
 *    local-only repository), fall back to the common local convention
 *    names, in order. This is the only place a specific name is ever
 *    hardcoded, and only as an absolute last resort with zero
 *    repository-provided signal.
 *
 * If the remote clearly names a branch (step 1 or 2) but it cannot be
 * resolved locally, this throws rather than silently substituting a
 * different branch -- ce-harness never fetches automatically, and
 * guessing here would risk exactly the wrong-history problem this
 * function exists to prevent.
 *
 * Extensibility: this is a strict priority chain, each step tried only
 * if the previous one yielded nothing. A future explicit,
 * project-specific override (e.g. a config value read from the target
 * repository) only ever needs to be added as a new step *before* step 1
 * -- returning early with `{ name, ref }` when present -- with no change
 * required to the steps below it, `resolveLocalRefForBranch`, or any
 * caller (which only ever consumes the `{ name, ref }` shape).
 */
export async function detectBaseBranch(
  repoPath: string,
  remote = "origin",
): Promise<DetectedBaseBranch | null> {
  const intended =
    (await queryRemoteDefaultBranch(repoPath, remote)) ??
    (await readCachedRemoteDefaultBranch(repoPath, remote));

  if (intended) {
    const ref = await resolveLocalRefForBranch(repoPath, intended, remote);
    if (ref) return { name: intended, ref };
    throw new CeError(
      `The repository's remote ("${remote}") reports "${intended}" as its default branch, but "${intended}" does not exist locally (neither as a branch nor as "${remote}/${intended}") in "${repoPath}".`,
      `ce-harness never fetches automatically. Fetch it first (e.g. \`git -C "${repoPath}" fetch ${remote} ${intended}\`), then run \`ce start\` again.`,
    );
  }

  for (const candidate of ["main", "master"]) {
    if (await branchExists(repoPath, candidate)) {
      return { name: candidate, ref: candidate };
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

/**
 * Reads a Git config value for `key` in `repoPath`, using Git's own
 * resolution order (local repo config, then global, then system) --
 * never a ce-harness-specific config file or format. Returns null when
 * unset (or on any other failure -- this never throws). Generic and
 * reusable for any config key; ce-harness-specific keys and their
 * defaults are owned by their own call sites, not this function.
 */
export async function readGitConfig(repoPath: string, key: string): Promise<string | null> {
  const result = await git(repoPath, ["config", "--get", key]);
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

/**
 * Adds `pattern` to `repoPath`'s local, never-committed exclude file
 * (`<git-common-dir>/info/exclude`) -- Git's own purpose-built mechanism
 * for exactly this: a personal ignore rule that never touches any
 * tracked file (`.gitignore` included) and is never visible to anyone
 * else. Idempotent (a no-op if `pattern` is already present, checked
 * line-for-line) and strictly additive -- this only ever appends;
 * pre-existing content in the file is never modified or removed.
 *
 * Note this file lives in the repository's *common* Git directory,
 * shared by every worktree of the same repository (Git has no
 * per-worktree equivalent) -- so a pattern added from one worktree also
 * applies to the original checkout and any other worktree. This is the
 * intended, standard behavior of Git's own exclude mechanism, not a
 * ce-harness-specific side effect.
 */
export async function addLocalExcludePattern(repoPath: string, pattern: string): Promise<void> {
  const commonDirResult = await git(repoPath, ["rev-parse", "--git-common-dir"]);
  if (commonDirResult.exitCode !== 0) {
    throw new CeError(
      `Could not resolve the Git common directory for "${repoPath}": ${commonDirResult.stderr.trim()}`,
    );
  }
  const commonDir = resolve(repoPath, commonDirResult.stdout.trim());
  const excludeFile = join(commonDir, "info", "exclude");

  let existing = "";
  try {
    existing = await readFile(excludeFile, "utf8");
  } catch {
    // No existing file (or unreadable) -- treated the same as empty.
  }

  if (existing.split("\n").some((line) => line.trim() === pattern)) {
    return;
  }

  await mkdir(dirname(excludeFile), { recursive: true });
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(excludeFile, `${existing}${separator}${pattern}\n`, "utf8");
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

/**
 * True if `worktreePath` is still one of `repoPath`'s registered
 * worktrees, per `git worktree list --porcelain` -- Git's own
 * structured, locale-independent bookkeeping, never a human-readable
 * (and therefore locale-dependent) error message. Compares resolved
 * paths, so it holds regardless of trailing slashes or how the path was
 * originally spelled; never requires `worktreePath` to exist on disk
 * (a worktree whose directory was deleted out-of-band still shows up
 * here as prunable, exactly the case this function must still say
 * "yes, registered" for).
 */
export async function isRegisteredWorktree(repoPath: string, worktreePath: string): Promise<boolean> {
  const result = await git(repoPath, ["worktree", "list", "--porcelain"]);
  if (result.exitCode !== 0) return false;

  // Git reports paths already resolved to their canonical form (it
  // resolved them once, when the worktree was added), so registered
  // entries are compared as-is; only our own `worktreePath` argument
  // needs canonicalizing to match that same form.
  const target = await canonicalPath(worktreePath);
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some((line) => line.slice("worktree ".length).trim() === target);
}

/**
 * Removes `worktreePath` from `repoPath`. A no-op, not a failure, if
 * `worktreePath` is already not a registered worktree at all --
 * checked directly via `isRegisteredWorktree` rather than by pattern-
 * matching `git`'s own (human-readable, locale-dependent) error text,
 * so this is never fooled by a non-English Git locale or a differently
 * worded message in a different Git version.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force: boolean,
): Promise<void> {
  if (!(await isRegisteredWorktree(repoPath, worktreePath))) return;

  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  const result = await git(repoPath, args);
  if (result.exitCode !== 0) {
    throw new CeError(
      `Failed to remove Git worktree at "${worktreePath}": ${result.stderr.trim()}`,
    );
  }
}

/**
 * Deletes `branch`. A no-op, not a failure, if `branch` doesn't exist
 * at all -- checked directly via `branchExists` rather than by pattern-
 * matching `git`'s own (human-readable, locale-dependent) error text,
 * so this is never fooled by a non-English Git locale (e.g. Git
 * reporting "rama ... no encontrada" instead of "branch ... not
 * found") or a differently worded message in a different Git version.
 */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  if (!(await branchExists(repoPath, branch))) return;

  const result = await git(repoPath, ["branch", "-D", branch]);
  if (result.exitCode !== 0) {
    throw new CeError(`Failed to delete branch "${branch}": ${result.stderr.trim()}`);
  }
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(repoPath, ["worktree", "prune"]);
}

export function isGitRepoPathExisting(path: string): Promise<boolean> {
  return git(path, ["rev-parse", "--is-inside-work-tree"]).then((r) => r.exitCode === 0);
}
