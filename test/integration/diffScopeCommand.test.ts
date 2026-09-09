import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
