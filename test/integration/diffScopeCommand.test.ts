import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { createTempRepo } from "../helpers/tempRepo.js";
import { diffScopeCommand } from "../../src/commands/diffScope.js";

describe("ce diff-scope (integration)", () => {
  let repoDir: string;
  const originalEnv = {
    CE_WORKTREE: process.env.CE_WORKTREE,
    CE_DIFF_BASE: process.env.CE_DIFF_BASE,
    CE_DIFF_HEAD: process.env.CE_DIFF_HEAD,
    CE_BASE_BRANCH: process.env.CE_BASE_BRANCH,
  };

  beforeEach(async () => {
    repoDir = await createTempRepo();
    delete process.env.CE_WORKTREE;
    delete process.env.CE_DIFF_BASE;
    delete process.env.CE_DIFF_HEAD;
    delete process.env.CE_BASE_BRANCH;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(repoDir, { recursive: true, force: true });
  });

  it("throws a clear CeError when CE_WORKTREE is not set", async () => {
    await expect(diffScopeCommand()).rejects.toThrow(/CE_WORKTREE is not set/);
  });

  it("prints an explicit-mode result and ignores CE_BASE_BRANCH when CE_DIFF_BASE/CE_DIFF_HEAD are both set", async () => {
    process.env.CE_WORKTREE = repoDir;
    process.env.CE_DIFF_BASE = "abc123";
    process.env.CE_DIFF_HEAD = "def456";
    process.env.CE_BASE_BRANCH = "develop"; // must be ignored in explicit mode

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await diffScopeCommand();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.mode).toBe("explicit");
    expect(parsed.diffRange).toBe("abc123...def456");
    expect(parsed.logRange).toBe("abc123..def456");
  });

  it("prints a merge-base result, falling back to main when CE_BASE_BRANCH is unset", async () => {
    process.env.CE_WORKTREE = repoDir;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await diffScopeCommand();

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.mode).toBe("merge-base");
    expect(parsed.baseSource).toBe("main");
  });
});

