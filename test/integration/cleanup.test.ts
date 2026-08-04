import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
