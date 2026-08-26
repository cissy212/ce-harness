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
import { setupFakeOpenCode, teardownFakeOpenCode, type FakeOpenCodeEnv } from "../helpers/fakeOpenCode.js";
import { setupFakeClaude, teardownFakeClaude, type FakeClaudeEnv } from "../helpers/fakeClaude.js";
import { nonExistentCodeGraphBin } from "../helpers/fakeCodeGraph.js";

describe("ce refresh (integration)", () => {
  let harnessHomeDir: string;
  let repoDir: string;
  let fakeOpenSpec: FakeOpenSpecEnv;
  let fakeOpenCode: FakeOpenCodeEnv;
  let fakeClaude: FakeClaudeEnv;
  let fakeTemplatesDir: string;
  const originalHarnessHome = process.env.CE_HARNESS_HOME;
  const originalTemplatesRoot = process.env.CE_TEMPLATES_ROOT;

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    repoDir = await createTempRepo();
    fakeOpenSpec = await setupFakeOpenSpec();
    fakeOpenCode = await setupFakeOpenCode();
    fakeClaude = await setupFakeClaude();
    process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();

    // A controlled copy of the real template library, so tests can change
    // one command's content and prove refresh reacts to exactly that,
    // without depending on (or risking) the harness's own real templates/.
    fakeTemplatesDir = await mkdtemp(join(tmpdir(), "ce-harness-refresh-templates-"));
    const { templatesRoot } = await import("../../src/core/templates.js");
    await execa("cp", ["-R", join(templatesRoot(), "commands"), join(fakeTemplatesDir, "commands")]);
    await execa("cp", ["-R", join(templatesRoot(), "skills"), join(fakeTemplatesDir, "skills")]);
    process.env.CE_TEMPLATES_ROOT = fakeTemplatesDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHarnessHome === undefined) delete process.env.CE_HARNESS_HOME;
    else process.env.CE_HARNESS_HOME = originalHarnessHome;
    if (originalTemplatesRoot === undefined) delete process.env.CE_TEMPLATES_ROOT;
    else process.env.CE_TEMPLATES_ROOT = originalTemplatesRoot;
    await teardownFakeOpenSpec(fakeOpenSpec);
    await teardownFakeOpenCode(fakeOpenCode);
    await teardownFakeClaude(fakeClaude);
    delete process.env.CE_CODEGRAPH_BIN;
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
    await rm(fakeTemplatesDir, { recursive: true, force: true });
  });

  it("refuses with an actionable message when there is no active workspace", async () => {
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    const { CeError } = await import("../../src/core/errors.js");

    try {
      await refreshCommand();
      expect.fail("expected refreshCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toBe("No active workspace.");
      expect(ceError.recovery).toMatch(/ce start <repo> <issue>/);
    }
  });

  it("refuses when the recorded worktree is missing, recommending ce cleanup --force -- never silently repaired", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    const { CeError } = await import("../../src/core/errors.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    await rm(worktreePath, { recursive: true, force: true });

    try {
      await refreshCommand();
      expect.fail("expected refreshCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/its worktree no longer exists/);
      expect(ceError.recovery).toMatch(/ce cleanup --force/);
    }
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("a freshly-started workspace refreshes to all-unchanged: bootstraps hash history without rewriting anything", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    const contentBefore = await readFile(join(worktreePath, ".claude", "commands", "verify.md"), "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await refreshCommand();

    const contentAfter = await readFile(join(worktreePath, ".claude", "commands", "verify.md"), "utf8");
    expect(contentAfter).toBe(contentBefore);

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Unchanged:/);
    expect(output).toContain(join("commands", "verify.md"));
    expect(output).not.toMatch(/Skipped/);

    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
    expect(workspace.runnerWorktreeArtifacts?.commandsManagedHashes?.[join("commands", "verify.md")]).toBeTruthy();
  });

  it("updates an outdated harness-managed template with the current template's content", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");

    // The harness's template library moves on after this workspace was created.
    await writeFile(
      join(fakeTemplatesDir, "commands", "verify.md"),
      "an updated /verify, from a newer ce-harness\n",
      "utf8",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await refreshCommand();

    expect(await readFile(join(worktreePath, ".claude", "commands", "verify.md"), "utf8")).toBe(
      "an updated /verify, from a newer ce-harness\n",
    );
    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Updated:/);
    expect(output).toContain(join("commands", "verify.md"));
  });

  it("preserves a user-customized command file untouched, even while every other outdated template still updates", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");

    // Establish a real hash baseline first -- a hand-edit made *before the
    // very first refresh ever runs* is the documented bootstrap-trust
    // limitation (nothing to compare against yet, see runnerClaude.test.ts's
    // "bootstraps ... by trusting its current on-disk content" case), not
    // what this test is proving. One refresh with nothing yet to update
    // gives every command a genuine known-good hash to protect from here on.
    await refreshCommand();

    // The user hand-edits one command after that baseline was recorded...
    await writeFile(
      join(worktreePath, ".claude", "commands", "verify.md"),
      "my own customized /verify\n",
      "utf8",
    );
    // ...and, separately, the template library moves on for BOTH files.
    await writeFile(join(fakeTemplatesDir, "commands", "verify.md"), "newer /verify\n", "utf8");
    await writeFile(join(fakeTemplatesDir, "commands", "explore.md"), "newer /explore\n", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSpy.mockClear();
    await refreshCommand();

    // The customized file survives exactly as the user left it...
    expect(await readFile(join(worktreePath, ".claude", "commands", "verify.md"), "utf8")).toBe(
      "my own customized /verify\n",
    );
    // ...but the untouched one still updates normally.
    expect(await readFile(join(worktreePath, ".claude", "commands", "explore.md"), "utf8")).toBe(
      "newer /explore\n",
    );

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Skipped/);
    expect(output).toContain(join("commands", "verify.md"));
  });

  it("never touches product worktree changes -- an uncommitted edit to the repository's own file survives refresh untouched", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    await writeFile(join(worktreePath, "README.md"), "my in-progress product change\n", "utf8");
    await writeFile(join(worktreePath, "new-product-file.txt"), "brand new product file\n", "utf8");

    await writeFile(join(fakeTemplatesDir, "commands", "verify.md"), "newer /verify\n", "utf8");

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await refreshCommand();

    expect(await readFile(join(worktreePath, "README.md"), "utf8")).toBe("my in-progress product change\n");
    expect(await readFile(join(worktreePath, "new-product-file.txt"), "utf8")).toBe(
      "brand new product file\n",
    );

    const status = await execa("git", ["-C", worktreePath, "status", "--porcelain"]);
    expect(status.stdout).toContain("README.md");
    expect(status.stdout).toContain("new-product-file.txt");
  });

  it("never modifies the internal implementation branch or product Git history", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    const headBefore = (await execa("git", ["-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();
    const logBefore = (await execa("git", ["-C", worktreePath, "log", "--oneline"])).stdout.trim();

    await writeFile(join(fakeTemplatesDir, "commands", "verify.md"), "newer /verify\n", "utf8");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await refreshCommand();

    const headAfter = (await execa("git", ["-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();
    const logAfter = (await execa("git", ["-C", worktreePath, "log", "--oneline"])).stdout.trim();
    expect(headAfter).toBe(headBefore);
    expect(logAfter).toBe(logBefore);
  });

  it("never modifies or destroys the external OpenSpec store", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

    const registryBefore = await readFile(fakeOpenSpec.registryFile, "utf8");

    await writeFile(join(fakeTemplatesDir, "commands", "verify.md"), "newer /verify\n", "utf8");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await refreshCommand();

    const registryAfter = await readFile(fakeOpenSpec.registryFile, "utf8");
    expect(registryAfter).toBe(registryBefore);
  });

  it("never removes or recreates the worktree, and preserves every other workspace.yml field", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    const workspaceBefore = await readWorkspace(basenameOf(repoDir), "issue-1");

    await writeFile(join(fakeTemplatesDir, "commands", "verify.md"), "newer /verify\n", "utf8");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await refreshCommand();

    expect(existsSync(worktreePath)).toBe(true);
    const workspaceAfter = await readWorkspace(basenameOf(repoDir), "issue-1");

    // Only runnerWorktreeArtifacts (commandsManaged/commandsManagedHashes)
    // may have changed -- everything else about the workspace is untouched.
    const { runnerWorktreeArtifacts: _before, ...restBefore } = workspaceBefore;
    const { runnerWorktreeArtifacts: _after, ...restAfter } = workspaceAfter;
    expect(restAfter).toEqual(restBefore);
  });

  it("repeated refresh is a no-op: a second call right after the first changes nothing on disk and nothing in workspace.yml", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1", runner: "claude" });

    await writeFile(join(fakeTemplatesDir, "commands", "verify.md"), "newer /verify\n", "utf8");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await refreshCommand();

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    const contentAfterFirst = await readFile(join(worktreePath, ".claude", "commands", "verify.md"), "utf8");
    const workspaceAfterFirst = await readWorkspace(basenameOf(repoDir), "issue-1");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSpy.mockClear();
    await refreshCommand();

    const contentAfterSecond = await readFile(join(worktreePath, ".claude", "commands", "verify.md"), "utf8");
    const workspaceAfterSecond = await readWorkspace(basenameOf(repoDir), "issue-1");

    expect(contentAfterSecond).toBe(contentAfterFirst);
    expect(workspaceAfterSecond).toEqual(workspaceAfterFirst);

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Unchanged:/);
    expect(output).not.toMatch(/Updated:/);
    expect(output).not.toMatch(/Skipped/);
  });

  it("is runner-agnostic: an OpenCode (default-runner) workspace refreshes without error and reports nothing worktree-relative", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { refreshCommand } = await import("../../src/commands/refresh.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await startCommand({ repo: repoDir, issue: "issue-1" }); // no --runner -- OpenCode

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    expect(existsSync(join(worktreePath, ".claude"))).toBe(false);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(refreshCommand()).resolves.toBeUndefined();

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Refreshed OpenCode configuration/);
    expect(output).toMatch(/Nothing to refresh/);
    expect(existsSync(join(worktreePath, ".claude"))).toBe(false);
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
