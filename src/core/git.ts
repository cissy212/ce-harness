import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
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

/**
 * Returns porcelain status lines; empty array means a clean tree.
 *
 * Deliberately never `.trim()`s the raw stdout as a whole before
 * splitting it: porcelain v1's 2-character `XY` status code legitimately
 * *starts* with a literal space whenever a file is modified in the
 * worktree but not staged (e.g. `" M path"`), and if that happens to be
 * the first line of the output, `String.prototype.trim()` silently eats
 * that leading space along with it -- shifting every downstream
 * line-slicing consumer (see e.g. `porcelainLinePath` in
 * core/worktreeArtifacts.ts, and `porcelainPaths` in
 * commands/publish.ts, both of which assume a fixed 3-character `"XY "`
 * prefix) by one character, silently truncating that one file's parsed
 * path (a real case: `"apps/..."` became `"pps/..."`). Filtering out
 * only genuinely empty lines -- a stray trailing newline, or no output
 * at all for a clean tree -- avoids that without touching any line's
 * real content.
 */
export async function statusPorcelain(repoPath: string): Promise<string[]> {
  const result = await git(repoPath, ["status", "--porcelain", "--untracked-files=all"]);
  if (result.exitCode !== 0) {
    throw new CeError(
      `Failed to read Git status for "${repoPath}": ${result.stderr.trim()}`,
    );
  }
  return result.stdout.split("\n").filter((line) => line.length > 0);
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

export interface DetectedBaseBranch {
  /** Clean branch name (e.g. "develop", "main"), for display/metadata. */
  name: string;
  /** The exact ref to seed the worktree from (e.g. "develop" or "origin/develop"). */
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
 * Once step 1 or 2 names a branch, this **fetches it from `remote`**
 * (see `fetchRemoteBranch`) and always resolves to `<remote>/<branch>`
 * -- a deliberate, narrow exception to "ce-harness never fetches
 * automatically" (every other ref this command's callers accept --
 * `--from`, `--base`/`--head` -- must already exist locally and is
 * never fetched). A new workspace must be established from the base
 * branch's *current* remote state, not from a same-named local branch
 * that may not have been fetched in a while: a caller's local `main`
 * silently lagging behind `origin/main` would otherwise let a new
 * workspace start from stale history with no signal that anything was
 * wrong. If the fetch itself fails (offline, unreachable remote), this
 * throws rather than silently falling back to whatever stale local
 * state happens to exist -- the same "guessing here would risk exactly
 * the wrong-history problem this function exists to prevent" reasoning
 * as ever, just now covering staleness as well as wrong-name guesses.
 *
 * Extensibility: this is a strict priority chain, each step tried only
 * if the previous one yielded nothing. A future explicit,
 * project-specific override (e.g. a config value read from the target
 * repository) only ever needs to be added as a new step *before* step 1
 * -- returning early with `{ name, ref }` when present -- with no change
 * required to the steps below it or any caller (which only ever
 * consumes the `{ name, ref }` shape).
 */
export async function detectBaseBranch(
  repoPath: string,
  remote = "origin",
): Promise<DetectedBaseBranch | null> {
  const intended =
    (await queryRemoteDefaultBranch(repoPath, remote)) ??
    (await readCachedRemoteDefaultBranch(repoPath, remote));

  if (intended) {
    try {
      await fetchRemoteBranch(repoPath, remote, intended);
    } catch (error) {
      throw new CeError(
        `Could not fetch "${remote}/${intended}" (the repository's detected default branch) to establish the current remote base: ${(error as Error).message}`,
        `ce start's default flow requires reaching "${remote}" to confirm the current base -- an unreachable remote is not safe to silently fall back from. If you intend to work from an existing local ref instead, use \`ce start ... --from <ref>\`.`,
      );
    }

    const remoteRef = `${remote}/${intended}`;
    if (await commitExists(repoPath, remoteRef)) {
      return { name: intended, ref: remoteRef };
    }
    // Not expected once the fetch above succeeded -- kept as a
    // defensive, clearly-explained failure rather than silently falling
    // back to a local branch that might not reflect current remote
    // state at all.
    throw new CeError(
      `The repository's remote ("${remote}") reports "${intended}" as its default branch, but "${remoteRef}" is still not resolvable after fetching it.`,
      `Confirm "${intended}" genuinely exists on "${remote}" in "${repoPath}", then run \`ce start\` again.`,
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
 * Like `resolveMergeBase`, but resolves to `null` instead of throwing when
 * no merge base exists or either ref does not resolve at all -- for a
 * caller that tries several candidate refs in turn (e.g. `resolveDiffScope`'s
 * base-branch fallback chain) and treats a failed candidate as "try the
 * next one," not as an error.
 */
export async function tryMergeBase(repoPath: string, refA: string, refB: string): Promise<string | null> {
  const result = await git(repoPath, ["merge-base", refA, refB]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Reports whether `ancestor` is an ancestor of (or the same commit as)
 * `descendant` in `repoPath` -- i.e. `descendant` is reachable from
 * `ancestor`. Never throws: an unresolvable ref and a genuine
 * non-ancestor relationship both simply resolve to `false`.
 */
export async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.exitCode === 0;
}

/**
 * Fetches `refspec` from `remote` into `repoPath`. The low-level fetch
 * primitive -- `ce review` (via `fetchPrCommits`), `ce publish` (via
 * `fetchRemoteBranch` below), and `ce start`'s default (auto-detected)
 * base-branch flow (via `detectBaseBranch`, also through
 * `fetchRemoteBranch`) are its only callers. Every *explicit* ref a
 * caller can name -- `ce start --from`, `--base`/`--head` -- must still
 * already exist locally and is never fetched; only these specific,
 * narrowly-scoped paths fetch, and only exactly what they need. Callers
 * are expected to pass an explicit destination (e.g.
 * `+refs/pull/123/head:refs/ce-harness/reviews/pr-123/head`) so the
 * fetched commit is durably reachable via a real ref rather than the
 * ephemeral `FETCH_HEAD`.
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

/**
 * Fetches `branch` from `remote` into the normal remote-tracking ref
 * `refs/remotes/<remote>/<branch>` -- unlike `fetchPrCommits`'s
 * namespaced destinations, this is a plain, ordinary branch fetch (what
 * `git fetch <remote> <branch>` always does). Used by `ce publish` to
 * learn the base branch's current tip before comparing it against a
 * workspace's internal branch, and by `detectBaseBranch` to establish a
 * new workspace from the base branch's current remote state rather than
 * a possibly-stale local one. Still never touches `refs/heads/*` (no
 * local branch is created or moved).
 */
export async function fetchRemoteBranch(repoPath: string, remote: string, branch: string): Promise<void> {
  await fetchRefspec(repoPath, remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
}

/**
 * True if `repoPath` has an in-progress merge, rebase, or cherry-pick --
 * checked via the same marker files Git itself uses (`MERGE_HEAD`,
 * `rebase-merge`/`rebase-apply`, `CHERRY_PICK_HEAD`) under its Git
 * directory, never by parsing human-readable/locale-dependent status
 * text. `ce publish` refuses outright when this is true rather than
 * layering its own merge attempt on top of an already-unresolved one.
 */
export async function hasInProgressMergeOrRebase(repoPath: string): Promise<boolean> {
  const dirResult = await git(repoPath, ["rev-parse", "--git-dir"]);
  if (dirResult.exitCode !== 0) return false;
  const gitDir = resolve(repoPath, dirResult.stdout.trim());
  return (
    existsSync(join(gitDir, "MERGE_HEAD")) ||
    existsSync(join(gitDir, "CHERRY_PICK_HEAD")) ||
    existsSync(join(gitDir, "rebase-merge")) ||
    existsSync(join(gitDir, "rebase-apply"))
  );
}

/**
 * Merges `ref` into the branch currently checked out in `repoPath`
 * (expected to be a worktree, so this never disturbs any other
 * worktree's checked-out branch). On a clean merge, returns `{ merged:
 * true }` with the new merge commit made. On any conflict, immediately
 * runs `git merge --abort` and returns `{ merged: false }` -- the
 * worktree is left exactly as it was before this call, so a caller can
 * report "blocked" without having left behind a half-finished merge.
 * Never resolves a conflict itself and never force-anything -- this is
 * "safe update" in the literal sense: it only ever succeeds when Git
 * itself can apply the merge with no ambiguity.
 */
export async function mergeRef(repoPath: string, ref: string): Promise<{ merged: boolean }> {
  const result = await git(repoPath, ["merge", "--no-edit", ref]);
  if (result.exitCode === 0) return { merged: true };
  await git(repoPath, ["merge", "--abort"]);
  return { merged: false };
}

/** `git add -A && git commit -m <message>` in `repoPath`. Throws on failure (e.g. nothing to commit). */
export async function commitAllChanges(repoPath: string, message: string): Promise<void> {
  const addResult = await git(repoPath, ["add", "-A"]);
  if (addResult.exitCode !== 0) {
    throw new CeError(`Failed to stage changes in "${repoPath}": ${addResult.stderr.trim()}`);
  }
  const commitResult = await git(repoPath, ["commit", "-m", message]);
  if (commitResult.exitCode !== 0) {
    throw new CeError(`Failed to commit staged changes in "${repoPath}": ${commitResult.stderr.trim()}`);
  }
}

/**
 * Pushes `localRef` (a branch, or any committish) to `remoteBranch` on
 * `remote`, creating or fast-forwarding it -- never `--force`. `ce
 * publish` relies on this never rewriting history on the remote: it
 * always pushes the same, monotonically-growing local branch under the
 * same deterministic remote branch name, so a second publish for the
 * same workspace is always a plain fast-forward, exactly like pushing
 * new commits to an already-open pull request's branch.
 */
export async function pushBranch(
  repoPath: string,
  remote: string,
  localRef: string,
  remoteBranch: string,
): Promise<void> {
  const result = await git(repoPath, ["push", remote, `${localRef}:refs/heads/${remoteBranch}`]);
  if (result.exitCode !== 0) {
    throw new CeError(
      `Failed to push "${localRef}" to "${remote}" as "${remoteBranch}": ${result.stderr.trim()}`,
    );
  }
}

/**
 * A 12-hex-char fingerprint of `repoPath`'s exact current worktree
 * state: `HEAD` plus every staged/unstaged tracked change (`git diff
 * HEAD`) plus the content of every untracked, non-ignored file. This is
 * the same "commit alone isn't enough -- uncommitted work is part of
 * what's actually there" fingerprint `/verify`, `/adversarial-review`,
 * and `/archive` already compute (as an embedded bash snippet, since
 * they run inside the agent session) to detect implementation drift
 * between verification and archival; this is the TypeScript port `ce
 * publish` needs at the CLI layer, for the identical reason: two
 * fingerprints computed moments apart are equal if and only if nothing
 * in the worktree that could change what gets pushed has changed,
 * including a file added or modified *without* the branch's commit
 * itself moving -- exactly the gap a `HEAD`-only comparison misses.
 *
 * Never throws for a single untracked file that vanishes or becomes
 * unreadable between listing and reading (tolerated exactly like the
 * bash snippet's own `2>/dev/null`); does throw if `HEAD` itself or the
 * diff against it can't be resolved at all (a fundamentally broken
 * worktree, not a case to silently paper over).
 */
export async function computeWorktreeFingerprint(repoPath: string): Promise<string> {
  // Deliberately bypasses the shared `git()` helper for these two calls:
  // it (via execa's default `stripFinalNewline: true`) strips the
  // trailing newline every git command's stdout naturally ends with,
  // which every *other* caller in this file wants (they immediately
  // `.trim()` anyway) -- but this function's whole purpose is to be
  // byte-for-byte identical to the raw shell pipeline `/verify`'s,
  // `/explore`'s, `/enrich`'s, and `/propose`'s own embedded bash
  // snippets pipe directly into `sha256sum` (`git rev-parse HEAD | ...`,
  // never through anything that strips a trailing newline). Losing that
  // one byte here would silently diverge the two implementations'
  // fingerprints for otherwise-identical worktree state -- exactly the
  // kind of drift `test/unit/provenanceTracking.test.ts` and
  // `test/unit/verificationFreshness.test.ts` cross-check for.
  const head = await execa("git", ["rev-parse", "HEAD"], { cwd: repoPath, reject: false, stripFinalNewline: false });
  if (head.exitCode !== 0) {
    throw new CeError(`Could not resolve HEAD in "${repoPath}" to compute its fingerprint: ${head.stderr.trim()}`);
  }
  const diff = await execa("git", ["diff", "HEAD"], { cwd: repoPath, reject: false, stripFinalNewline: false });
  if (diff.exitCode !== 0) {
    throw new CeError(
      `Could not compute the working-tree diff against HEAD in "${repoPath}" to compute its fingerprint: ${diff.stderr.trim()}`,
    );
  }
  const untracked = await git(repoPath, ["ls-files", "--others", "--exclude-standard"]);
  const untrackedPaths =
    untracked.exitCode === 0
      ? untracked.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];

  const hash = createHash("sha256");
  hash.update(head.stdout);
  hash.update(diff.stdout);
  for (const path of untrackedPaths) {
    try {
      hash.update(await readFile(join(repoPath, path)));
    } catch {
      // Deleted or unreadable between listing and reading -- tolerated.
    }
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * Read-only commits reachable from `toRef` but not `fromRef`, oldest
 * dependency-of-history concerns aside -- most-recent-last would be more
 * natural for "what's included in this PR", but this matches
 * `pathHistory`/`searchCommitMessages`'s existing most-recent-first
 * convention for consistency; callers needing chronological order
 * reverse it themselves. Excludes merge commits (`--no-merges`) so a
 * base-branch update merge never shows up as one of "the" commits being
 * published. Never fetches, never throws (empty array on failure).
 */
export async function logRange(repoPath: string, fromRef: string, toRef: string): Promise<CommitSummary[]> {
  const result = await git(repoPath, [
    "log",
    "--no-merges",
    "--date=iso-strict",
    "--pretty=format:%H%x1f%ad%x1f%s",
    `${fromRef}..${toRef}`,
  ]);
  if (result.exitCode !== 0) return [];
  return parseCommitLogLines(result.stdout);
}

/**
 * Read-only list of paths that differ between `fromRef` and `toRef`,
 * using a three-dot (`...`) diff -- i.e. against their merge base, not
 * `fromRef` directly -- so this reports exactly the product change `ce
 * publish` is about to expose, unaffected by unrelated commits `fromRef`
 * has that `toRef` doesn't. Never fetches, never throws (empty array on
 * failure).
 */
export async function diffNameStatus(repoPath: string, fromRef: string, toRef: string): Promise<string[]> {
  const result = await git(repoPath, ["diff", `${fromRef}...${toRef}`, "--name-only"]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
 * Returns the URL of the repository's "origin" remote, falling back to
 * the sole remote when there is no "origin" but exactly one remote is
 * configured (e.g. a plain `git clone` under a renamed remote). Returns
 * null when there is no remote at all, or when there are multiple
 * remotes and none of them is named "origin" -- in that ambiguous case
 * this deliberately does not guess, since callers use this as project
 * identity *evidence* and a wrong guess is worse than no evidence.
 */
export async function readOriginOrSolitaryRemoteUrl(repoPath: string): Promise<string | null> {
  const originUrl = await readGitConfig(repoPath, "remote.origin.url");
  if (originUrl) return originUrl;

  const listResult = await git(repoPath, ["remote"]);
  if (listResult.exitCode !== 0) return null;
  const remotes = listResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (remotes.length !== 1) return null;

  return readGitConfig(repoPath, `remote.${remotes[0]}.url`);
}

/**
 * True if `repoPath` is a shallow clone (`--depth`-limited history).
 * Project identity evidence that depends on the *complete* commit graph
 * (see resolveRootCommit) is not trustworthy in a shallow clone: the
 * "oldest" commit Git can see is just wherever the shallow boundary
 * happens to sit, not the repository's actual root commit.
 */
export async function isShallowRepository(repoPath: string): Promise<boolean> {
  const result = await git(repoPath, ["rev-parse", "--is-shallow-repository"]);
  if (result.exitCode !== 0) return false;
  return result.stdout.trim() === "true";
}

/**
 * Resolves the repository's single root commit (the commit with no
 * parents, reachable from HEAD) -- used as project identity evidence
 * because, unlike the origin URL, it survives a repository transfer to
 * a different remote/host/URL and is unaffected by renames.
 *
 * Returns null (never throws, never guesses) when the root commit
 * cannot be trusted as unique identity evidence:
 *   - the repository is shallow (isShallowRepository) -- Git cannot see
 *     far enough back to know the true root commit;
 *   - HEAD is unresolvable (e.g. a brand-new repository with no commits
 *     yet);
 *   - history has more than one root commit (an octopus/unrelated-
 *     histories merge) -- there is no single "the" root commit to
 *     compare against, so this is treated the same as no evidence
 *     rather than picking one arbitrarily.
 */
export async function resolveRootCommit(repoPath: string): Promise<string | null> {
  if (await isShallowRepository(repoPath)) return null;

  const result = await git(repoPath, ["rev-list", "--max-parents=0", "HEAD"]);
  if (result.exitCode !== 0) return null;

  const roots = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (roots.length !== 1) return null;

  return roots[0];
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

export interface CommitSummary {
  sha: string;
  /** Commit date, ISO 8601 (`--date=iso-strict`) -- not the author date. */
  date: string;
  subject: string;
}

/**
 * Parses `git log --pretty=format:%H%x1f%ad%x1f%s` output (one commit per
 * line, fields separated by the ASCII Unit Separator so a subject
 * containing e.g. a literal "|" or tab can never be mis-split). Shared by
 * every history-reading function below so the format string and parsing
 * never drift apart.
 */
function parseCommitLogLines(stdout: string): CommitSummary[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, date, ...subjectParts] = line.split("\x1f");
      return { sha: sha ?? "", date: date ?? "", subject: subjectParts.join("\x1f") };
    })
    .filter((commit) => commit.sha.length > 0 && commit.date.length > 0);
}

/**
 * Read-only, deterministic commit history for a single path, most-recent
 * first -- the strongest available signal for "what history touched
 * this file", used by core/retrieval.ts. Follows renames (`--follow`) so
 * a file's history survives having been moved/renamed, and still finds
 * history for a path that existed at some point in the past and was
 * later deleted (this walks backward from HEAD's history, not the
 * working tree, so the path need not exist right now). Never fetches.
 * Returns an empty array -- never throws -- when `path` has no history
 * in this repository, or the query fails for any reason.
 */
export async function pathHistory(
  repoPath: string,
  path: string,
  limit = 20,
): Promise<CommitSummary[]> {
  const result = await git(repoPath, [
    "log",
    "--follow",
    `--max-count=${limit}`,
    "--date=iso-strict",
    "--pretty=format:%H%x1f%ad%x1f%s",
    "--",
    path,
  ]);
  if (result.exitCode !== 0) return [];
  return parseCommitLogLines(result.stdout);
}

/**
 * Read-only, deterministic search of commit subject/body text for any of
 * `keywords` (case-insensitive; multiple `--grep` values are OR'd
 * together by Git's own default, so a commit matching any one keyword is
 * included). Never fetches, never throws (returns an empty array on any
 * failure). Callers pass plain words/identifiers -- an entry containing
 * Git extended-regex metacharacters is used as-is, since ce-harness's
 * own callers (core/retrieval.ts) never pass anything else.
 */
export async function searchCommitMessages(
  repoPath: string,
  keywords: string[],
  limit = 20,
): Promise<CommitSummary[]> {
  const nonEmpty = keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0);
  if (nonEmpty.length === 0) return [];

  const args = ["log", `--max-count=${limit}`, "--date=iso-strict", "--pretty=format:%H%x1f%ad%x1f%s", "-i"];
  for (const keyword of nonEmpty) {
    args.push("--grep", keyword);
  }
  const result = await git(repoPath, args);
  if (result.exitCode !== 0) return [];
  return parseCommitLogLines(result.stdout);
}

/**
 * Read-only list of paths changed by a single commit, relative to the
 * repository root -- used by core/retrieval.ts only to judge whether a
 * commit found via `searchCommitMessages` (which has no path of its own)
 * falls inside a caller-supplied monorepo scope. Never fetches, never
 * throws (returns an empty array on any failure, which simply means that
 * commit contributes no scope information rather than blocking anything).
 */
export async function commitChangedPaths(repoPath: string, sha: string): Promise<string[]> {
  const result = await git(repoPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
 * Moves an already-created worktree's checked-out branch straight to
 * `commit` (`git reset --hard`) -- used only by `ce review`'s follow-up
 * refresh path to pull a pull request's newest commits into a review
 * workspace that was already reviewing an earlier head of the same PR.
 * Never a merge, rebase, or fast-forward-only update: an Existing PR
 * review workspace's internal branch is never shared with anything else
 * (see `addWorktree` above -- it exists solely to hold this one review's
 * commits), so unconditionally moving its tip is safe and matches
 * exactly how it was first created (a branch pointed directly at a
 * commit, never merged into). Callers are responsible for confirming the
 * worktree is clean and at the exact commit they expect *before* calling
 * this -- it does not check either itself, and will happily discard
 * whatever the branch pointed at before.
 */
export async function resetWorktreeToCommit(worktreePath: string, commit: string): Promise<void> {
  const result = await git(worktreePath, ["reset", "--hard", commit]);
  if (result.exitCode !== 0) {
    throw new CeError(
      `Failed to move the worktree at "${worktreePath}" to commit "${commit}": ${result.stderr.trim()}`,
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
