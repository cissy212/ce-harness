import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempRepo } from "../helpers/tempRepo.js";
import {
  nonExistentOpenSpecBin,
  setupFakeOpenSpec,
  teardownFakeOpenSpec,
  type FakeOpenSpecEnv,
} from "../helpers/fakeOpenSpec.js";
import {
  setupFakeOpenCode,
  teardownFakeOpenCode,
  type FakeOpenCodeEnv,
} from "../helpers/fakeOpenCode.js";

describe("ce status (integration)", () => {
  let harnessHomeDir: string;
  let repoDir: string;
  let fakeOpenSpec: FakeOpenSpecEnv;
  let fakeOpenCode: FakeOpenCodeEnv;
  const originalEnv = process.env.CE_HARNESS_HOME;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    repoDir = await createTempRepo();
    fakeOpenSpec = await setupFakeOpenSpec();
    fakeOpenCode = await setupFakeOpenCode();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    process.exitCode = originalExitCode;
    await teardownFakeOpenSpec(fakeOpenSpec);
    await teardownFakeOpenCode(fakeOpenCode);
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
    expect(output).toMatch(/OpenSpec store:\s+ce-/);
    expect(output).toMatch(/OpenSpec root:\s+.+\/openspec$/m);
    expect(output).toMatch(/OpenSpec healthy:\s+yes/);
    expect(output).toMatch(/OpenCode config:\s+.+\/opencode$/m);
    expect(output).toMatch(/OpenCode config exists:\s+yes/);
    expect(output).toMatch(/Lenses dir:\s+.+\/lenses$/m);
    expect(output).toMatch(/Lenses dir exists:\s+yes/);
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

  describe("OpenSpec status", () => {
    it("is read-only and reports unhealthy without touching the workspace when doctor reports a problem", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      process.env.FAKE_OPENSPEC_FAIL_DOCTOR = "1";
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/OpenSpec healthy:\s+no/);

      const worktreePath = join(harnessHomeDir, "worktrees", basenameOf(repoDir), "issue-1");
      expect((await import("node:fs")).existsSync(worktreePath)).toBe(true);
    });

    it("reports 'unavailable' when the store was manually unregistered", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      const { unregisterStore } = await import("../../src/core/openspec.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      await unregisterStore(workspace.workspacePath, workspace.openSpec!.storeId);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/OpenSpec healthy:\s+no/);
    });

    it("reports 'unavailable' (without crashing) when the openspec executable cannot be run", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      process.env.CE_OPENSPEC_BIN = nonExistentOpenSpecBin(fakeOpenSpec.dir);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await expect(statusCommand()).resolves.toBeUndefined();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/OpenSpec healthy:\s+unavailable/);
    });

    it("omits OpenSpec lines entirely for a legacy (v0.1) workspace file", async () => {
      const { statusCommand } = await import("../../src/commands/status.js");
      const { writeActivePointer } = await import("../../src/core/workspace.js");
      const { worktreePath: buildWorktreePath, workspacePath: buildWorkspacePath } = await import(
        "../../src/core/paths.js"
      );

      const project = basenameOf(repoDir);
      const worktreePath = buildWorktreePath(project, "issue-1");
      const workspacePath = buildWorkspacePath(project, "issue-1");
      await mkdir(workspacePath, { recursive: true });
      const legacyYaml = [
        `project: ${project}`,
        `repositoryPath: ${repoDir}`,
        "issue: issue-1",
        "sanitizedIssue: issue-1",
        "baseBranch: main",
        "internalBranch: ce-harness/issue-1",
        `worktreePath: ${worktreePath}`,
        `workspacePath: ${workspacePath}`,
        "createdAt: '2024-01-01T00:00:00.000Z'",
        "",
      ].join("\n");
      await writeFile(join(workspacePath, "workspace.yml"), legacyYaml, "utf8");
      await writeActivePointer({ project, sanitizedIssue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).not.toMatch(/OpenSpec/);
    });
  });

  describe("OpenCode config status", () => {
    it("reports the config directory and exists:yes right after start", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { statusCommand } = await import("../../src/commands/status.js");
      const { readWorkspace } = await import("../../src/core/workspace.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await statusCommand();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(
        new RegExp(`OpenCode config:\\s+${join(workspace.workspacePath, "opencode").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      expect(output).toMatch(/OpenCode config exists:\s+yes/);
      expect(output).toMatch(
        new RegExp(`Lenses dir:\\s+${join(workspace.workspacePath, "lenses").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      expect(output).toMatch(/Lenses dir exists:\s+yes/);
    });

    it("reports exists:no (without crashing) for a legacy workspace with no OpenCode config directory", async () => {
      const { statusCommand } = await import("../../src/commands/status.js");
      const { writeActivePointer } = await import("../../src/core/workspace.js");
      const { worktreePath: buildWorktreePath, workspacePath: buildWorkspacePath } = await import(
        "../../src/core/paths.js"
      );

      const project = basenameOf(repoDir);
      const worktreePath = buildWorktreePath(project, "issue-1");
      const workspacePath = buildWorkspacePath(project, "issue-1");
      await mkdir(workspacePath, { recursive: true });
      const legacyYaml = [
        `project: ${project}`,
        `repositoryPath: ${repoDir}`,
        "issue: issue-1",
        "sanitizedIssue: issue-1",
        "baseBranch: main",
        "internalBranch: ce-harness/issue-1",
        `worktreePath: ${worktreePath}`,
        `workspacePath: ${workspacePath}`,
        "createdAt: '2024-01-01T00:00:00.000Z'",
        "",
      ].join("\n");
      await writeFile(join(workspacePath, "workspace.yml"), legacyYaml, "utf8");
      await writeActivePointer({ project, sanitizedIssue: "issue-1" });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await expect(statusCommand()).resolves.toBeUndefined();

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toMatch(/OpenCode config:\s+.+\/opencode$/m);
      expect(output).toMatch(/OpenCode config exists:\s+no/);
      expect(output).toMatch(/Lenses dir:\s+.+\/lenses$/m);
      expect(output).toMatch(/Lenses dir exists:\s+no/);
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
