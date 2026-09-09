import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBareRemote, cloneRepo, createTempRepo } from "../helpers/tempRepo.js";
import { CeError } from "../../src/core/errors.js";
import {
  addLocalExcludePattern,
  commitAllChanges,
  commitChangedPaths,
  addWorktree,
  branchExists,
  computeWorktreeFingerprint,
  deleteBranch,
  detectBaseBranch,
  diffNameStatus,
  fetchRemoteBranch,
  hasInProgressMergeOrRebase,
  isDirty,
  isRegisteredWorktree,
  isShallowRepository,
  logRange,
  mergeRef,
  pushBranch,
  queryRemoteDefaultBranch,
  readCachedRemoteDefaultBranch,
  readOriginOrSolitaryRemoteUrl,
  removeWorktree,
  pathHistory,
  searchCommitMessages,
  resolveCommit,
  resolveMergeBase,
  resolveRootCommit,
  statusPorcelain,
  isAncestor,
  tryMergeBase,
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

describe("tryMergeBase / isAncestor", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("tryMergeBase resolves the same merge base resolveMergeBase would, without throwing", async () => {
    const commonAncestor = await resolveCommit(repoDir, "main");
    await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
    await writeFile(`${repoDir}/feature-only.txt`, "feature change\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "feature-only change"]);

    expect(await tryMergeBase(repoDir, "main", "feature")).toBe(commonAncestor);
  });

  it("tryMergeBase returns null (never throws) when a ref does not resolve at all", async () => {
    await expect(tryMergeBase(repoDir, "HEAD", "does-not-exist-anywhere")).resolves.toBeNull();
  });

  it("tryMergeBase returns null (never throws) when the two commits share no common history", async () => {
    const headSha = await resolveCommit(repoDir, "main");
    await execa("git", ["-C", repoDir, "checkout", "--orphan", "unrelated"]);
    await execa("git", ["-C", repoDir, "rm", "-rf", "."]);
    await writeFile(`${repoDir}/unrelated.txt`, "no shared history\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "unrelated root commit"]);

    await expect(tryMergeBase(repoDir, "unrelated", headSha)).resolves.toBeNull();
  });

  it("isAncestor is true when the first ref is an ancestor of the second", async () => {
    const rootSha = await resolveCommit(repoDir, "main");
    await writeFile(`${repoDir}/more.txt`, "more\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "second commit"]);

    expect(await isAncestor(repoDir, rootSha, "main")).toBe(true);
  });

  it("isAncestor is false when neither commit descends from the other", async () => {
    await execa("git", ["-C", repoDir, "checkout", "-b", "base-side"]);
    await writeFile(`${repoDir}/base-only.txt`, "base change\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "base-only change"]);

    await execa("git", ["-C", repoDir, "checkout", "main"]);
    await execa("git", ["-C", repoDir, "checkout", "-b", "head-side"]);
    await writeFile(`${repoDir}/head-only.txt`, "head change\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "head-only change"]);

    expect(await isAncestor(repoDir, "base-side", "head-side")).toBe(false);
    expect(await isAncestor(repoDir, "head-side", "base-side")).toBe(false);
  });

  it("isAncestor is false (never throws) when a ref does not resolve at all", async () => {
    await expect(isAncestor(repoDir, "does-not-exist", "main")).resolves.toBe(false);
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

  it('a repository whose remote defaults to "develop" (never "main") resolves to "develop", via the freshly-fetched origin/develop', async () => {
    remoteDir = await createBareRemote("develop");
    repoDir = await cloneRepo(remoteDir);

    expect(await queryRemoteDefaultBranch(repoDir)).toBe("develop");
    await expect(detectBaseBranch(repoDir)).resolves.toEqual({ name: "develop", ref: "origin/develop" });

    // No "main" branch exists anywhere in this repository -- confirms
    // the result is not coincidentally reachable via the old hardcoded
    // fallback.
    const branches = (await execa("git", ["-C", repoDir, "branch", "--list"])).stdout;
    expect(branches).not.toMatch(/\bmain\b/);
  });

  it('a repository whose remote defaults to "main" continues to resolve to "main" unchanged, via the freshly-fetched origin/main', async () => {
    remoteDir = await createBareRemote("main");
    repoDir = await cloneRepo(remoteDir);

    expect(await queryRemoteDefaultBranch(repoDir)).toBe("main");
    await expect(detectBaseBranch(repoDir)).resolves.toEqual({ name: "main", ref: "origin/main" });
  });

  it("resolves to the CURRENT remote commit, not a stale local base branch that was never re-fetched (the reported bug)", async () => {
    remoteDir = await createBareRemote("main");
    repoDir = await cloneRepo(remoteDir);
    const staleCommit = await resolveCommit(repoDir, "main");

    // Someone else pushes new work to origin/main -- repoDir's own local
    // "main" (and its cached origin/main remote-tracking ref) are both
    // now stale; nothing in repoDir has fetched since the clone.
    const upstream = await cloneRepo(remoteDir, "ce-harness-upstream-");
    await writeFile(join(upstream, "new-file.txt"), "x\n", "utf8");
    await execa("git", ["-C", upstream, "add", "."]);
    await execa("git", ["-C", upstream, "commit", "-m", "advance remote main"]);
    await execa("git", ["-C", upstream, "push", "origin", "main"]);
    await rm(upstream, { recursive: true, force: true });

    // Sanity: repoDir's own view is still stale, confirming this test
    // actually exercises staleness rather than a no-op.
    expect(await resolveCommit(repoDir, "main")).toBe(staleCommit);

    const detected = await detectBaseBranch(repoDir);
    const resolvedCommit = await resolveCommit(repoDir, detected!.ref);

    expect(resolvedCommit).not.toBe(staleCommit);
    // Also confirms the local "main" branch itself was never touched --
    // ce start's default flow reads from origin/main, it doesn't rewrite
    // or fast-forward any local branch.
    expect(await resolveCommit(repoDir, "main")).toBe(staleCommit);
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

  it("no longer stops at 'not resolvable locally' -- it fetches the detected branch itself and succeeds once the remote actually has it", async () => {
    remoteDir = await createBareRemote("develop");
    repoDir = await cloneRepo(remoteDir);

    // The remote's default branch changes after the clone, to a branch
    // the local clone has never fetched -- neither a local branch nor a
    // remote-tracking ref for it exists yet.
    await execa("git", ["-C", remoteDir, "branch", "main"]);
    await execa("git", ["-C", remoteDir, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const branchesBefore = (await execa("git", ["-C", repoDir, "branch", "--list"])).stdout;
    expect(branchesBefore).not.toMatch(/\bmain\b/);

    // detectBaseBranch fetches "main" itself now -- since the remote
    // genuinely has it, this succeeds rather than throwing.
    await expect(detectBaseBranch(repoDir)).resolves.toEqual({ name: "main", ref: "origin/main" });
  });

  it("throws a clear, actionable error when the remote can't be reached to fetch the detected base branch", async () => {
    remoteDir = await createBareRemote("develop");
    repoDir = await cloneRepo(remoteDir);
    // repoDir's cached origin/HEAD says "develop" from the clone.
    expect(await readCachedRemoteDefaultBranch(repoDir)).toBe("develop");

    // Simulate an unreachable remote (deleted, offline, network down) --
    // point origin at a path that no longer exists.
    const goneRemote = remoteDir;
    remoteDir = undefined;
    await rm(goneRemote, { recursive: true, force: true });
    await execa("git", ["-C", repoDir, "remote", "set-url", "origin", join(goneRemote, "does-not-exist")]);

    await expect(detectBaseBranch(repoDir)).rejects.toThrow(CeError);
    try {
      await detectBaseBranch(repoDir);
      expect.fail("expected detectBaseBranch to throw");
    } catch (error) {
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/Could not fetch "origin\/develop"/);
      expect(ceError.message).toMatch(/establish the current remote base/);
      expect(ceError.recovery).toMatch(/--from/);
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

    await expect(detectBaseBranch(repoDir)).resolves.toEqual({ name: "develop", ref: "origin/develop" });
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

describe("ce publish's git primitives", () => {
  let repoDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
    remoteDir = await createBareRemote("main");
    await execa("git", ["-C", repoDir, "remote", "add", "origin", remoteDir]);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  });

  describe("fetchRemoteBranch", () => {
    it("updates the normal remote-tracking ref, resolvable via resolveCommit afterward", async () => {
      // Advance the bare remote's main independently of repoDir's clone.
      const seed = await cloneRepo(remoteDir, "ce-harness-seed-");
      await writeFile(join(seed, "remote-change.txt"), "x\n", "utf8");
      await execa("git", ["-C", seed, "add", "."]);
      await execa("git", ["-C", seed, "commit", "-m", "remote advance"]);
      await execa("git", ["-C", seed, "push", "origin", "main"]);
      const remoteHead = (await execa("git", ["-C", seed, "rev-parse", "main"])).stdout.trim();
      await rm(seed, { recursive: true, force: true });

      await fetchRemoteBranch(repoDir, "origin", "main");
      expect(await resolveCommit(repoDir, "origin/main")).toBe(remoteHead);
    });
  });

  describe("hasInProgressMergeOrRebase", () => {
    it("is false for a clean repository", async () => {
      expect(await hasInProgressMergeOrRebase(repoDir)).toBe(false);
    });

    it("is true while a conflicting merge is unresolved", async () => {
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      await writeFile(join(repoDir, "README.md"), "feature version\n", "utf8");
      await execa("git", ["-C", repoDir, "commit", "-am", "feature change"]);
      await execa("git", ["-C", repoDir, "checkout", "main"]);
      await writeFile(join(repoDir, "README.md"), "main version\n", "utf8");
      await execa("git", ["-C", repoDir, "commit", "-am", "main change"]);

      await execa("git", ["-C", repoDir, "merge", "feature"], { reject: false });
      expect(await hasInProgressMergeOrRebase(repoDir)).toBe(true);

      await execa("git", ["-C", repoDir, "merge", "--abort"]);
      expect(await hasInProgressMergeOrRebase(repoDir)).toBe(false);
    });
  });

  describe("mergeRef", () => {
    it("cleanly merges a fast-forwardable/non-conflicting ref, creating a merge commit", async () => {
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      await writeFile(join(repoDir, "feature.txt"), "x\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "feature work"]);
      await execa("git", ["-C", repoDir, "checkout", "main"]);
      await writeFile(join(repoDir, "unrelated.txt"), "y\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "unrelated main work"]);
      await execa("git", ["-C", repoDir, "checkout", "feature"]);

      const result = await mergeRef(repoDir, "main");
      expect(result.merged).toBe(true);
      expect(existsSync(join(repoDir, "feature.txt"))).toBe(true);
      expect(existsSync(join(repoDir, "unrelated.txt"))).toBe(true);
      expect(await hasInProgressMergeOrRebase(repoDir)).toBe(false);
    });

    it("aborts cleanly on conflict, leaving the worktree exactly as it was", async () => {
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      await writeFile(join(repoDir, "README.md"), "feature version\n", "utf8");
      await execa("git", ["-C", repoDir, "commit", "-am", "feature change"]);
      await execa("git", ["-C", repoDir, "checkout", "main"]);
      await writeFile(join(repoDir, "README.md"), "main version\n", "utf8");
      await execa("git", ["-C", repoDir, "commit", "-am", "main change"]);
      await execa("git", ["-C", repoDir, "checkout", "feature"]);
      const headBefore = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

      const result = await mergeRef(repoDir, "main");
      expect(result.merged).toBe(false);
      expect(await hasInProgressMergeOrRebase(repoDir)).toBe(false);
      expect((await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
      expect(await isDirty(repoDir)).toBe(false);
    });
  });

  describe("commitAllChanges", () => {
    it("stages and commits tracked and untracked changes under the given message", async () => {
      await writeFile(join(repoDir, "README.md"), "changed\n", "utf8");
      await writeFile(join(repoDir, "new-file.txt"), "new\n", "utf8");

      await commitAllChanges(repoDir, "publish: apply verified changes");

      expect(await isDirty(repoDir)).toBe(false);
      const log = await execa("git", ["-C", repoDir, "log", "-1", "--pretty=%s"]);
      expect(log.stdout.trim()).toBe("publish: apply verified changes");
    });
  });

  describe("pushBranch", () => {
    it("pushes a local branch to the remote under a different, explicit remote branch name", async () => {
      await execa("git", ["-C", repoDir, "checkout", "-b", "internal-branch"]);
      await writeFile(join(repoDir, "feature.txt"), "x\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "feature work"]);
      const localHead = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

      await pushBranch(repoDir, "origin", "internal-branch", "feature/130-example");

      const remoteRef = await execa("git", [
        "-C",
        remoteDir,
        "rev-parse",
        "refs/heads/feature/130-example",
      ]);
      expect(remoteRef.stdout.trim()).toBe(localHead);
      // The internal branch name itself must never appear as a ref on the remote.
      const remoteBranches = await execa("git", ["-C", remoteDir, "branch", "--list"]);
      expect(remoteBranches.stdout).not.toContain("internal-branch");
    });

    it("a second push after new commits is a plain fast-forward (no force needed)", async () => {
      await execa("git", ["-C", repoDir, "checkout", "-b", "internal-branch"]);
      await writeFile(join(repoDir, "one.txt"), "x\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "first"]);
      await pushBranch(repoDir, "origin", "internal-branch", "feature/130-example");

      await writeFile(join(repoDir, "two.txt"), "y\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "second"]);
      const localHead = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

      await expect(pushBranch(repoDir, "origin", "internal-branch", "feature/130-example")).resolves.not.toThrow();
      const remoteRef = await execa("git", [
        "-C",
        remoteDir,
        "rev-parse",
        "refs/heads/feature/130-example",
      ]);
      expect(remoteRef.stdout.trim()).toBe(localHead);
    });
  });

  describe("computeWorktreeFingerprint", () => {
    it("is stable when nothing changes", async () => {
      const first = await computeWorktreeFingerprint(repoDir);
      const second = await computeWorktreeFingerprint(repoDir);
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{12}$/);
    });

    it("changes when HEAD moves", async () => {
      const before = await computeWorktreeFingerprint(repoDir);
      await writeFile(join(repoDir, "committed.txt"), "x\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "add committed.txt"]);
      expect(await computeWorktreeFingerprint(repoDir)).not.toBe(before);
    });

    it("changes when an already-tracked file is modified (uncommitted, unstaged)", async () => {
      const before = await computeWorktreeFingerprint(repoDir);
      await writeFile(join(repoDir, "README.md"), "modified\n", "utf8");
      expect(await computeWorktreeFingerprint(repoDir)).not.toBe(before);
    });

    it("changes when an already-tracked file is modified and staged", async () => {
      const before = await computeWorktreeFingerprint(repoDir);
      await writeFile(join(repoDir, "README.md"), "staged change\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      expect(await computeWorktreeFingerprint(repoDir)).not.toBe(before);
    });

    it("changes when a new untracked file is added", async () => {
      const before = await computeWorktreeFingerprint(repoDir);
      await writeFile(join(repoDir, "new-untracked.txt"), "content\n", "utf8");
      expect(await computeWorktreeFingerprint(repoDir)).not.toBe(before);
    });

    it("changes when an existing untracked file's content is modified (name unchanged)", async () => {
      await writeFile(join(repoDir, "scratch.txt"), "v1\n", "utf8");
      const before = await computeWorktreeFingerprint(repoDir);
      await writeFile(join(repoDir, "scratch.txt"), "v2\n", "utf8");
      expect(await computeWorktreeFingerprint(repoDir)).not.toBe(before);
    });

    it("is unaffected by an ignored, untracked file", async () => {
      await writeFile(join(repoDir, ".gitignore"), "ignored.txt\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "add gitignore"]);

      const before = await computeWorktreeFingerprint(repoDir);
      await writeFile(join(repoDir, "ignored.txt"), "should not affect the fingerprint\n", "utf8");
      expect(await computeWorktreeFingerprint(repoDir)).toBe(before);
    });
  });

  describe("logRange / diffNameStatus", () => {
    it("logRange lists only the non-merge commits reachable from toRef but not fromRef", async () => {
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      await writeFile(join(repoDir, "a.txt"), "1\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "add a"]);
      await writeFile(join(repoDir, "b.txt"), "2\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "add b"]);

      const commits = await logRange(repoDir, "main", "feature");
      expect(commits.map((c) => c.subject).sort()).toEqual(["add a", "add b"]);
    });

    it("logRange excludes a merge commit from the range", async () => {
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      await writeFile(join(repoDir, "a.txt"), "1\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "add a"]);
      await execa("git", ["-C", repoDir, "checkout", "main"]);
      await writeFile(join(repoDir, "unrelated.txt"), "x\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "unrelated"]);
      await execa("git", ["-C", repoDir, "checkout", "feature"]);
      const result = await mergeRef(repoDir, "main");
      expect(result.merged).toBe(true);

      const commits = await logRange(repoDir, "main", "feature");
      expect(commits.map((c) => c.subject)).toEqual(["add a"]);
    });

    it("diffNameStatus reports the changed files between two refs", async () => {
      await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
      await writeFile(join(repoDir, "a.txt"), "1\n", "utf8");
      await writeFile(join(repoDir, "b.txt"), "2\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "add a and b"]);

      const files = await diffNameStatus(repoDir, "main", "feature");
      expect(files.sort()).toEqual(["a.txt", "b.txt"]);
    });
  });

  describe("statusPorcelain", () => {
    it("preserves the leading space of an unstaged-only modification's status code when it is the *only* (and therefore first) line -- regression for a real bug where a whole-string .trim() ate that space, shifting every downstream line-slicing consumer by one character (e.g. \"apps/...\" parsed as \"pps/...\")", async () => {
      await mkdirAndWrite(repoDir, "apps/dashboard/a.txt", "original\n");
      await execa("git", ["-C", repoDir, "add", "apps/dashboard/a.txt"]);
      await execa("git", ["-C", repoDir, "commit", "-m", "add a.txt"]);
      await writeFile(join(repoDir, "apps/dashboard/a.txt"), "modified\n", "utf8");

      const lines = await statusPorcelain(repoDir);
      expect(lines).toEqual([" M apps/dashboard/a.txt"]);
      // The exact assumption every consumer (core/worktreeArtifacts.ts's
      // porcelainLinePath, commands/publish.ts's porcelainPaths) makes:
      // a fixed 3-character "XY " prefix, so the path itself must start
      // at index 3, untouched.
      expect(lines[0].slice(3)).toBe("apps/dashboard/a.txt");
    });

    it("preserves every line when an unstaged modification (leading space) sorts first, ahead of a staged addition and an untracked file", async () => {
      await mkdirAndWrite(repoDir, "apps/dashboard/a.txt", "original\n");
      await execa("git", ["-C", repoDir, "add", "apps/dashboard/a.txt"]);
      await execa("git", ["-C", repoDir, "commit", "-m", "add a.txt"]);

      await writeFile(join(repoDir, "apps/dashboard/a.txt"), "modified\n", "utf8");
      await mkdirAndWrite(repoDir, "apps/new/b.txt", "new\n");
      await execa("git", ["-C", repoDir, "add", "apps/new/b.txt"]);
      await mkdirAndWrite(repoDir, "apps/dashboard/c.txt", "untracked\n");

      const lines = await statusPorcelain(repoDir);
      expect(lines.sort()).toEqual(
        ["?? apps/dashboard/c.txt", " M apps/dashboard/a.txt", "A  apps/new/b.txt"].sort(),
      );
      for (const line of lines) {
        expect(line.slice(3).length).toBeGreaterThan(0);
      }
    });

    it("returns an empty array for a clean tree", async () => {
      expect(await statusPorcelain(repoDir)).toEqual([]);
    });
  });
});

async function mkdirAndWrite(repoDir: string, relativePath: string, content: string): Promise<void> {
  const full = join(repoDir, relativePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}
