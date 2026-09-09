import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { resolveDiffScope } from "../../src/core/diffScope.js";
import { createBareRemote, cloneRepo, createTempRepo } from "../helpers/tempRepo.js";

/**
 * Exercises `resolveDiffScope` -- the single source of truth `/verify` and
 * `/adversarial-review` both call into (via `ce diff-scope`) instead of
 * each restating this algorithm as inline bash+prose -- against real,
 * constructed Git repositories. A purely textual check (does the code
 * contain the right git subcommands, in the right order) would not have
 * caught the original bug this suite was written to guard against: the
 * old prose also "contained the right commands," it just picked the wrong
 * one when both candidates resolved. This proves the actual git behavior
 * is correct for every case that matters, not just that the source
 * mentions the right commands.
 */

async function rev(repoDir: string, ref: string): Promise<string> {
  return (await execa("git", ["-C", repoDir, "rev-parse", ref])).stdout.trim();
}

describe("resolveDiffScope: $CE_BASE_BRANCH vs origin/$CE_BASE_BRANCH divergence, executed for real", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    cleanupDirs.length = 0;
  });

  it("local base branch stale, origin/<base> current: prefers origin/<base> (the reported bug)", async () => {
    const remoteDir = await createBareRemote("develop");
    const workRepo = await cloneRepo(remoteDir);
    const prAuthor = await cloneRepo(remoteDir);
    cleanupDirs.push(remoteDir, workRepo, prAuthor);

    // A PR lands on origin's develop, authored/pushed by someone else,
    // strictly after workRepo's own local `develop` was last synced.
    await execa("git", ["-C", prAuthor, "checkout", "develop"]);
    await writeFile(join(prAuthor, "pr-1658.txt"), "already merged upstream\n", "utf8");
    await execa("git", ["-C", prAuthor, "add", "."]);
    await execa("git", ["-C", prAuthor, "commit", "-m", "PR #1658"]);
    await execa("git", ["-C", prAuthor, "push", "origin", "develop"]);

    // workRepo fetches (updating origin/develop) but never touches its
    // own local `develop`, and its internal branch was seeded from the
    // now-current origin/develop tip -- exactly the real Oz topology.
    await execa("git", ["-C", workRepo, "fetch", "origin"]);
    await execa("git", ["-C", workRepo, "checkout", "-b", "ce-harness/hano", "origin/develop"]);

    const originTip = await rev(workRepo, "origin/develop");
    const staleLocalTip = await rev(workRepo, "develop");
    expect(originTip).not.toBe(staleLocalTip); // sanity: the scenario is genuinely divergent

    const result = await resolveDiffScope(workRepo, { baseBranch: "develop" });
    expect(result.mode).toBe("merge-base");
    expect(result.base).toBe(originTip);
    expect(result.base).not.toBe(staleLocalTip);
    expect(result.baseSource).toBe("origin/develop");
    expect(result.diffRange).toBe(`${originTip}...HEAD`);
  });

  it("local base branch ahead of origin/<base> (unpushed integration work): prefers local -- never assumes origin always wins", async () => {
    const remoteDir = await createBareRemote("develop");
    const workRepo = await cloneRepo(remoteDir);
    cleanupDirs.push(remoteDir, workRepo);

    await execa("git", ["-C", workRepo, "checkout", "develop"]);
    await writeFile(join(workRepo, "local-only.txt"), "unpushed local work\n", "utf8");
    await execa("git", ["-C", workRepo, "add", "."]);
    await execa("git", ["-C", workRepo, "commit", "-m", "local integration work"]);
    await execa("git", ["-C", workRepo, "checkout", "-b", "ce-harness/hano", "develop"]);

    const localTip = await rev(workRepo, "develop");
    const originTip = await rev(workRepo, "origin/develop");
    expect(localTip).not.toBe(originTip);

    const result = await resolveDiffScope(workRepo, { baseBranch: "develop" });
    expect(result.mode).toBe("merge-base");
    expect(result.base).toBe(localTip);
    expect(result.baseSource).toBe("develop");
  });

  it("local and origin/<base> equal: resolves to that shared commit (no ambiguity)", async () => {
    const remoteDir = await createBareRemote("develop");
    const workRepo = await cloneRepo(remoteDir);
    cleanupDirs.push(remoteDir, workRepo);

    await execa("git", ["-C", workRepo, "checkout", "-b", "ce-harness/hano", "develop"]);

    const developTip = await rev(workRepo, "develop");
    expect(developTip).toBe(await rev(workRepo, "origin/develop"));

    const result = await resolveDiffScope(workRepo, { baseBranch: "develop" });
    expect(result.mode).toBe("merge-base");
    expect(result.base).toBe(developTip);
  });

  it("truly diverged in both directions (neither an ancestor of the other): keeps the documented default (local)", async () => {
    const remoteDir = await createBareRemote("develop");
    const workRepo = await cloneRepo(remoteDir);
    const otherAuthor = await cloneRepo(remoteDir);
    cleanupDirs.push(remoteDir, workRepo, otherAuthor);

    await execa("git", ["-C", workRepo, "checkout", "develop"]);
    await writeFile(join(workRepo, "local-diverge.txt"), "local-only\n", "utf8");
    await execa("git", ["-C", workRepo, "add", "."]);
    await execa("git", ["-C", workRepo, "commit", "-m", "local diverge"]);
    const localTip = await rev(workRepo, "develop");

    await execa("git", ["-C", otherAuthor, "checkout", "develop"]);
    await writeFile(join(otherAuthor, "origin-diverge.txt"), "origin-only\n", "utf8");
    await execa("git", ["-C", otherAuthor, "add", "."]);
    await execa("git", ["-C", otherAuthor, "commit", "-m", "origin diverge"]);
    await execa("git", ["-C", otherAuthor, "push", "origin", "develop"]);

    await execa("git", ["-C", workRepo, "fetch", "origin"]);
    const originTip = await rev(workRepo, "origin/develop");
    expect(originTip).not.toBe(localTip);
    // Sanity: genuinely diverged, neither is an ancestor of the other.
    const localIsAncestor = await execa(
      "git",
      ["-C", workRepo, "merge-base", "--is-ancestor", "develop", "origin/develop"],
      { reject: false },
    );
    const originIsAncestor = await execa(
      "git",
      ["-C", workRepo, "merge-base", "--is-ancestor", "origin/develop", "develop"],
      { reject: false },
    );
    expect(localIsAncestor.exitCode).not.toBe(0);
    expect(originIsAncestor.exitCode).not.toBe(0);

    await execa("git", ["-C", workRepo, "checkout", "-b", "ce-harness/hano", "develop"]);

    const result = await resolveDiffScope(workRepo, { baseBranch: "develop" });
    expect(result.mode).toBe("merge-base");
    expect(result.base).toBe(localTip);
    expect(result.baseSource).toBe("develop");
  });

  it("only the local base branch exists (no remote at all): resolves via the local branch", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);

    await execa("git", ["-C", repoDir, "checkout", "-b", "develop", "main"]);
    await writeFile(join(repoDir, "develop-only.txt"), "develop work\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "develop-only commit"]);
    const developTip = await rev(repoDir, "develop");
    await execa("git", ["-C", repoDir, "checkout", "-b", "ce-harness/hano", "develop"]);

    const result = await resolveDiffScope(repoDir, { baseBranch: "develop" });
    expect(result.mode).toBe("merge-base");
    expect(result.base).toBe(developTip);
    expect(result.baseSource).toBe("develop");
  });

  it("only origin/<base> exists (no local branch by that name): resolves via the remote-tracking ref", async () => {
    const remoteSeed = await createTempRepo("ce-harness-remote-seed-");
    cleanupDirs.push(remoteSeed);
    await execa("git", ["-C", remoteSeed, "checkout", "-b", "develop", "main"]);
    await writeFile(join(remoteSeed, "develop.txt"), "develop\n", "utf8");
    await execa("git", ["-C", remoteSeed, "add", "."]);
    await execa("git", ["-C", remoteSeed, "commit", "-m", "develop commit"]);
    await execa("git", ["-C", remoteSeed, "checkout", "main"]);

    // A clone only creates a local branch for the checked-out-at-clone-time
    // branch ("main" here); "develop" is present only as origin/develop.
    const workRepo = await cloneRepo(remoteSeed);
    cleanupDirs.push(workRepo);

    const localDevelop = await execa("git", ["-C", workRepo, "rev-parse", "--verify", "develop"], {
      reject: false,
    });
    expect(localDevelop.exitCode).not.toBe(0); // sanity: no local "develop" branch exists

    const originDevelopTip = await rev(workRepo, "origin/develop");
    await execa("git", ["-C", workRepo, "checkout", "-b", "ce-harness/hano", "origin/develop"]);

    const result = await resolveDiffScope(workRepo, { baseBranch: "develop" });
    expect(result.mode).toBe("merge-base");
    expect(result.base).toBe(originDevelopTip);
    expect(result.baseSource).toBe("origin/develop");
  });

  it("CE_BASE_BRANCH resolves to nothing at all: falls through to the main/master fallback", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);

    const result = await resolveDiffScope(repoDir, { baseBranch: "develop" }); // no such branch, no remote at all
    expect(result.mode).toBe("merge-base");
    expect(result.baseSource).toBe("main");
    expect(result.base).toBe(await rev(repoDir, "main"));
  });

  it("no base branch and no main/master resolve: reports a scope limitation instead of guessing", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);

    await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
    await execa("git", ["-C", repoDir, "branch", "-D", "main"]);

    const result = await resolveDiffScope(repoDir, {});
    expect(result.mode).toBe("no-base");
    expect(result.diffRange).toBeNull();
    expect(result.base).toBeNull();
    expect(result.scopeLimitation).toMatch(/main/);
    expect(result.scopeLimitation).toMatch(/master/);
  });

  it("explicit CE_DIFF_BASE/CE_DIFF_HEAD takes priority over CE_BASE_BRANCH, using three-dot for the diff and two-dot for the log", async () => {
    // No repository access at all is needed for this branch -- proof that
    // it truly skips base-branch detection entirely, not just "usually".
    const result = await resolveDiffScope("/nonexistent/path/never/touched", {
      diffBase: "abc123",
      diffHead: "def456",
      baseBranch: "develop",
    });

    expect(result.mode).toBe("explicit");
    expect(result.diffRange).toBe("abc123...def456");
    expect(result.logRange).toBe("abc123..def456");
    expect(result.base).toBe("abc123");
  });
});
