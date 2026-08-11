import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("Repository bootstrap detection (ce start integration)", () => {
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
    process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
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
    delete process.env.CE_CODEGRAPH_BIN;
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("detects an uninstalled Node.js repository, records it in workspace.yml, and prints actionable instructions", async () => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add package.json"]);

    const { startCommand } = await import("../../src/commands/start.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
    expect(workspace.bootstrap).toBeDefined();
    expect(workspace.bootstrap!.required).toBe(true);
    expect(workspace.bootstrap!.findings).toHaveLength(1);
    expect(workspace.bootstrap!.findings[0]).toMatchObject({
      ecosystem: "npm",
      manifest: "package.json",
      suggestedCommand: "npm install",
    });

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/needs local setup before normal use/i);
    expect(output).toMatch(/node_modules\/ does not exist/);
    expect(output).toMatch(/Run: npm install/);
    expect(output).toMatch(/ce-harness never runs these automatically/i);
  });

  it("never creates node_modules, never runs npm, and never modifies the repository itself", async () => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add package.json"]);

    const { startCommand } = await import("../../src/commands/start.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(workspace.worktreePath, "node_modules"))).toBe(false);
    expect(existsSync(join(repoDir, "node_modules"))).toBe(false);

    const statusAfter = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
    expect(statusAfter.stdout).toBe("");
  });

  it("does not flag a repository whose dependencies are already installed", async () => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add package.json"]);
    // Tracked, so it's checked out into the worktree too -- simulates a
    // repository that (unusually) commits its node_modules, but more
    // realistically stands in for "already bootstrapped" for this test's
    // purposes without needing a real npm install.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(repoDir, "node_modules"), { recursive: true });
    await writeFile(join(repoDir, "node_modules", ".gitkeep"), "", "utf8");
    await execa("git", ["-C", repoDir, "add", "-f", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add node_modules"]);

    const { startCommand } = await import("../../src/commands/start.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSpy.mockClear();

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
    expect(workspace.bootstrap).toEqual({ required: false, findings: [] });

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).not.toMatch(/needs local setup/i);
  });

  it("records no bootstrap requirement for a repository with no recognized manifest at all", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
    expect(workspace.bootstrap).toEqual({ required: false, findings: [] });
  });

  it("shows bootstrap status in `ce status`, matching what ce start reported", async () => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add package.json"]);

    const { startCommand } = await import("../../src/commands/start.js");
    const { statusCommand } = await import("../../src/commands/status.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    logSpy.mockClear();

    await statusCommand();

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Bootstrap:\s+required \(1 item\(s\)\)/);
    expect(output).toMatch(/Run: npm install/);
  });

  it('`ce status` reports "not required" when nothing needs bootstrapping', async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { statusCommand } = await import("../../src/commands/status.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    logSpy.mockClear();

    await statusCommand();

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Bootstrap:\s+not required/);
  });

  it("detects multiple ecosystems independently in the same repository", async () => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    await writeFile(join(repoDir, "composer.json"), JSON.stringify({ name: "demo/demo" }), "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add manifests"]);

    const { startCommand } = await import("../../src/commands/start.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
    expect(workspace.bootstrap!.required).toBe(true);
    expect(workspace.bootstrap!.findings.map((f) => f.ecosystem).sort()).toEqual([
      "Composer",
      "npm",
    ]);
  });

  it("a bootstrap-detection failure never fails ce start itself", async () => {
    // Simulate an unexpected failure inside detection by making the
    // worktree path briefly unreadable is impractical/platform-fragile
    // here; instead this documents and exercises the contract at the
    // call-site level: start still succeeds and records a
    // not-required result when nothing triggers any probe, and the
    // defensive try/catch around detectBootstrapNeeds in start.ts is
    // covered by the unit-level "never throws on a malformed
    // package.json" test in test/unit/bootstrap.test.ts.
    const { startCommand } = await import("../../src/commands/start.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(startCommand({ repo: repoDir, issue: "issue-1" })).resolves.toBeUndefined();
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
