import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { detectReviewTransition, resolveDiffScope } from "../../src/core/diffScope.js";
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


  it("a detected review transition overrides the explicit range, using the RECORDED IMPLEMENTATION BASE as the merge-base reference -- never the original review's diffBase", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    const originalReviewBase = await rev(repoDir, "main"); // "B" -- what the review's own diffBase would be

    // "C" -- an unrelated commit that landed on the trunk after the
    // original review base but before /apply started implementing.
    await writeFile(join(repoDir, "unrelated-pr-123.txt"), "unrelated change\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "unrelated PR #123"]);

    // "D" -- the trunk's tip at the moment /apply actually started
    // implementing (recorded as the implementation base).
    await writeFile(join(repoDir, "unrelated-pr-126.txt"), "another unrelated change\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "unrelated PR #126"]);
    const implementationBase = await rev(repoDir, "main"); // "D"

    // "E" -- the repaired implementation, built from current trunk.
    await writeFile(join(repoDir, "about-us.html"), "<h1>About us</h1>\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "Add about-us page"]);

    const result = await resolveDiffScope(repoDir, {
      diffBase: originalReviewBase, // "B" -- must NOT be used once transitioned
      diffHead: originalReviewBase, // the original PR's own head -- irrelevant once transitioned
      reviewTransition: {
        detected: true,
        changeName: "about-us-page",
        implementationBase,
        reason: "test",
      },
    });

    expect(result.mode).toBe("merge-base");
    expect(result.base).toBe(implementationBase); // "D", never "B"
    expect(result.base).not.toBe(originalReviewBase);
    expect(result.baseSource).toMatch(/recorded implementation base/);
    expect(result.diffRange).toBe(`${implementationBase}...HEAD`);

    // Prove it in terms of actual content, not just SHAs: the resolved
    // range must exclude both unrelated commits ("C" and "D"'s own
    // content) and include only "E"'s real change.
    const filesInRange = (
      await execa("git", ["-C", repoDir, "diff", "--name-only", result.diffRange!])
    ).stdout.trim();
    expect(filesInRange).toBe("about-us.html");
    expect(filesInRange).not.toContain("unrelated-pr-123.txt");
    expect(filesInRange).not.toContain("unrelated-pr-126.txt");
  });

  it("reviewTransition is passed through unchanged on every branch (explicit, merge-base without a transition, and no-base)", async () => {
    const explicit = await resolveDiffScope("/nonexistent/path/never/touched", {
      diffBase: "abc",
      diffHead: "def",
      reviewTransition: null,
    });
    expect(explicit.mode).toBe("explicit");
    expect(explicit.reviewTransition).toBeNull();

    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    const noTransition = await resolveDiffScope(repoDir, {});
    expect(noTransition.reviewTransition).toBeNull();
  });

  it("falls back to no-base if the recorded implementation base doesn't resolve to a real merge base (defensive -- should not happen in practice)", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    await execa("git", ["-C", repoDir, "checkout", "-b", "feature"]);
    await execa("git", ["-C", repoDir, "branch", "-D", "main"]);

    const result = await resolveDiffScope(repoDir, {
      diffBase: "irrelevant",
      diffHead: "irrelevant",
      reviewTransition: {
        detected: true,
        changeName: "x",
        implementationBase: "0000000000000000000000000000000000000000",
        reason: "test",
      },
    });

    expect(result.mode).toBe("no-base");
    expect(result.scopeLimitation).toMatch(/recorded implementation base/);
  });
});

