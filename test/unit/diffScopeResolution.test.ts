import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { templatesRoot } from "../../src/core/templates.js";
import { createBareRemote, cloneRepo, createTempRepo } from "../helpers/tempRepo.js";

/**
 * Executes the actual `$CE_BASE_BRANCH` vs `origin/$CE_BASE_BRANCH`
 * divergence-resolution logic /verify and /adversarial-review both ship
 * -- extracted verbatim from the real templates/commands/verify.md (the
 * two files are proven byte-identical for this block by
 * commandConsistency.test.ts, so exercising one exercises both) -- against
 * real, constructed Git repositories. A purely textual check (does the
 * markdown contain the right words, in the right order) would not have
 * caught the original bug: the old text also "contained the right
 * commands," it just picked the wrong one when both candidates resolved.
 * This proves the actual git behavior is correct for every case that
 * matters, not just that the prose mentions the right commands.
 */

async function extractDecisionSnippet(): Promise<string> {
  const content = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
  const start = "LOCAL_MB=$(git";
  const startIdx = content.indexOf(start);
  if (startIdx === -1) {
    throw new Error('decision snippet start marker "LOCAL_MB=$(git" not found in verify.md');
  }
  const fenceEnd = content.indexOf("\n```", startIdx);
  if (fenceEnd === -1) {
    throw new Error("decision snippet closing fence not found in verify.md");
  }
  return content.slice(startIdx, fenceEnd);
}

/** Runs the extracted snippet for real and returns the resolved $BASE_MB ("" if nothing resolved). */
async function resolveBaseMb(worktreePath: string, baseBranch: string): Promise<string> {
  const snippet = await extractDecisionSnippet();
  const result = await execa("bash", ["-c", `${snippet}\nprintf '%s' "$BASE_MB"`], {
    env: { ...process.env, CE_WORKTREE: worktreePath, CE_BASE_BRANCH: baseBranch },
  });
  return result.stdout.trim();
}

async function rev(repoDir: string, ref: string): Promise<string> {
  return (await execa("git", ["-C", repoDir, "rev-parse", ref])).stdout.trim();
}

describe("diff-scope base resolution ($CE_BASE_BRANCH vs origin/$CE_BASE_BRANCH), executed for real", () => {
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

    const baseMb = await resolveBaseMb(workRepo, "develop");
    expect(baseMb).toBe(originTip);
    expect(baseMb).not.toBe(staleLocalTip);
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

    const baseMb = await resolveBaseMb(workRepo, "develop");
    expect(baseMb).toBe(localTip);
  });

  it("local and origin/<base> equal: resolves to that shared commit (no ambiguity)", async () => {
    const remoteDir = await createBareRemote("develop");
    const workRepo = await cloneRepo(remoteDir);
    cleanupDirs.push(remoteDir, workRepo);

    await execa("git", ["-C", workRepo, "checkout", "-b", "ce-harness/hano", "develop"]);

    const developTip = await rev(workRepo, "develop");
    expect(developTip).toBe(await rev(workRepo, "origin/develop"));

    const baseMb = await resolveBaseMb(workRepo, "develop");
    expect(baseMb).toBe(developTip);
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

    const baseMb = await resolveBaseMb(workRepo, "develop");
    expect(baseMb).toBe(localTip);
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

    const baseMb = await resolveBaseMb(repoDir, "develop");
    expect(baseMb).toBe(developTip);
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

    const baseMb = await resolveBaseMb(workRepo, "develop");
    expect(baseMb).toBe(originDevelopTip);
  });

  it("CE_BASE_BRANCH resolves to nothing at all: yields an empty BASE_MB, leaving main/master fallback to the (unchanged) surrounding steps", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);

    const baseMb = await resolveBaseMb(repoDir, "develop"); // no such branch, no remote at all
    expect(baseMb).toBe("");

    // The documented fallback this leaves in place is still genuinely
    // reachable: main exists and merge-base against it succeeds.
    const mainMb = await execa("git", ["-C", repoDir, "merge-base", "HEAD", "main"]);
    expect(mainMb.stdout.trim()).toBe(await rev(repoDir, "main"));
  });

  it("explicit CE_DIFF_BASE/CE_DIFF_HEAD handling is untouched and still takes priority in the prose", async () => {
    const verify = await readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
    const adversarial = await readFile(
      join(templatesRoot(), "commands", "adversarial-review.md"),
      "utf8",
    );

    const explicitRangeParagraph =
      "If `CE_DIFF_BASE` and `CE_DIFF_HEAD` are both set, this is an explicit\n" +
      "review of a specific commit range (e.g. an existing pull request, open or\n" +
      "already merged) injected by `ce start --base --head` -- use them\n" +
      "directly and skip base-branch detection entirely:";

    for (const [label, content] of [
      ["verify.md", verify],
      ["adversarial-review.md", adversarial],
    ] as const) {
      expect(content, `${label} must still special-case CE_DIFF_BASE/CE_DIFF_HEAD`).toContain(
        explicitRangeParagraph,
      );
      expect(content, `${label} must still use three-dot for the diff itself`).toContain(
        'git -C "$CE_WORKTREE" diff "$CE_DIFF_BASE...$CE_DIFF_HEAD"',
      );

      // Still positioned before ("takes priority over") the CE_BASE_BRANCH
      // fallback logic this task modified.
      const explicitIdx = content.indexOf(explicitRangeParagraph);
      const fallbackIdx = content.indexOf("Otherwise, find a base for a proper diff.");
      expect(explicitIdx).toBeGreaterThan(-1);
      expect(fallbackIdx).toBeGreaterThan(-1);
      expect(explicitIdx).toBeLessThan(fallbackIdx);
    }
  });
});
