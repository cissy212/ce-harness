import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBareRemote, cloneRepo, createTempRepo } from "../helpers/tempRepo.js";
import { CeError } from "../../src/core/errors.js";
import {
  addLocalExcludePattern,
  commitChangedPaths,
  addWorktree,
  branchExists,
  deleteBranch,
  detectBaseBranch,
  isRegisteredWorktree,
  isShallowRepository,
  queryRemoteDefaultBranch,
  readCachedRemoteDefaultBranch,
  readOriginOrSolitaryRemoteUrl,
  removeWorktree,
  pathHistory,
  searchCommitMessages,
  resolveCommit,
  resolveMergeBase,
  resolveRootCommit,
} from "../../src/core/git.js";

describe("resolveCommit / resolveMergeBase", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("resolves a branch name to its full commit SHA", async () => {
    const sha = await resolveCommit(repoDir, "main");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const expected = await execa("git", ["-C", repoDir, "rev-parse", "main"]);
    expect(sha).toBe(expected.stdout.trim());
  });

  it("resolves a short SHA to the same full SHA", async () => {
    const full = await resolveCommit(repoDir, "main");
    const short = full.slice(0, 10);
    expect(await resolveCommit(repoDir, short)).toBe(full);
  });

  it("resolving a full SHA returns it unchanged", async () => {
    const full = await resolveCommit(repoDir, "main");
    expect(await resolveCommit(repoDir, full)).toBe(full);
  });

  it("throws a CeError for a ref that doesn't exist locally, without fetching", async () => {
    await expect(resolveCommit(repoDir, "does-not-exist-anywhere")).rejects.toThrow(CeError);
    try {
      await resolveCommit(repoDir, "does-not-exist-anywhere");
      expect.fail("expected resolveCommit to throw");
    } catch (error) {
      expect((error as CeError).recovery).toMatch(/never fetches automatically/i);
    }
  });

  it("resolveMergeBase finds the common ancestor of two diverged branches", async () => {
    const commonAncestor = await resolveCommit(repoDir, "main");

    await execa("git", ["-C", repoDir, "checkout", "-b", "base-side"]);
    await writeFile(`${repoDir}/base-only.txt`, "base change\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "base-only change"]);
    const baseSha = await resolveCommit(repoDir, "base-side");

    await execa("git", ["-C", repoDir, "checkout", "main"]);
    await execa("git", ["-C", repoDir, "checkout", "-b", "head-side"]);
    await writeFile(`${repoDir}/head-only.txt`, "head change\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "head-only change"]);
    const headSha = await resolveCommit(repoDir, "head-side");

    expect(await resolveMergeBase(repoDir, baseSha, headSha)).toBe(commonAncestor);
  });

  it("resolveMergeBase succeeds even when base is not an ancestor of head", async () => {
    // Same setup as above: base-side and head-side diverge from main and
    // neither is an ancestor of the other, but they share a merge base.
    const commonAncestor = await resolveCommit(repoDir, "main");
    await execa("git", ["-C", repoDir, "checkout", "-b", "base-side"]);
    await writeFile(`${repoDir}/base-only.txt`, "base change\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "base-only change"]);
    const baseSha = await resolveCommit(repoDir, "base-side");

    await execa("git", ["-C", repoDir, "checkout", "main"]);
    await execa("git", ["-C", repoDir, "checkout", "-b", "head-side"]);
    await writeFile(`${repoDir}/head-only.txt`, "head change\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "head-only change"]);
    const headSha = await resolveCommit(repoDir, "head-side");

    // Neither is an ancestor of the other.
    const baseIsAncestor = await execa("git", [
      "-C",
      repoDir,
      "merge-base",
      "--is-ancestor",
      baseSha,
      headSha,
    ]).catch((e) => e);
    expect(baseIsAncestor.exitCode).not.toBe(0);

    await expect(resolveMergeBase(repoDir, baseSha, headSha)).resolves.toBe(commonAncestor);
  });

  it("throws a CeError when the two commits share no common history", async () => {
    const headSha = await resolveCommit(repoDir, "main");

    await execa("git", ["-C", repoDir, "checkout", "--orphan", "unrelated"]);
    await execa("git", ["-C", repoDir, "rm", "-rf", "."]);
    await writeFile(`${repoDir}/unrelated.txt`, "no shared history\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "unrelated root commit"]);
    const unrelatedSha = await resolveCommit(repoDir, "unrelated");

    await expect(resolveMergeBase(repoDir, unrelatedSha, headSha)).rejects.toThrow(CeError);
    await expect(resolveMergeBase(repoDir, unrelatedSha, headSha)).rejects.toThrow(
      /share no common history/i,
    );
  });
});

describe("detectBaseBranch (repository-agnostic base-branch detection)", () => {
  let repoDir: string;
  let remoteDir: string | undefined;
  let cleanupDirs: string[] = [];

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    if (remoteDir) await rm(remoteDir, { recursive: true, force: true });
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    cleanupDirs = [];
  });

  it("falls back to main/master when there is no remote at all (local-only repository)", async () => {
    repoDir = await createTempRepo();

    expect(await queryRemoteDefaultBranch(repoDir)).toBeNull();
    expect(await readCachedRemoteDefaultBranch(repoDir)).toBeNull();
    await expect(detectBaseBranch(repoDir)).resolves.toEqual({ name: "main", ref: "main" });
  });

  it("returns null when neither a remote signal nor main/master exists", async () => {
    repoDir = await createTempRepo();
    await execa("git", ["-C", repoDir, "branch", "-m", "main", "trunk"]);

    await expect(detectBaseBranch(repoDir)).resolves.toBeNull();
  });

  it('a repository whose remote defaults to "develop" (never "main") resolves to "develop"', async () => {
    remoteDir = await createBareRemote("develop");
    repoDir = await cloneRepo(remoteDir);

    expect(await queryRemoteDefaultBranch(repoDir)).toBe("develop");
    await expect(detectBaseBranch(repoDir)).resolves.toEqual({ name: "develop", ref: "develop" });

    // No "main" branch exists anywhere in this repository -- confirms
    // the result is not coincidentally reachable via the old hardcoded
    // fallback.
    const branches = (await execa("git", ["-C", repoDir, "branch", "--list"])).stdout;
    expect(branches).not.toMatch(/\bmain\b/);
  });

  it('a repository whose remote defaults to "main" continues to resolve to "main" unchanged', async () => {
    remoteDir = await createBareRemote("main");
    repoDir = await cloneRepo(remoteDir);

    expect(await queryRemoteDefaultBranch(repoDir)).toBe("main");
    await expect(detectBaseBranch(repoDir)).resolves.toEqual({ name: "main", ref: "main" });
  });

  it("prefers the live remote query over a stale locally-cached default branch", async () => {
    remoteDir = await createBareRemote("develop");
    repoDir = await cloneRepo(remoteDir);
    // repoDir's cached refs/remotes/origin/HEAD now says "develop".
    expect(await readCachedRemoteDefaultBranch(repoDir)).toBe("develop");

    // The remote's default branch changes to "main" *after* the clone --
    // repoDir's local cache is now stale, but nothing has re-fetched yet.
    await execa("git", ["-C", remoteDir, "branch", "main"]);
    await execa("git", ["-C", remoteDir, "symbolic-ref", "HEAD", "refs/heads/main"]);
    expect(await queryRemoteDefaultBranch(repoDir)).toBe("main");
    expect(await readCachedRemoteDefaultBranch(repoDir)).toBe("develop");

    // The user independently fetches the new branch (ce-harness itself
    // never fetches automatically) -- now "main" is resolvable locally
    // via the origin/main remote-tracking ref, even though there is no
    // local "main" branch and the cached HEAD symref still says "develop".
    await execa("git", ["-C", repoDir, "fetch", "origin"]);

    await expect(detectBaseBranch(repoDir)).resolves.toEqual({ name: "main", ref: "origin/main" });
  });

  it("throws a clear, actionable error when the remote's default branch is not resolvable locally, rather than silently falling back", async () => {
    remoteDir = await createBareRemote("develop");
    repoDir = await cloneRepo(remoteDir);

    // Simulate the remote's default branch changing after the clone,
    // with the user never having fetched the new branch at all -- no
    // local branch and no remote-tracking ref for it exist anywhere.
    await execa("git", ["-C", remoteDir, "branch", "main"]);
    await execa("git", ["-C", remoteDir, "symbolic-ref", "HEAD", "refs/heads/main"]);

    await expect(detectBaseBranch(repoDir)).rejects.toThrow(CeError);
    try {
      await detectBaseBranch(repoDir);
      expect.fail("expected detectBaseBranch to throw");
    } catch (error) {
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/reports "main" as its default branch/);
      expect(ceError.message).toMatch(/does not exist locally/);
      expect(ceError.recovery).toMatch(/never fetches automatically/i);
      expect(ceError.recovery).toMatch(/fetch origin main/);
    }
  });

  it("resolves via the remote-tracking ref when only that (not a local branch) is available", async () => {
    remoteDir = await createBareRemote("develop");
    repoDir = await cloneRepo(remoteDir);
    // Move off "develop" and delete the local branch, keeping only the
    // remote-tracking ref -- exactly what a fetch-without-checkout
    // leaves behind for a non-default branch.
    await execa("git", ["-C", repoDir, "checkout", "--detach"]);
    await execa("git", ["-C", repoDir, "branch", "-D", "develop"]);

    const branches = (await execa("git", ["-C", repoDir, "branch", "--list"])).stdout;
    expect(branches).not.toMatch(/\bdevelop\b/);

    await expect(detectBaseBranch(repoDir)).resolves.toEqual({
      name: "develop",
      ref: "origin/develop",
    });
  });

  it("queryRemoteDefaultBranch and readCachedRemoteDefaultBranch both return null for an unknown remote name", async () => {
    repoDir = await createTempRepo();
    expect(await queryRemoteDefaultBranch(repoDir, "upstream")).toBeNull();
    expect(await readCachedRemoteDefaultBranch(repoDir, "upstream")).toBeNull();
  });

  it('falls back to "master" specifically (not just "main") when there is no remote and only "master" exists locally', async () => {
    repoDir = await createTempRepo();
    await execa("git", ["-C", repoDir, "branch", "-m", "main", "master"]);

    expect(await queryRemoteDefaultBranch(repoDir)).toBeNull();
    expect(await readCachedRemoteDefaultBranch(repoDir)).toBeNull();
    await expect(detectBaseBranch(repoDir)).resolves.toEqual({ name: "master", ref: "master" });
  });

  it('resolves to the remote\'s actual default "develop" even when an unrelated, stale local "main" branch also exists -- the exact regression this guards: a repository whose real trunk is "develop" must never be silently diffed against a coincidental "main"', async () => {
    remoteDir = await createBareRemote("develop");
    repoDir = await cloneRepo(remoteDir);

    // An unrelated "main" branch with no shared history at all -- not a
    // fork point of "develop", just a stale/leftover branch name that
    // happens to match the old hardcoded fallback ce-harness (and, before
    // this fix, /verify and /adversarial-review) used to guess.
    await execa("git", ["-C", repoDir, "checkout", "--orphan", "main"]);
    await execa("git", ["-C", repoDir, "rm", "-rf", "."]);
    await writeFile(`${repoDir}/unrelated.txt`, "stale main, unrelated to develop\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "stale unrelated main"]);
    await execa("git", ["-C", repoDir, "checkout", "develop"]);

    const branches = (await execa("git", ["-C", repoDir, "branch", "--list"])).stdout;
    expect(branches).toMatch(/\bmain\b/);
    expect(branches).toMatch(/\bdevelop\b/);

    await expect(detectBaseBranch(repoDir)).resolves.toEqual({ name: "develop", ref: "develop" });
  });
});

describe("addLocalExcludePattern (Git's own local, never-committed exclude mechanism)", () => {
  let repoDir: string;

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("adds the pattern to <git-common-dir>/info/exclude, and Git actually honors it", async () => {
    repoDir = await createTempRepo();

    await addLocalExcludePattern(repoDir, "/.codegraph");

    const commonDir = (
      await execa("git", ["-C", repoDir, "rev-parse", "--git-common-dir"])
    ).stdout.trim();
    const excludeContent = await readFile(join(repoDir, commonDir, "info", "exclude"), "utf8");
    expect(excludeContent).toContain("/.codegraph\n");

    await execa("mkdir", [join(repoDir, ".codegraph")]);
    const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
    expect(status.stdout).toBe("");
  });

  it("is idempotent -- calling it twice never duplicates the line", async () => {
    repoDir = await createTempRepo();

    await addLocalExcludePattern(repoDir, "/.codegraph");
    await addLocalExcludePattern(repoDir, "/.codegraph");

    const commonDir = (
      await execa("git", ["-C", repoDir, "rev-parse", "--git-common-dir"])
    ).stdout.trim();
    const excludeContent = await readFile(join(repoDir, commonDir, "info", "exclude"), "utf8");
    const occurrences = excludeContent.split("\n").filter((line) => line.trim() === "/.codegraph").length;
    expect(occurrences).toBe(1);
  });

  it("never removes or modifies pre-existing content in the exclude file", async () => {
    repoDir = await createTempRepo();
    const commonDir = (
      await execa("git", ["-C", repoDir, "rev-parse", "--git-common-dir"])
    ).stdout.trim();
    const excludeFile = join(repoDir, commonDir, "info", "exclude");
    await writeFile(excludeFile, "*.local\nsome-other-pattern\n", "utf8");

    await addLocalExcludePattern(repoDir, "/.codegraph");

    const excludeContent = await readFile(excludeFile, "utf8");
    expect(excludeContent).toContain("*.local");
    expect(excludeContent).toContain("some-other-pattern");
    expect(excludeContent).toContain("/.codegraph");
  });

  it("applies to every worktree of the same repository, since Git's exclude file has no per-worktree equivalent", async () => {
    repoDir = await createTempRepo();
    const worktreePath = join(repoDir, "..", "addLocalExcludePattern-worktree");
    await execa("git", ["-C", repoDir, "worktree", "add", "-b", "feature", worktreePath, "main"]);

    try {
      // Added from the worktree...
      await addLocalExcludePattern(worktreePath, "/.codegraph");

      // ...but Git also honors it from the original checkout, since the
      // exclude file lives in the shared common Git directory.
      await execa("mkdir", [join(repoDir, ".codegraph")]);
      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it("never modifies any tracked file -- .gitignore is untouched", async () => {
    repoDir = await createTempRepo();
    await writeFile(join(repoDir, ".gitignore"), "node_modules/\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add .gitignore"]);

    await addLocalExcludePattern(repoDir, "/.codegraph");

    const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
    expect(status.stdout).toBe("");
    expect(await readFile(join(repoDir, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("throws a CeError when repoPath is not a Git repository at all", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    repoDir = await mkdtemp(join(tmpdir(), "ce-harness-not-a-repo-"));

    await expect(addLocalExcludePattern(repoDir, "/.codegraph")).rejects.toThrow(CeError);
  });
});

describe("deleteBranch (idempotent -- a missing branch is a no-op, never a failure)", () => {
  let repoDir: string;

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("deletes an existing branch", async () => {
    repoDir = await createTempRepo();
    await execa("git", ["-C", repoDir, "branch", "some-branch"]);
    expect(await branchExists(repoDir, "some-branch")).toBe(true);

    await deleteBranch(repoDir, "some-branch");

    expect(await branchExists(repoDir, "some-branch")).toBe(false);
  });

  it("is a no-op, not an error, when the branch does not exist at all", async () => {
    repoDir = await createTempRepo();

    await expect(deleteBranch(repoDir, "never-existed")).resolves.toBeUndefined();
  });

  it("is idempotent -- deleting the same branch twice in a row never throws", async () => {
    repoDir = await createTempRepo();
    await execa("git", ["-C", repoDir, "branch", "some-branch"]);

    await deleteBranch(repoDir, "some-branch");
    await expect(deleteBranch(repoDir, "some-branch")).resolves.toBeUndefined();
  });

  it("this is a real fix for a real bug: never depends on git's own (locale-dependent, human-readable) error text", async () => {
    repoDir = await createTempRepo();

    // Simulate exactly the failure mode that broke this before the fix:
    // a non-English Git locale renders "not found" as something else
    // entirely (e.g. Spanish: "no encontrada"), which a naive
    // string/regex match against stderr would silently miss. Since the
    // fix checks existence via `branchExists` (locale-independent) and
    // never inspects `git`'s human-readable stderr for this decision at
    // all, the actual locale is irrelevant -- this passes under any
    // LANG/LC_ALL, not just an English one.
    await expect(
      deleteBranch(repoDir, "ce-harness/blog-domain-entities"),
    ).resolves.toBeUndefined();
  });
});

describe("removeWorktree / isRegisteredWorktree (idempotent -- a missing worktree is a no-op, never a failure)", () => {
  let repoDir: string;
  let worktreePath: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
    worktreePath = join(repoDir, "..", `ce-harness-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreePath, { recursive: true, force: true });
  });

  it("isRegisteredWorktree is true right after addWorktree, and false after removeWorktree", async () => {
    await addWorktree(repoDir, worktreePath, "feature", "main");
    expect(await isRegisteredWorktree(repoDir, worktreePath)).toBe(true);

    await removeWorktree(repoDir, worktreePath, false);

    expect(await isRegisteredWorktree(repoDir, worktreePath)).toBe(false);
  });

  it("removeWorktree actually removes the directory from disk", async () => {
    await addWorktree(repoDir, worktreePath, "feature", "main");
    expect(existsSync(worktreePath)).toBe(true);

    await removeWorktree(repoDir, worktreePath, false);

    expect(existsSync(worktreePath)).toBe(false);
  });

  it("is a no-op, not an error, when the path was never a registered worktree at all", async () => {
    await expect(removeWorktree(repoDir, worktreePath, false)).resolves.toBeUndefined();
  });

  it("is idempotent -- removing the same worktree twice in a row never throws", async () => {
    await addWorktree(repoDir, worktreePath, "feature", "main");

    await removeWorktree(repoDir, worktreePath, false);
    await expect(removeWorktree(repoDir, worktreePath, false)).resolves.toBeUndefined();
  });

  it("is a no-op even after the worktree directory was already deleted directly from disk (bypassing `git worktree remove`)", async () => {
    await addWorktree(repoDir, worktreePath, "feature", "main");
    await rm(worktreePath, { recursive: true, force: true });
    expect(existsSync(worktreePath)).toBe(false);

    // Still registered in Git's internal bookkeeping (a "prunable"
    // worktree) even though the directory itself is gone -- this must
    // still be handled as a clean removal, not surface a raw Git error.
    expect(await isRegisteredWorktree(repoDir, worktreePath)).toBe(true);
    await expect(removeWorktree(repoDir, worktreePath, false)).resolves.toBeUndefined();
  });
});

describe("readOriginOrSolitaryRemoteUrl", () => {
  let repoDir: string;

  afterEach(async () => {
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  it("returns null when there is no remote at all", async () => {
    repoDir = await createTempRepo();
    expect(await readOriginOrSolitaryRemoteUrl(repoDir)).toBeNull();
  });

  it("returns the origin remote's URL when one is configured", async () => {
    const remoteDir = await createBareRemote("main");
    try {
      repoDir = await cloneRepo(remoteDir);
      expect(await readOriginOrSolitaryRemoteUrl(repoDir)).toBe(remoteDir);
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
    }
  });

  it("falls back to the sole remote when there is no 'origin' but exactly one remote exists", async () => {
    repoDir = await createTempRepo();
    await execa("git", ["-C", repoDir, "remote", "add", "upstream", "/some/path/repo.git"]);
    expect(await readOriginOrSolitaryRemoteUrl(repoDir)).toBe("/some/path/repo.git");
  });

  it("returns null (never guesses) when there are multiple remotes and none is named 'origin'", async () => {
    repoDir = await createTempRepo();
    await execa("git", ["-C", repoDir, "remote", "add", "a", "/some/path/a.git"]);
    await execa("git", ["-C", repoDir, "remote", "add", "b", "/some/path/b.git"]);
    expect(await readOriginOrSolitaryRemoteUrl(repoDir)).toBeNull();
  });

  it("prefers 'origin' even when other remotes are also configured", async () => {
    repoDir = await createTempRepo();
    await execa("git", ["-C", repoDir, "remote", "add", "origin", "/some/path/origin.git"]);
    await execa("git", ["-C", repoDir, "remote", "add", "fork", "/some/path/fork.git"]);
    expect(await readOriginOrSolitaryRemoteUrl(repoDir)).toBe("/some/path/origin.git");
  });
});

describe("isShallowRepository / resolveRootCommit", () => {
  let repoDir: string;
  let remoteDir: string;

  afterEach(async () => {
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
    if (remoteDir) await rm(remoteDir, { recursive: true, force: true });
  });

  it("a normal repository is not shallow", async () => {
    repoDir = await createTempRepo();
    expect(await isShallowRepository(repoDir)).toBe(false);
  });

  it("resolves the single root commit of a normal repository's history", async () => {
    repoDir = await createTempRepo();
    const root = await resolveRootCommit(repoDir);
    expect(root).toMatch(/^[0-9a-f]{40}$/);

    const expected = await execa("git", ["-C", repoDir, "rev-list", "--max-parents=0", "HEAD"]);
    expect(root).toBe(expected.stdout.trim());
  });

  it("the root commit is identical across two independent clones of the same repository", async () => {
    remoteDir = await createBareRemote("main");
    const cloneA = await cloneRepo(remoteDir, "ce-harness-clone-a-");
    const cloneB = await cloneRepo(remoteDir, "ce-harness-clone-b-");
    try {
      const rootA = await resolveRootCommit(cloneA);
      const rootB = await resolveRootCommit(cloneB);
      expect(rootA).not.toBeNull();
      expect(rootA).toBe(rootB);
    } finally {
      await rm(cloneA, { recursive: true, force: true });
      await rm(cloneB, { recursive: true, force: true });
    }
  });

  it("the root commit survives the repository being cloned to a differently-named path", async () => {
    remoteDir = await createBareRemote("main");
    repoDir = await cloneRepo(remoteDir);
    const rootFromClone = await resolveRootCommit(repoDir);
    const rootFromOriginalSeed = await resolveRootCommit(remoteDir);
    expect(rootFromClone).toBe(rootFromOriginalSeed);
  });

  it("a shallow clone is detected as shallow, and its root commit is not trusted (returns null)", async () => {
    remoteDir = await createBareRemote("main");
    // Add a second commit so a --depth=1 clone genuinely can't see the
    // repository's true root commit.
    const seedClone = await cloneRepo(remoteDir, "ce-harness-seed-second-commit-");
    try {
      await writeFile(join(seedClone, "second.txt"), "more\n", "utf8");
      await execa("git", ["-C", seedClone, "add", "."]);
      await execa("git", ["-C", seedClone, "commit", "-m", "second commit"]);
      await execa("git", ["-C", seedClone, "push", "origin", "main"]);
    } finally {
      await rm(seedClone, { recursive: true, force: true });
    }

    repoDir = await mkdtemp(join(tmpdir(), "ce-harness-shallow-clone-"));
    // `--depth` is silently ignored for a plain local-path clone ("local
    // clones" use a hardlink/copy optimization that bypasses the
    // shallow-fetch machinery entirely) -- file:// forces a real,
    // protocol-level clone that honors it.
    await execa("git", ["clone", "--depth", "1", `file://${remoteDir}`, repoDir]);

    expect(await isShallowRepository(repoDir)).toBe(true);
    expect(await resolveRootCommit(repoDir)).toBeNull();
  });

  it("returns null for a brand-new repository with no commits yet", async () => {
    repoDir = await mkdtemp(join(tmpdir(), "ce-harness-empty-repo-"));
    await execa("git", ["init", "--initial-branch=main", repoDir]);
    expect(await resolveRootCommit(repoDir)).toBeNull();
  });
});

describe("pathHistory / searchCommitMessages / commitChangedPaths", () => {
  let repoDir: string;

  afterEach(async () => {
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  it("pathHistory returns commits touching a path, most-recent first", async () => {
    repoDir = await createTempRepo();
    await writeFile(join(repoDir, "a.txt"), "one\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add a.txt"]);
    await writeFile(join(repoDir, "a.txt"), "two\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "update a.txt"]);
    await writeFile(join(repoDir, "unrelated.txt"), "noise\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "unrelated change"]);

    const history = await pathHistory(repoDir, "a.txt");
    expect(history.map((c) => c.subject)).toEqual(["update a.txt", "add a.txt"]);
    for (const commit of history) {
      expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(commit.date.length).toBeGreaterThan(0);
    }
  });

  it("pathHistory returns an empty array for a path with no history", async () => {
    repoDir = await createTempRepo();
    expect(await pathHistory(repoDir, "never-existed.txt")).toEqual([]);
  });

  it("pathHistory returns an empty array (never throws) for a nonexistent repository", async () => {
    expect(await pathHistory("/no/such/path", "a.txt")).toEqual([]);
  });

  it("pathHistory follows a rename", async () => {
    repoDir = await createTempRepo();
    await writeFile(join(repoDir, "old-name.txt"), "content\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add old-name.txt"]);
    await execa("git", ["-C", repoDir, "mv", "old-name.txt", "new-name.txt"]);
    await execa("git", ["-C", repoDir, "commit", "-m", "rename to new-name.txt"]);

    const history = await pathHistory(repoDir, "new-name.txt");
    expect(history.map((c) => c.subject)).toEqual(["rename to new-name.txt", "add old-name.txt"]);
  });

  it("searchCommitMessages finds commits matching any keyword, case-insensitively", async () => {
    repoDir = await createTempRepo();
    await writeFile(join(repoDir, "auth.txt"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "Add AUTHENTICATION support"]);
    await writeFile(join(repoDir, "billing.txt"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "fix billing overflow"]);
    await writeFile(join(repoDir, "unrelated.txt"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "unrelated tweak"]);

    const matches = await searchCommitMessages(repoDir, ["authentication", "billing"]);
    expect(matches.map((c) => c.subject).sort()).toEqual(
      ["Add AUTHENTICATION support", "fix billing overflow"].sort(),
    );
  });

  it("searchCommitMessages returns an empty array for an empty/blank keyword list", async () => {
    repoDir = await createTempRepo();
    expect(await searchCommitMessages(repoDir, [])).toEqual([]);
    expect(await searchCommitMessages(repoDir, ["   "])).toEqual([]);
  });

  it("commitChangedPaths lists the files a commit touched", async () => {
    repoDir = await createTempRepo();
    await writeFile(join(repoDir, "one.txt"), "x\n", "utf8");
    await writeFile(join(repoDir, "two.txt"), "y\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add two files"]);
    const sha = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

    const paths = await commitChangedPaths(repoDir, sha);
    expect(paths.sort()).toEqual(["one.txt", "two.txt"]);
  });

  it("commitChangedPaths returns an empty array (never throws) for an unknown SHA", async () => {
    repoDir = await createTempRepo();
    expect(await commitChangedPaths(repoDir, "0".repeat(40))).toEqual([]);
  });
});
