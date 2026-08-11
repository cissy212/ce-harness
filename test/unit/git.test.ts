import { rm, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBareRemote, cloneRepo, createTempRepo } from "../helpers/tempRepo.js";
import { CeError } from "../../src/core/errors.js";
import {
  detectBaseBranch,
  queryRemoteDefaultBranch,
  readCachedRemoteDefaultBranch,
  resolveCommit,
  resolveMergeBase,
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
});
