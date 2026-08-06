import { rm, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempRepo } from "../helpers/tempRepo.js";
import { CeError } from "../../src/core/errors.js";
import { resolveCommit, resolveMergeBase } from "../../src/core/git.js";

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
