import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { createTempRepo } from "../helpers/tempRepo.js";

describe("ce cleanup (integration)", () => {
  let harnessHomeDir: string;
  let repoDir: string;
  const originalEnv = process.env.CE_HARNESS_HOME;

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("prints a clear message and exits successfully when there is no active workspace", async () => {
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(cleanupCommand({})).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith("No active workspace to clean up.");
  });

  it("refuses to clean up a dirty worktree without --force", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    await expect(cleanupCommand({})).rejects.toThrow(/tracked or untracked change/i);

    // Nothing should have been removed.
    expect(existsSync(worktreePath)).toBe(true);
    const { readActivePointer } = await import("../../src/core/workspace.js");
    expect(await readActivePointer()).not.toBeNull();
  });

  it("successfully force-cleans a dirty worktree", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    await cleanupCommand({ force: true });

    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(workspacePath)).toBe(false);

    const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
    expect(branches.stdout.trim()).toBe("");

    const { readActivePointer } = await import("../../src/core/workspace.js");
    expect(await readActivePointer()).toBeNull();

    // The original repository must remain untouched (still has its initial commit and clean tree).
    const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  });

  it("cleans up a clean worktree without --force", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    await expect(cleanupCommand({})).resolves.toBeUndefined();

    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("is idempotent when run twice in a row", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { cleanupCommand } = await import("../../src/commands/cleanup.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    await cleanupCommand({});
    await expect(cleanupCommand({})).resolves.toBeUndefined();
  });

  describe("cwd-inside-worktree protection", () => {
    it("refuses cleanup when the current working directory is the worktree root itself", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");

      vi.spyOn(process, "cwd").mockReturnValue(worktreePath);

      await expect(cleanupCommand({})).rejects.toThrow(/current directory is inside the worktree/i);

      expect(existsSync(worktreePath)).toBe(true);
      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).not.toBeNull();
      const branches = await execa("git", ["-C", repoDir, "branch", "--list", "ce-harness/issue-1"]);
      expect(branches.stdout).toContain("ce-harness/issue-1");
    });

    it("refuses cleanup when the current working directory is nested inside the worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      const nestedDir = join(worktreePath, "src", "nested");
      await mkdir(nestedDir, { recursive: true });

      vi.spyOn(process, "cwd").mockReturnValue(nestedDir);

      await expect(cleanupCommand({})).rejects.toThrow(/current directory is inside the worktree/i);
      expect(existsSync(worktreePath)).toBe(true);
    });

    it("is not bypassed by --force", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");

      vi.spyOn(process, "cwd").mockReturnValue(worktreePath);

      await expect(cleanupCommand({ force: true })).rejects.toThrow(
        /current directory is inside the worktree/i,
      );

      // Nothing was removed, even with --force.
      expect(existsSync(worktreePath)).toBe(true);
      const workspacePath = join(harnessHomeDir, "workspaces", basenameOf(repoDir), "issue-1");
      expect(existsSync(workspacePath)).toBe(true);
      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).not.toBeNull();
    });

    it("allows cleanup once the current working directory moves outside the worktree", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(worktreePath);
      await expect(cleanupCommand({})).rejects.toThrow(/current directory is inside the worktree/i);

      cwdSpy.mockReturnValue(repoDir);
      await expect(cleanupCommand({})).resolves.toBeUndefined();
      expect(existsSync(worktreePath)).toBe(false);
    });
  });

  describe("empty project-level directory cleanup", () => {
    it("removes now-empty project directories under worktrees/ and workspaces/ after cleanup", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      await cleanupCommand({});

      const projectWorktreeDir = join(harnessHomeDir, "worktrees", basenameOf(repoDir));
      const projectWorkspaceDir = join(harnessHomeDir, "workspaces", basenameOf(repoDir));
      expect(existsSync(projectWorktreeDir)).toBe(false);
      expect(existsSync(projectWorkspaceDir)).toBe(false);

      // Top-level runtime directories must remain.
      expect(existsSync(join(harnessHomeDir, "worktrees"))).toBe(true);
      expect(existsSync(join(harnessHomeDir, "workspaces"))).toBe(true);
    });

    it("preserves project directories that still contain other entries", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      // Simulate a leftover sibling directory for another issue under the
      // same project, e.g. from a previous run.
      const projectWorktreeDir = join(harnessHomeDir, "worktrees", basenameOf(repoDir));
      await mkdir(join(projectWorktreeDir, "other-issue"), { recursive: true });

      await cleanupCommand({});

      // worktrees/<project> still has "other-issue" in it, so it must survive.
      expect(existsSync(projectWorktreeDir)).toBe(true);
      expect(existsSync(join(projectWorktreeDir, "other-issue"))).toBe(true);

      // workspaces/<project> had nothing else in it, so it is removed.
      const projectWorkspaceDir = join(harnessHomeDir, "workspaces", basenameOf(repoDir));
      expect(existsSync(projectWorkspaceDir)).toBe(false);
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
