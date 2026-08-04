import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempRepo } from "../helpers/tempRepo.js";

describe("ce status (integration)", () => {
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

  it("prints a clear message when there is no active workspace", async () => {
    const { statusCommand } = await import("../../src/commands/status.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await statusCommand();

    expect(logSpy).toHaveBeenCalledWith("No active workspace.");
  });

  it("reports full details for the active workspace, including a clean worktree", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { statusCommand } = await import("../../src/commands/status.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await statusCommand();

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Issue:\s+issue-1/);
    expect(output).toMatch(/Base branch:\s+main/);
    expect(output).toMatch(/Internal branch:\s+ce-harness\/issue-1/);
    expect(output).toMatch(/Worktree exists:\s+yes/);
    expect(output).toMatch(/Branch exists:\s+yes/);
    expect(output).toMatch(/Worktree changes:\s+clean/);
  });

  it("reports changed files when the worktree has been modified", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { statusCommand } = await import("../../src/commands/status.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
    await writeFile(join(worktreePath, "new-file.txt"), "changed\n", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await statusCommand();

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Worktree changes:\s+1 changed file\(s\)/);
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