describe("ce diff-scope: real Oz E2E gap -- a review workspace that transitions into implementation (integration)", () => {
  let harnessHomeDir: string;
  let repoDir: string;
  const originalHarnessHome = process.env.CE_HARNESS_HOME;
  const originalEnv = {
    CE_WORKTREE: process.env.CE_WORKTREE,
    CE_PROJECT: process.env.CE_PROJECT,
    CE_DIFF_BASE: process.env.CE_DIFF_BASE,
    CE_DIFF_HEAD: process.env.CE_DIFF_HEAD,
    CE_BASE_BRANCH: process.env.CE_BASE_BRANCH,
  };

  function basenameOf(path: string): string {
    return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
  }

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHarnessHome === undefined) delete process.env.CE_HARNESS_HOME;
    else process.env.CE_HARNESS_HOME = originalHarnessHome;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("a plain review workspace (no active change) still resolves the explicit PR range -- the existing guard is preserved", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { readActivePointer, readWorkspace } = await import("../../src/core/workspace.js");

    const base = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repoDir, "feature.txt"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "feature"]);
    const head = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "review-124", base, head });

    const pointer = await readActivePointer();
    const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);

    process.env.CE_WORKTREE = workspace.worktreePath;
    process.env.CE_PROJECT = workspace.project;
    process.env.CE_DIFF_BASE = workspace.diffBase;
    process.env.CE_DIFF_HEAD = workspace.diffHead;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await diffScopeCommand();

    const parsed = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
    expect(parsed.mode).toBe("explicit");
    expect(parsed.reviewTransition).toEqual({
      detected: false,
      changeName: null,
      implementationBase: null,
      reason: "no active OpenSpec change is owned by this workspace",
    });
  });

  it("FALSE POSITIVE regression: a review workspace with a validated /propose plan plus a hand-edited commit (no /apply marker) still resolves the explicit PR range", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
      "../../src/core/workspace.js"
    );

    const base = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repoDir, "feature.txt"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "feature"]);
    const head = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "review-124", base, head });

    const pointer = await readActivePointer();
    const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
    const trusted = resolveTrustedOpenSpec(workspace)!;

    // /propose ran and validated a plan (a real .ce-provenance-propose.yml
    // exists)...
    const changeRoot = join(trusted.root, "openspec", "changes", "repair-the-branch");
    await mkdir(changeRoot, { recursive: true });
    await writeFile(join(changeRoot, ".ce-workspace.yml"), `project: "${workspace.project}"\nissue: "${workspace.issue}"\n`, "utf8");
    await writeFile(
      join(changeRoot, ".ce-provenance-propose.yml"),
      'commit: "deadbeef"\nfingerprint: "abc123456789"\nrecordedAt: "2026-01-01"\n',
      "utf8",
    );

    // ...then something other than /apply changed the worktree (a
    // hand-edit, not the harness's own implementation lifecycle). With no
    // .ce-implementation-base.yml marker, this must never look like a
    // real transition -- this is exactly the false positive the old
    // (worktree-divergence-based) model would have wrongly accepted.
    await writeFile(join(workspace.worktreePath, "hand-edited.txt"), "not through /apply\n", "utf8");
    await execa("git", ["-C", workspace.worktreePath, "add", "."]);
    await execa("git", ["-C", workspace.worktreePath, "commit", "-m", "manual edit, not /apply"]);

    process.env.CE_WORKTREE = workspace.worktreePath;
    process.env.CE_PROJECT = workspace.project;
    process.env.CE_DIFF_BASE = workspace.diffBase;
    process.env.CE_DIFF_HEAD = workspace.diffHead;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await diffScopeCommand();

    const parsed = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
    expect(parsed.mode).toBe("explicit");
    expect(parsed.reviewTransition.detected).toBe(false);
  });

  it("a review workspace whose active change has an /apply-recorded implementation-base marker: resolves the implementation diff from THAT base, excluding unrelated history that landed on the trunk in between (the exact PR #124 topology)", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
      "../../src/core/workspace.js"
    );

    // "B" -- the original review's own base/head relationship.
    const originalReviewBase = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repoDir, "feature.txt"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "feature"]);
    const originalReviewHead = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "review-124", base: originalReviewBase, head: originalReviewHead });

    const pointer = await readActivePointer();
    const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
    const trusted = resolveTrustedOpenSpec(workspace)!;

    // "C" and "D" -- the trunk (`dev`) advances with unrelated history
    // (e.g. PR #123, PR #126) after the original review's base, before
    // the repair work starts. This lands directly in the worktree here
    // to model "the reviewer reset the worktree to current dev before
    // implementing," exactly the real PR #124 topology.
    await writeFile(join(workspace.worktreePath, "unrelated-pr-123.txt"), "unrelated\n", "utf8");
    await execa("git", ["-C", workspace.worktreePath, "add", "."]);
    await execa("git", ["-C", workspace.worktreePath, "commit", "-m", "unrelated PR #123"]);
    await writeFile(join(workspace.worktreePath, "unrelated-pr-126.txt"), "also unrelated\n", "utf8");
    await execa("git", ["-C", workspace.worktreePath, "add", "."]);
    await execa("git", ["-C", workspace.worktreePath, "commit", "-m", "unrelated PR #126"]);
    const implementationBase = (
      await execa("git", ["-C", workspace.worktreePath, "rev-parse", "HEAD"])
    ).stdout.trim(); // "D"
    expect(implementationBase).not.toBe(originalReviewBase);

    // Simulates /apply's own Step 4: record the implementation base --
    // "D", the worktree's HEAD right now -- once, before implementing.
    const changeRoot = join(trusted.root, "openspec", "changes", "about-us-page");
    await mkdir(changeRoot, { recursive: true });
    await writeFile(join(changeRoot, ".ce-workspace.yml"), `project: "${workspace.project}"\nissue: "${workspace.issue}"\n`, "utf8");
    await writeFile(
      join(changeRoot, ".ce-provenance-propose.yml"),
      'commit: "deadbeef"\nfingerprint: "abc123456789"\nrecordedAt: "2026-01-01"\n',
      "utf8",
    );
    await writeFile(
      join(changeRoot, ".ce-implementation-base.yml"),
      `baseCommit: "${implementationBase}"\nrecordedAt: "2026-01-02"\n`,
      "utf8",
    );

    // "E" -- the actual repaired implementation, on top of "D".
    await writeFile(join(workspace.worktreePath, "about-us.html"), "<h1>About us</h1>\n", "utf8");
    await execa("git", ["-C", workspace.worktreePath, "add", "."]);
    await execa("git", ["-C", workspace.worktreePath, "commit", "-m", "Add about-us page"]);

    process.env.CE_WORKTREE = workspace.worktreePath;
    process.env.CE_PROJECT = workspace.project;
    process.env.CE_DIFF_BASE = workspace.diffBase;
    process.env.CE_DIFF_HEAD = workspace.diffHead;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await diffScopeCommand();

    const parsed = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
    expect(parsed.mode).toBe("merge-base");
    expect(parsed.reviewTransition).toMatchObject({
      detected: true,
      changeName: "about-us-page",
      implementationBase,
    });
    // "D", never "B" -- the fix this task exists for.
    expect(parsed.base).toBe(implementationBase);
    expect(parsed.base).not.toBe(originalReviewBase);
    expect(parsed.diffRange).toBe(`${implementationBase}...HEAD`);

    // Prove it in terms of real content: the resolved range must exclude
    // both unrelated commits and include only the real repair.
    const filesInRange = (
      await execa("git", ["-C", workspace.worktreePath, "diff", "--name-only", parsed.diffRange])
    ).stdout.trim();
    expect(filesInRange).toBe("about-us.html");
  });
});