describe("detectReviewTransition (review workspace -> implementation transition, via /apply's implementation-base marker)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    cleanupDirs.length = 0;
  });

  async function setupDurableRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "ce-harness-durable-"));
  }

  async function writeOwnedChange(
    durableRoot: string,
    changeName: string,
    project: string,
    issue: string,
    options: { proposeProvenance?: boolean; implementationBase?: string; malformedMarker?: boolean } = {},
  ): Promise<void> {
    const changeRoot = join(durableRoot, "openspec", "changes", changeName);
    await mkdir(changeRoot, { recursive: true });
    await writeFile(join(changeRoot, ".ce-workspace.yml"), `project: "${project}"\nissue: "${issue}"\n`, "utf8");
    if (options.proposeProvenance) {
      await writeFile(
        join(changeRoot, ".ce-provenance-propose.yml"),
        'commit: "deadbeef"\nfingerprint: "abc123456789"\nrecordedAt: "2026-01-01"\n',
        "utf8",
      );
    }
    if (options.implementationBase) {
      await writeFile(
        join(changeRoot, ".ce-implementation-base.yml"),
        `baseCommit: "${options.implementationBase}"\nrecordedAt: "2026-01-02"\n`,
        "utf8",
      );
    }
    if (options.malformedMarker) {
      await writeFile(join(changeRoot, ".ce-implementation-base.yml"), "not: valid\nfor: this shape\n", "utf8");
    }
  }

  it("no active change owned by this workspace: not detected", async () => {
    const durableRoot = await setupDurableRoot();
    cleanupDirs.push(durableRoot);

    const result = await detectReviewTransition(durableRoot, "proj", "124");

    expect(result.detected).toBe(false);
    expect(result.changeName).toBeNull();
    expect(result.implementationBase).toBeNull();
    expect(result.reason).toMatch(/no active OpenSpec change is owned/);
  });

  it("an active change exists with no implementation-base marker at all: not detected", async () => {
    const durableRoot = await setupDurableRoot();
    cleanupDirs.push(durableRoot);
    await writeOwnedChange(durableRoot, "fix-the-thing", "proj", "124", {});

    const result = await detectReviewTransition(durableRoot, "proj", "124");

    expect(result.detected).toBe(false);
    expect(result.implementationBase).toBeNull();
    expect(result.reason).toMatch(/no active change has an\s*\n?\s*\/apply-recorded implementation-base marker/);
  });

  it("FALSE POSITIVE regression: a validated /propose plan plus a worktree/history change (e.g. a hand-edit after /propose) is NOT detected without the dedicated marker -- generic divergence must never unlock /verify", async () => {
    const repoDir = await createTempRepo();
    const durableRoot = await setupDurableRoot();
    cleanupDirs.push(repoDir, durableRoot);

    // /propose ran and validated a plan...
    await writeOwnedChange(durableRoot, "fix-the-thing", "proj", "124", { proposeProvenance: true });

    // ...then the user (or anything other than /apply) hand-edited a
    // file and committed it -- exactly the false-positive scenario the
    // old (worktree-divergence-based) model would have wrongly accepted.
    await writeFile(join(repoDir, "hand-edited.txt"), "not through /apply\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "manual edit, not /apply"]);

    const result = await detectReviewTransition(durableRoot, "proj", "124");

    expect(result.detected).toBe(false);
    expect(result.changeName).toBeNull();
    expect(result.implementationBase).toBeNull();
  });

  it("FALSE POSITIVE regression: /propose provenance plus an untouched worktree is still NOT detected (no implementation has been produced yet, and no marker exists)", async () => {
    const durableRoot = await setupDurableRoot();
    cleanupDirs.push(durableRoot);
    await writeOwnedChange(durableRoot, "fix-the-thing", "proj", "124", { proposeProvenance: true });

    const result = await detectReviewTransition(durableRoot, "proj", "124");

    expect(result.detected).toBe(false);
  });

  it("an implementation-base marker exists: detected, with implementationBase set to exactly the recorded baseCommit", async () => {
    const durableRoot = await setupDurableRoot();
    cleanupDirs.push(durableRoot);
    const recordedBase = "9096e1e0000000000000000000000000000000";
    await writeOwnedChange(durableRoot, "about-us-page", "proj", "124", {
      proposeProvenance: true,
      implementationBase: recordedBase,
    });

    const result = await detectReviewTransition(durableRoot, "proj", "124");

    expect(result.detected).toBe(true);
    expect(result.changeName).toBe("about-us-page");
    expect(result.implementationBase).toBe(recordedBase);
    expect(result.reason).toMatch(/implementation-base marker recorded by \/apply/);
  });

  it("a malformed marker (missing baseCommit) is treated as absent, never as a crash or a false positive", async () => {
    const durableRoot = await setupDurableRoot();
    cleanupDirs.push(durableRoot);
    await writeOwnedChange(durableRoot, "fix-the-thing", "proj", "124", { malformedMarker: true });

    const result = await detectReviewTransition(durableRoot, "proj", "124");

    expect(result.detected).toBe(false);
    expect(result.implementationBase).toBeNull();
  });

  it("multiple active changes, only one with an implementation-base marker: detects that specific one", async () => {
    const durableRoot = await setupDurableRoot();
    cleanupDirs.push(durableRoot);
    await writeOwnedChange(durableRoot, "exploring-alternative", "proj", "124", { proposeProvenance: true });
    await writeOwnedChange(durableRoot, "fix-the-thing", "proj", "124", {
      proposeProvenance: true,
      implementationBase: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    const result = await detectReviewTransition(durableRoot, "proj", "124");

    expect(result.detected).toBe(true);
    expect(result.changeName).toBe("fix-the-thing");
    expect(result.implementationBase).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

  it("a change with an implementation-base marker exists but is owned by a different project/issue: not detected -- never guesses across workspaces", async () => {
    const durableRoot = await setupDurableRoot();
    cleanupDirs.push(durableRoot);
    await writeOwnedChange(durableRoot, "someone-elses-fix", "other-project", "999", {
      proposeProvenance: true,
      implementationBase: "cafebabecafebabecafebabecafebabecafebabe",
    });

    const result = await detectReviewTransition(durableRoot, "proj", "124");

    expect(result.detected).toBe(false);
    expect(result.changeName).toBeNull();
  });
});
