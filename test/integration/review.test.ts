import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { createTempRepo } from "../helpers/tempRepo.js";
import {
  setupFakeOpenSpec,
  teardownFakeOpenSpec,
  type FakeOpenSpecEnv,
} from "../helpers/fakeOpenSpec.js";
import {
  setupFakeOpenCode,
  teardownFakeOpenCode,
  type FakeOpenCodeEnv,
} from "../helpers/fakeOpenCode.js";
import { nonExistentCodeGraphBin } from "../helpers/fakeCodeGraph.js";
import { nonExistentOsascriptBin } from "../helpers/fakeOsascript.js";
import { nonExistentGhBin, setFakePrSnapshot, setupFakeGh, teardownFakeGh } from "../helpers/fakeGh.js";

describe("ce review (integration)", () => {
  let harnessHomeDir: string;
  let repoDir: string;
  let remoteDir: string;
  let fakeOpenSpec: FakeOpenSpecEnv;
  let fakeOpenCode: FakeOpenCodeEnv;
  const originalEnv = process.env.CE_HARNESS_HOME;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    repoDir = await createTempRepo();

    // A bare clone stands in for "GitHub": a real remote ce-harness can
    // fetch from over the filesystem, with no network involved.
    remoteDir = await mkdtemp(join(tmpdir(), "ce-harness-remote-"));
    await execa("git", ["clone", "--bare", repoDir, remoteDir]);
    await execa("git", ["-C", repoDir, "remote", "add", "origin", remoteDir]);

    fakeOpenSpec = await setupFakeOpenSpec();
    fakeOpenCode = await setupFakeOpenCode();
    setupFakeGh();
    process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
    process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    process.exitCode = originalExitCode;
    await teardownFakeOpenSpec(fakeOpenSpec);
    await teardownFakeOpenCode(fakeOpenCode);
    teardownFakeGh();
    delete process.env.CE_CODEGRAPH_BIN;
    delete process.env.CE_OSASCRIPT_BIN;
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  });

  /**
   * Same-repository PR: the head branch is pushed to origin under its
   * own name (as it genuinely would be for a same-repo PR) *and* GitHub's
   * `refs/pull/<n>/head` is created pointing at the same commit.
   */
  async function setupSameRepoPr(prNumber: number, branchName = `feature-${prNumber}`) {
    const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
    await execa("git", ["-C", repoDir, "checkout", "-b", branchName]);
    await writeFile(join(repoDir, `${branchName}.txt`), "same-repo pr change\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", `${branchName} commit`]);
    const headSha = (await execa("git", ["-C", repoDir, "rev-parse", branchName])).stdout.trim();
    await execa("git", ["-C", repoDir, "push", "origin", `${branchName}:refs/heads/${branchName}`]);
    await execa("git", ["-C", repoDir, "push", "origin", `${branchName}:refs/pull/${prNumber}/head`]);
    await execa("git", ["-C", repoDir, "checkout", "main"]);
    return { baseSha, headSha, baseRefName: "main", headRefName: branchName };
  }

  /**
   * Fork PR: the head commit is created in a *separate* local repository
   * (the fork) and pushed straight into origin's `refs/pull/<n>/head` --
   * never into `refs/heads/*` there -- exactly mirroring how GitHub
   * exposes a fork PR's head commit on the base repository without ever
   * creating a same-named local branch there.
   */
  async function setupForkPr(prNumber: number, branchName = `fork-feature-${prNumber}`) {
    const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
    const forkDir = await mkdtemp(join(tmpdir(), "ce-harness-fork-"));
    await execa("git", ["clone", repoDir, forkDir]);
    await execa("git", ["-C", forkDir, "config", "user.email", "fork@example.com"]);
    await execa("git", ["-C", forkDir, "config", "user.name", "Fork User"]);
    await execa("git", ["-C", forkDir, "checkout", "-b", branchName]);
    await writeFile(join(forkDir, `${branchName}.txt`), "fork pr change\n", "utf8");
    await execa("git", ["-C", forkDir, "add", "."]);
    await execa("git", ["-C", forkDir, "commit", "-m", `${branchName} commit`]);
    const headSha = (await execa("git", ["-C", forkDir, "rev-parse", branchName])).stdout.trim();
    await execa("git", ["-C", forkDir, "push", remoteDir, `${branchName}:refs/pull/${prNumber}/head`]);
    await rm(forkDir, { recursive: true, force: true });
    return { baseSha, headSha, baseRefName: "main", headRefName: branchName };
  }

  it("resolves a same-repo PR end-to-end: exact SHAs persisted, workspace type Existing PR review, default issue name", async () => {
    const { reviewCommand } = await import("../../src/commands/review.js");
    const { readWorkspace, workspaceType } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { baseSha, headSha, baseRefName, headRefName } = await setupSameRepoPr(119);
    setFakePrSnapshot({
      number: 119,
      title: "Dashboard api wiring contacts",
      baseRefName,
      baseRefOid: baseSha,
      headRefName,
      headRefOid: headSha,
      isCrossRepository: false,
    });

    await reviewCommand({ repo: repoDir, prNumber: "119" });

    const workspace = await readWorkspace(basenameOf(repoDir), "review-pr-119");
    expect(workspace.issue).toBe("review-pr-119");
    expect(workspace.diffBase).toBe(baseSha);
    expect(workspace.diffHead).toBe(headSha);
    expect(workspace.diffMergeBase).toBe(baseSha);
    expect(workspaceType(workspace)).toBe("Existing PR review");

    const worktreeHead = (
      await execa("git", ["-C", workspace.worktreePath, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(worktreeHead).toBe(headSha);
  });

  it("resolves a fork PR the same way, without assuming the head branch exists on origin", async () => {
    const { reviewCommand } = await import("../../src/commands/review.js");
    const { readWorkspace, workspaceType } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { baseSha, headSha, baseRefName, headRefName } = await setupForkPr(202);

    // Confirm the fork's head branch genuinely does not exist on origin --
    // only the GitHub-maintained refs/pull/202/head ref does.
    const remoteBranches = (await execa("git", ["-C", remoteDir, "branch", "--list"])).stdout;
    expect(remoteBranches).not.toContain(headRefName);

    setFakePrSnapshot({
      number: 202,
      title: "Fork PR title",
      baseRefName,
      baseRefOid: baseSha,
      headRefName,
      headRefOid: headSha,
      isCrossRepository: true,
    });

    await reviewCommand({ repo: repoDir, prNumber: "202" });

    const workspace = await readWorkspace(basenameOf(repoDir), "review-pr-202");
    expect(workspace.diffBase).toBe(baseSha);
    expect(workspace.diffHead).toBe(headSha);
    expect(workspaceType(workspace)).toBe("Existing PR review");
  });

  it("fails with an actionable error, before creating any persistent resource, when gh is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ce-harness-nogh-"));
    process.env.CE_GH_BIN = nonExistentGhBin(dir);
    try {
      const { reviewCommand } = await import("../../src/commands/review.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");

      await expect(reviewCommand({ repo: repoDir, prNumber: "1" })).rejects.toThrow(
        /not installed or could not be run/i,
      );

      expect(await readActivePointer()).toBeNull();
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails with an actionable error when gh is not authenticated", async () => {
    process.env.FAKE_GH_FAIL_AUTH = "1";
    const { reviewCommand } = await import("../../src/commands/review.js");
    const { CeError } = await import("../../src/core/errors.js");

    try {
      await reviewCommand({ repo: repoDir, prNumber: "1" });
      expect.fail("expected reviewCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/not authenticated/i);
      expect(ceError.recovery).toMatch(/gh auth login/);
    }
  });

  it("fails with an actionable error when gh cannot resolve the PR", async () => {
    process.env.FAKE_GH_FAIL_RESOLVE = "1";
    const { reviewCommand } = await import("../../src/commands/review.js");
    const { CeError } = await import("../../src/core/errors.js");

    try {
      await reviewCommand({ repo: repoDir, prNumber: "999" });
      expect.fail("expected reviewCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/Could not resolve pull request #999/);
      expect(ceError.recovery).toMatch(/gh auth status/);
    }
  });

  it.each(["0", "-1", "abc", "1.5", "", " ", "119abc", "01"])(
    'rejects an invalid PR number ("%s") before touching gh or the filesystem',
    async (invalid) => {
      const { reviewCommand } = await import("../../src/commands/review.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");

      await expect(reviewCommand({ repo: repoDir, prNumber: invalid })).rejects.toThrow(
        /not a valid pull request number/i,
      );

      expect(await readActivePointer()).toBeNull();
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
    },
  );

  it("fails clearly when the PR's head ref cannot be fetched from origin at all", async () => {
    const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
    setFakePrSnapshot({
      number: 404,
      title: "Nonexistent ref",
      baseRefName: "main",
      baseRefOid: baseSha,
      headRefName: "ghost-branch",
      headRefOid: "f".repeat(40),
      isCrossRepository: false,
    });

    const { reviewCommand } = await import("../../src/commands/review.js");
    await expect(reviewCommand({ repo: repoDir, prNumber: "404" })).rejects.toThrow(/Failed to fetch/i);
  });

  it("fails clearly when the fetched commit does not match the PR snapshot's resolved OID (race/force-push)", async () => {
    const { baseSha, baseRefName, headRefName } = await setupSameRepoPr(505);
    const bogusHeadOid = "1".repeat(40);
    setFakePrSnapshot({
      number: 505,
      title: "Race condition",
      baseRefName,
      baseRefOid: baseSha,
      headRefName,
      headRefOid: bogusHeadOid,
      isCrossRepository: false,
    });

    const { reviewCommand } = await import("../../src/commands/review.js");
    const { CeError } = await import("../../src/core/errors.js");

    try {
      await reviewCommand({ repo: repoDir, prNumber: "505" });
      expect.fail("expected reviewCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/could not be found/i);
      expect(ceError.message).toContain(bogusHeadOid);
      expect(ceError.recovery).toMatch(/force-pushed/i);
    }
  });

  it("never switches the original repository's branch or HEAD", async () => {
    const { reviewCommand } = await import("../../src/commands/review.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { baseSha, headSha, baseRefName, headRefName } = await setupSameRepoPr(11);
    setFakePrSnapshot({
      number: 11,
      title: "t",
      baseRefName,
      baseRefOid: baseSha,
      headRefName,
      headRefOid: headSha,
      isCrossRepository: false,
    });

    const branchBefore = (
      await execa("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();
    const headBefore = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

    await reviewCommand({ repo: repoDir, prNumber: "11" });

    const branchAfter = (
      await execa("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();
    const headAfter = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

    expect(branchAfter).toBe(branchBefore);
    expect(branchAfter).toBe("main");
    expect(headAfter).toBe(headBefore);
  });

  it("leaves the original repository clean (no uncommitted/untracked changes) and structurally unchanged", async () => {
    const { reviewCommand } = await import("../../src/commands/review.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { baseSha, headSha, baseRefName, headRefName } = await setupSameRepoPr(22);
    setFakePrSnapshot({
      number: 22,
      title: "t",
      baseRefName,
      baseRefOid: baseSha,
      headRefName,
      headRefOid: headSha,
      isCrossRepository: false,
    });

    const statusBefore = await execa("git", ["-C", repoDir, "status", "--porcelain"]);

    await reviewCommand({ repo: repoDir, prNumber: "22" });

    const statusAfter = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
    expect(statusAfter.stdout).toBe(statusBefore.stdout);
    expect(statusAfter.stdout).toBe("");
    // review-pr-22 is created only under ~/.ce-harness, never inside the
    // target repository's own working tree -- back on "main", the
    // feature branch's file (headRefName + ".txt") was never part of
    // this working tree at all.
    expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
  });

  it("reviewing a second PR while an earlier review workspace is the default succeeds, preserving the first and switching the default", async () => {
    const { reviewCommand } = await import("../../src/commands/review.js");
    const { readActivePointer, workspaceExistsOnDisk } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const first = await setupSameRepoPr(1, "feature-one");
    setFakePrSnapshot({
      number: 1,
      title: "first",
      baseRefName: first.baseRefName,
      baseRefOid: first.baseSha,
      headRefName: first.headRefName,
      headRefOid: first.headSha,
      isCrossRepository: false,
    });
    await reviewCommand({ repo: repoDir, prNumber: "1" });

    const second = await setupSameRepoPr(2, "feature-two");
    setFakePrSnapshot({
      number: 2,
      title: "second",
      baseRefName: second.baseRefName,
      baseRefOid: second.baseSha,
      headRefName: second.headRefName,
      headRefOid: second.headSha,
      isCrossRepository: false,
    });

    // Must not throw -- this is the same E2E blocker fixed for `ce
    // start`, exercised through `ce review`'s delegation to it.
    await expect(reviewCommand({ repo: repoDir, prNumber: "2" })).resolves.not.toThrow();

    const project = basenameOf(repoDir);
    expect(workspaceExistsOnDisk(project, "review-pr-1")).toBe(true);
    expect(workspaceExistsOnDisk(project, "review-pr-2")).toBe(true);
    expect(await readActivePointer()).toEqual({ project, sanitizedIssue: "review-pr-2" });
  });

  it("does not invent a suffixed name on collision -- surfaces the existing collision error", async () => {
    const { reviewCommand } = await import("../../src/commands/review.js");
    const { clearActivePointer } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { baseSha, headSha, baseRefName, headRefName } = await setupSameRepoPr(119, "feature-a");
    setFakePrSnapshot({
      number: 119,
      title: "t",
      baseRefName,
      baseRefOid: baseSha,
      headRefName,
      headRefOid: headSha,
      isCrossRepository: false,
    });
    await reviewCommand({ repo: repoDir, prNumber: "119" });

    // Simulate a stale leftover worktree/workspace with no active pointer,
    // so the next distinct pre-flight check (worktree already exists) is
    // exercised, exactly like the equivalent `ce start` collision tests.
    await clearActivePointer();

    await expect(reviewCommand({ repo: repoDir, prNumber: "119" })).rejects.toThrow(
      /already exists/i,
    );
    expect(existsSync(join(harnessHomeDir, "workspaces", basenameOf(repoDir), "review-pr-119-2"))).toBe(
      false,
    );
  });

  it("leaves no active workspace, worktree, or workspace directory after a gh-stage failure", async () => {
    process.env.FAKE_GH_FAIL_RESOLVE = "1";
    const { reviewCommand } = await import("../../src/commands/review.js");
    const { readActivePointer } = await import("../../src/core/workspace.js");

    await expect(reviewCommand({ repo: repoDir, prNumber: "42" })).rejects.toThrow();

    expect(await readActivePointer()).toBeNull();
    expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(false);
    expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(false);
    expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
  });

  it("prints a concise PR summary before launching OpenCode, never raw gh JSON", async () => {
    const { reviewCommand } = await import("../../src/commands/review.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { baseSha, headSha, baseRefName, headRefName } = await setupSameRepoPr(119);
    setFakePrSnapshot({
      number: 119,
      title: "Dashboard api wiring contacts",
      baseRefName,
      baseRefOid: baseSha,
      headRefName,
      headRefOid: headSha,
      isCrossRepository: false,
    });

    await reviewCommand({ repo: repoDir, prNumber: "119" });

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("GitHub PR #119");
    expect(output).toContain("Dashboard api wiring contacts");
    expect(output).toContain(`Base: ${baseRefName}`);
    expect(output).toContain(baseSha.slice(0, 7));
    expect(output).toContain(`Head: ${headRefName}`);
    expect(output).toContain(headSha.slice(0, 7));
    expect(output).toContain("Workspace type: Existing PR review");
    expect(output).not.toMatch(/"baseRefOid"/);
    expect(output).not.toMatch(/"headRefOid"/);
  });

  it("ce resume works with a workspace created through ce review", async () => {
    const { reviewCommand } = await import("../../src/commands/review.js");
    const { resumeCommand } = await import("../../src/commands/resume.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { baseSha, headSha, baseRefName, headRefName } = await setupSameRepoPr(77);
    setFakePrSnapshot({
      number: 77,
      title: "resume test",
      baseRefName,
      baseRefOid: baseSha,
      headRefName,
      headRefOid: headSha,
      isCrossRepository: false,
    });

    await reviewCommand({ repo: repoDir, prNumber: "77" });
    const reviewLaunch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));

    await resumeCommand();
    const resumeLaunch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));

    expect(resumeLaunch.cwd).toBe(reviewLaunch.cwd);
    expect(resumeLaunch.env).toEqual(reviewLaunch.env);
    expect(resumeLaunch.env.CE_DIFF_BASE).toBe(baseSha);
    expect(resumeLaunch.env.CE_DIFF_HEAD).toBe(headSha);
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
