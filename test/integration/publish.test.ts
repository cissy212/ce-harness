import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  setFakeCreatePrUrl,
  setFakeExistingPr,
  setFakeGhRecordFile,
  setupFakeGh,
  teardownFakeGh,
} from "../helpers/fakeGh.js";

describe("ce publish (integration)", () => {
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
    // push to and fetch from over the filesystem, with no network
    // involved (same stand-in review.test.ts uses). "origin" is
    // registered under a normal https://github.com/... URL (so
    // parseGithubSlug resolves a real-looking slug, exactly what
    // production code reads via readOriginOrSolitaryRemoteUrl), and a
    // `url.<bare-clone>.insteadOf` rewrite transparently redirects any
    // actual fetch/push for that URL to the real bare clone -- a
    // standard Git feature, not a test-only hack -- so the plumbing
    // genuinely works while the recorded remote URL still looks and
    // parses like GitHub.
    remoteDir = await mkdtemp(join(tmpdir(), "ce-harness-remote-"));
    await execa("git", ["clone", "--bare", repoDir, remoteDir]);
    const githubUrl = "https://github.com/example-owner/example-repo.git";
    await execa("git", ["-C", repoDir, "remote", "add", "origin", githubUrl]);
    await execa("git", ["-C", repoDir, "config", `url.${remoteDir}.insteadOf`, githubUrl]);

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

  /** Simulates `/apply` having produced real product commits on the workspace's internal branch. */
  async function addProductCommit(worktreePath: string, file: string, content: string, message: string) {
    await writeFile(join(worktreePath, file), content, "utf8");
    await execa("git", ["-C", worktreePath, "add", "."]);
    await execa("git", ["-C", worktreePath, "commit", "-m", message]);
  }

  /** Advances the bare remote's main branch independently, simulating other work having merged upstream. */
  async function advanceRemoteMain(file: string, content: string, message: string) {
    const seed = await mkdtemp(join(tmpdir(), "ce-harness-seed-"));
    await execa("git", ["clone", remoteDir, seed]);
    await execa("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    await execa("git", ["-C", seed, "config", "user.name", "Test User"]);
    await writeFile(join(seed, file), content, "utf8");
    await execa("git", ["-C", seed, "add", "."]);
    await execa("git", ["-C", seed, "commit", "-m", message]);
    await execa("git", ["-C", seed, "push", "origin", "main"]);
    await rm(seed, { recursive: true, force: true });
  }

  function basenameOf(path: string): string {
    return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
  }

  describe("prepare (no --confirm): plan generation, no remote mutation", () => {
    it("reports an already-current plan with exact included commits/files when the base hasn't advanced", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      await addProductCommit(workspace.worktreePath, "feature.txt", "x\n", "Add feature file");

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });

      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
      expect(plan.updateStatus).toBe("already-current");
      expect(plan.baseBranch).toBe("main");
      expect(plan.repoSlug).toBe("example-owner/example-repo");
      expect(plan.publishBranch).toBe("feature/issue-130");
      expect(plan.publishBranch.startsWith("ce-harness/")).toBe(false);
      expect(plan.includedCommits.map((c: { subject: string }) => c.subject)).toEqual(["Add feature file"]);
      expect(plan.includedFiles).toEqual(["feature.txt"]);
      expect(plan.uncommittedFiles).toEqual([]);
      expect(plan.warnings).toEqual([]);
      expect(plan.changeName).toBeNull();

      // No remote mutation: nothing was pushed to the bare remote.
      const remoteBranches = (await execa("git", ["-C", remoteDir, "branch", "--list"])).stdout;
      expect(remoteBranches).not.toContain("feature/issue-130");
    });

    it("preserves the exact first character of an unstaged-modified file's path in the plan's uncommittedFiles -- regression: a whole-string .trim() previously ate the leading space of git status's \" M\" code whenever it was the first status line, silently truncating the path (a real case: \"apps/...\" was reported as \"pps/...\")", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      // A tracked file, modified but never staged -- `git status
      // --porcelain` reports this with a *leading-space* status code
      // (" M"), which is exactly the condition the bug required (the
      // leading space is only ever eaten when it starts the raw stdout,
      // i.e. when this is the first -- here, only -- status line).
      await mkdir(join(workspace.worktreePath, "apps", "dashboard"), { recursive: true });
      await writeFile(join(workspace.worktreePath, "apps", "dashboard", "a.txt"), "original\n", "utf8");
      await execa("git", ["-C", workspace.worktreePath, "add", "."]);
      await execa("git", ["-C", workspace.worktreePath, "commit", "-m", "add a.txt"]);
      await writeFile(join(workspace.worktreePath, "apps", "dashboard", "a.txt"), "modified\n", "utf8");

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });
      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      expect(plan.uncommittedFiles).toEqual(["apps/dashboard/a.txt"]);
    });

    it("safely merges an advanced remote base into the workspace branch (local-only, no push)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      await addProductCommit(workspace.worktreePath, "feature.txt", "x\n", "Add feature file");
      await advanceRemoteMain("upstream.txt", "u\n", "Upstream change");

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });

      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
      expect(plan.updateStatus).toBe("safely-updated");
      // The merge is local -- still nothing pushed to the remote yet.
      const remoteBranches = (await execa("git", ["-C", remoteDir, "branch", "--list"])).stdout;
      expect(remoteBranches).not.toContain("feature/issue-130");
      // The workspace's own worktree now has the upstream file merged in.
      expect(existsSync(join(workspace.worktreePath, "upstream.txt"))).toBe(true);
      // The merge commit itself is excluded from "included commits".
      expect(plan.includedCommits.map((c: { subject: string }) => c.subject)).toEqual(["Add feature file"]);
    });

    it("refuses with a clear, actionable error on a real merge conflict, leaving the worktree unchanged", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { CeError } = await import("../../src/core/errors.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      // Conflicting edits: workspace branch and the remote both touch README.md.
      await addProductCommit(workspace.worktreePath, "README.md", "workspace version\n", "Change README (workspace)");
      await advanceRemoteMain("README.md", "upstream version\n", "Change README (upstream)");
      const headBefore = (await execa("git", ["-C", workspace.worktreePath, "rev-parse", "HEAD"])).stdout.trim();

      await expect(publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` })).rejects.toThrow(CeError);

      const headAfter = (await execa("git", ["-C", workspace.worktreePath, "rev-parse", "HEAD"])).stdout.trim();
      expect(headAfter).toBe(headBefore);
      const status = (await execa("git", ["-C", workspace.worktreePath, "status", "--porcelain"])).stdout.trim();
      expect(status).toBe("");
    });

    it("refuses outright for an Existing PR review workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { CeError } = await import("../../src/core/errors.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const baseSha = (await execa("git", ["-C", repoDir, "rev-parse", "main"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "-b", "review-feature"]);
      await writeFile(join(repoDir, "review.txt"), "x\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "review feature"]);
      const headSha = (await execa("git", ["-C", repoDir, "rev-parse", "review-feature"])).stdout.trim();
      await execa("git", ["-C", repoDir, "checkout", "main"]);

      await startCommand({ repo: repoDir, issue: "review-pr-1", base: baseSha, head: headSha });

      await expect(publishCommand({ workspace: `${basenameOf(repoDir)}/review-pr-1` })).rejects.toThrow(
        /only applies to an Implementation workspace/,
      );
    });

    it("never touches another workspace's branch or worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      await startCommand({ repo: repoDir, issue: "issue-143" });
      const project = basenameOf(repoDir);
      const ws130 = await readWorkspace(project, "issue-130");
      const ws143 = await readWorkspace(project, "issue-143");
      await addProductCommit(ws130.worktreePath, "feature.txt", "x\n", "Add feature file");
      const head143Before = (await execa("git", ["-C", ws143.worktreePath, "rev-parse", "HEAD"])).stdout.trim();

      await publishCommand({ workspace: `${project}/issue-130` });

      const head143After = (await execa("git", ["-C", ws143.worktreePath, "rev-parse", "HEAD"])).stdout.trim();
      expect(head143After).toBe(head143Before);
    });

    it("explicit targeting never switches the default workspace", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readActivePointer } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      await startCommand({ repo: repoDir, issue: "issue-143" });
      const project = basenameOf(repoDir);

      await publishCommand({ workspace: `${project}/issue-130` });

      expect(await readActivePointer()).toEqual({ project, sanitizedIssue: "issue-143" });
    });
  });

  describe("--confirm: the remote mutation", () => {
    it("commits uncommitted changes, pushes under a non-ce-harness branch name, and creates the PR", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      await addProductCommit(workspace.worktreePath, "feature.txt", "x\n", "Add feature file");
      // Leftover uncommitted change, matching a verified-but-uncommitted state.
      await writeFile(join(workspace.worktreePath, "pending.txt"), "pending\n", "utf8");

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });
      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
      expect(plan.uncommittedFiles).toEqual(["pending.txt"]);

      setFakeCreatePrUrl("https://github.com/example-owner/example-repo/pull/5");
      const recordFile = join(harnessHomeDir, "gh-record.json");
      setFakeGhRecordFile(recordFile);
      const bodyFile = join(harnessHomeDir, "pr-body.md");
      await writeFile(bodyFile, "## Summary\nAdds a feature.\n\n## Test Plan\n- Verified manually.\n", "utf8");

      logSpy.mockClear();
      await publishCommand({
        workspace: `${basenameOf(repoDir)}/issue-130`,
        confirm: true,
        title: "Add the feature",
        bodyFile,
        expectedHead: plan.headCommit,
        expectedFingerprint: plan.expectedFingerprint,
      });
      const result = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      expect(result.url).toBe("https://github.com/example-owner/example-repo/pull/5");
      expect(result.alreadyExisted).toBe(false);
      expect(result.publishBranch).toBe("feature/issue-130");

      // Uncommitted change was committed.
      const statusAfter = (await execa("git", ["-C", workspace.worktreePath, "status", "--porcelain"])).stdout.trim();
      expect(statusAfter).toBe("");

      // Pushed to the remote under the publish branch name -- never the internal ce-harness/* branch.
      const remoteBranches = (await execa("git", ["-C", remoteDir, "branch", "--list"])).stdout;
      expect(remoteBranches).toContain("feature/issue-130");
      expect(remoteBranches).not.toMatch(/ce-harness/);

      const record = JSON.parse(await readFile(recordFile, "utf8"));
      expect(record.repo).toBe("example-owner/example-repo");
      expect(record.base).toBe("main");
      expect(record.head).toBe("feature/issue-130");
      expect(record.title).toBe("Add the feature");
      expect(record.body).toContain("Adds a feature.");
      expect(JSON.stringify(record)).not.toMatch(/merge/i);
    });

    it("refuses when the branch changed since the plan was generated (stale --expected-head)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { CeError } = await import("../../src/core/errors.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });
      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      const bodyFile = join(harnessHomeDir, "pr-body.md");
      await writeFile(bodyFile, "body\n", "utf8");

      await expect(
        publishCommand({
          workspace: `${basenameOf(repoDir)}/issue-130`,
          confirm: true,
          title: "Title",
          bodyFile,
          expectedHead: "0".repeat(40),
          expectedFingerprint: plan.expectedFingerprint,
        }),
      ).rejects.toThrow(CeError);
      await expect(
        publishCommand({
          workspace: `${basenameOf(repoDir)}/issue-130`,
          confirm: true,
          title: "Title",
          bodyFile,
          expectedHead: "0".repeat(40),
          expectedFingerprint: plan.expectedFingerprint,
        }),
      ).rejects.toThrow(/has changed since the publish plan was generated/);
    });

    it("requires --title, --body-file, --expected-head, and --expected-fingerprint", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { CeError } = await import("../../src/core/errors.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });

      await expect(
        publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130`, confirm: true }),
      ).rejects.toThrow(CeError);
      await expect(
        publishCommand({
          workspace: `${basenameOf(repoDir)}/issue-130`,
          confirm: true,
          title: "Title",
          bodyFile: join(harnessHomeDir, "does-not-matter.md"),
          expectedHead: "0".repeat(40),
          // expectedFingerprint deliberately omitted
        }),
      ).rejects.toThrow(/requires --title, --body-file, --expected-head, and --expected-fingerprint/);
    });

    it("publishes successfully when nothing changed between preview and confirm (unchanged-state path)", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      await addProductCommit(workspace.worktreePath, "feature.txt", "x\n", "Add feature file");

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });
      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      const bodyFile = join(harnessHomeDir, "pr-body.md");
      await writeFile(bodyFile, "body\n", "utf8");
      setFakeCreatePrUrl("https://github.com/example-owner/example-repo/pull/21");

      logSpy.mockClear();
      await publishCommand({
        workspace: `${basenameOf(repoDir)}/issue-130`,
        confirm: true,
        title: "Add the feature",
        bodyFile,
        expectedHead: plan.headCommit,
        expectedFingerprint: plan.expectedFingerprint,
      });
      const result = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      expect(result.url).toBe("https://github.com/example-owner/example-repo/pull/21");
      const remoteBranches = (await execa("git", ["-C", remoteDir, "branch", "--list"])).stdout;
      expect(remoteBranches).toContain("feature/issue-130");
    });

    it("refuses to publish when an uncommitted product file changed after the preview, even though HEAD hasn't moved", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { CeError } = await import("../../src/core/errors.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      await addProductCommit(workspace.worktreePath, "feature.txt", "x\n", "Add feature file");

      // 1. Preview shows files A/B/C (just feature.txt here, committed).
      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });
      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
      expect(plan.uncommittedFiles).toEqual([]);

      // 2. User confirms in their head, but before the confirm command
      //    actually runs, file D is added -- an uncommitted change that
      //    never appeared in the approved preview. HEAD does NOT move.
      const headBeforeMutation = (
        await execa("git", ["-C", workspace.worktreePath, "rev-parse", workspace.internalBranch])
      ).stdout.trim();
      await writeFile(join(workspace.worktreePath, "surprise.txt"), "unapproved content\n", "utf8");
      const headAfterMutation = (
        await execa("git", ["-C", workspace.worktreePath, "rev-parse", workspace.internalBranch])
      ).stdout.trim();
      expect(headAfterMutation).toBe(headBeforeMutation); // HEAD genuinely unchanged.

      const bodyFile = join(harnessHomeDir, "pr-body.md");
      await writeFile(bodyFile, "body\n", "utf8");
      const recordFile = join(harnessHomeDir, "gh-record.json");
      setFakeGhRecordFile(recordFile);

      // 3. Confirm with the original preview's state (--expected-head
      //    still matches -- this is exactly the gap --expected-head
      //    alone can't catch).
      await expect(
        publishCommand({
          workspace: `${basenameOf(repoDir)}/issue-130`,
          confirm: true,
          title: "Add the feature",
          bodyFile,
          expectedHead: plan.headCommit,
          expectedFingerprint: plan.expectedFingerprint,
        }),
      ).rejects.toThrow(CeError);
      await expect(
        publishCommand({
          workspace: `${basenameOf(repoDir)}/issue-130`,
          confirm: true,
          title: "Add the feature",
          bodyFile,
          expectedHead: plan.headCommit,
          expectedFingerprint: plan.expectedFingerprint,
        }),
      ).rejects.toThrow(/worktree has changed since the publish plan was generated/);

      // 4. No commit: the uncommitted file is still uncommitted, and
      //    HEAD is still exactly what it was before the mutation.
      const headAfterConfirmAttempt = (
        await execa("git", ["-C", workspace.worktreePath, "rev-parse", workspace.internalBranch])
      ).stdout.trim();
      expect(headAfterConfirmAttempt).toBe(headBeforeMutation);
      const status = (await execa("git", ["-C", workspace.worktreePath, "status", "--porcelain"])).stdout;
      expect(status).toContain("surprise.txt");

      // 5. No push: the remote never received the publish branch at all.
      const remoteBranches = (await execa("git", ["-C", remoteDir, "branch", "--list"])).stdout;
      expect(remoteBranches).not.toContain("feature/issue-130");

      // 6. No PR creation: gh pr create was never invoked (no record file written).
      expect(existsSync(recordFile)).toBe(false);
    });

    it("republishing after new commits is a plain fast-forward push, never --force", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      await addProductCommit(workspace.worktreePath, "one.txt", "1\n", "Add one");

      const bodyFile = join(harnessHomeDir, "pr-body.md");
      await writeFile(bodyFile, "body\n", "utf8");

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });
      let plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
      await publishCommand({
        workspace: `${basenameOf(repoDir)}/issue-130`,
        confirm: true,
        title: "First",
        bodyFile,
        expectedHead: plan.headCommit,
        expectedFingerprint: plan.expectedFingerprint,
      });

      // Simulate a PR already open for this branch on the second round.
      setFakeExistingPr("https://github.com/example-owner/example-repo/pull/11");

      await addProductCommit(workspace.worktreePath, "two.txt", "2\n", "Add two");
      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });
      plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      logSpy.mockClear();
      await publishCommand({
        workspace: `${basenameOf(repoDir)}/issue-130`,
        confirm: true,
        title: "First",
        bodyFile,
        expectedHead: plan.headCommit,
        expectedFingerprint: plan.expectedFingerprint,
      });
      const result = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      expect(result.alreadyExisted).toBe(true);
      expect(result.url).toBe("https://github.com/example-owner/example-repo/pull/11");
      const remoteHead = (
        await execa("git", ["-C", remoteDir, "rev-parse", "refs/heads/feature/issue-130"])
      ).stdout.trim();
      const localHead = (
        await execa("git", ["-C", workspace.worktreePath, "rev-parse", workspace.internalBranch])
      ).stdout.trim();
      expect(remoteHead).toBe(localHead);
    });
  });

  describe("change association: publish branch/content derived from the workspace's archived change", () => {
    it("uses the archived change's name in the default publish-branch pattern", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace, resolveTrustedOpenSpec } = await import("../../src/core/workspace.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      await addProductCommit(workspace.worktreePath, "feature.txt", "x\n", "Add feature file");

      const trusted = resolveTrustedOpenSpec(workspace);
      const archiveDir = join(trusted!.root, "openspec", "changes", "archive", "2026-09-02-addressbook-email-notes");
      await mkdir(archiveDir, { recursive: true });
      await writeFile(join(archiveDir, ".ce-workspace.yml"), 'project: "' + basenameOf(repoDir) + '"\nissue: "issue-130"\n', "utf8");

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });
      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      expect(plan.changeName).toBe("addressbook-email-notes");
      expect(plan.changeRoot).toBe(archiveDir);
      expect(plan.publishBranch).toBe("feature/issue-130-addressbook-email-notes");
    });

    it("an explicit --change overrides auto-resolution", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      await addProductCommit(workspace.worktreePath, "feature.txt", "x\n", "Add feature file");

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130`, change: "manual-name" });
      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      expect(plan.changeName).toBe("manual-name");
      expect(plan.publishBranch).toBe("feature/issue-130-manual-name");
    });
  });

  describe("suspicious-path audit", () => {
    it("warns (never silently proceeds past) a harness-looking path found in the product diff", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      await mkdir(join(workspace.worktreePath, "openspec", "changes"), { recursive: true });
      await addProductCommit(
        workspace.worktreePath,
        "openspec/changes/leaked.md",
        "leaked\n",
        "Accidentally add an openspec file",
      );

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });
      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      expect(plan.warnings.length).toBeGreaterThan(0);
      expect(plan.warnings[0]).toMatch(/openspec\/changes\/leaked\.md/);
    });

    it("--confirm hard-refuses to push a suspicious path even if the plan's warning was ignored", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { publishCommand } = await import("../../src/commands/publish.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { CeError } = await import("../../src/core/errors.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-130" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-130");
      await mkdir(join(workspace.worktreePath, "openspec", "changes"), { recursive: true });
      await addProductCommit(
        workspace.worktreePath,
        "openspec/changes/leaked.md",
        "leaked\n",
        "Accidentally add an openspec file",
      );

      logSpy.mockClear();
      await publishCommand({ workspace: `${basenameOf(repoDir)}/issue-130` });
      const plan = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);

      const bodyFile = join(harnessHomeDir, "pr-body.md");
      await writeFile(bodyFile, "body\n", "utf8");

      await expect(
        publishCommand({
          workspace: `${basenameOf(repoDir)}/issue-130`,
          confirm: true,
          title: "Title",
          bodyFile,
          expectedHead: plan.headCommit,
          expectedFingerprint: plan.expectedFingerprint,
        }),
      ).rejects.toThrow(CeError);
      await expect(
        publishCommand({
          workspace: `${basenameOf(repoDir)}/issue-130`,
          confirm: true,
          title: "Title",
          bodyFile,
          expectedHead: plan.headCommit,
          expectedFingerprint: plan.expectedFingerprint,
        }),
      ).rejects.toThrow(/harness\/OpenSpec-looking path/);

      // Never pushed to the remote.
      const remoteBranches = (await execa("git", ["-C", remoteDir, "branch", "--list"])).stdout;
      expect(remoteBranches).not.toContain("feature/issue-130");
    });
  });
});
