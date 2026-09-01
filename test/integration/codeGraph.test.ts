import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  nonExistentCodeGraphBin,
  setupFakeCodeGraph,
  teardownFakeCodeGraph,
} from "../helpers/fakeCodeGraph.js";
import { nonExistentOsascriptBin } from "../helpers/fakeOsascript.js";

describe("CodeGraph (semantic code navigation) integration", () => {
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
    setupFakeCodeGraph();
    // Deterministic regardless of whether this machine happens to have
    // real iTerm2/osascript -- iTerm2 presentation itself is covered by
    // test/unit/iterm2.test.ts and test/unit/workspacePresenter.test.ts.
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
    teardownFakeCodeGraph();
    delete process.env.CE_OSASCRIPT_BIN;
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  describe("repository does NOT gitignore .codegraph/ (the realistic, worst case)", () => {
    it("ce start succeeds, initializes CodeGraph inside the worktree, and injects the generic capability env vars", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });

      const { readWorkspace } = await import("../../src/core/workspace.js");
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      expect(workspace.codeGraph?.available).toBe(true);
      expect(workspace.codeGraph?.managedByHarness).toBe(true);
      expect(workspace.codeGraph?.indexPath).toBe(join(workspace.worktreePath, ".codegraph"));
      expect(existsSync(join(workspace.worktreePath, ".codegraph"))).toBe(true);

      const launch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));
      expect(launch.env.CE_CODE_NAV_AVAILABLE).toBe("1");
      expect(launch.env.CE_CODE_NAV_PROVIDER).toBe("codegraph");
      expect(launch.env.OPENCODE_CONFIG).toBe(
        join(workspace.workspacePath, "opencode", "opencode.json"),
      );

      const config = JSON.parse(await readFile(launch.env.OPENCODE_CONFIG, "utf8"));
      expect(config.mcp.codegraph.enabled).toBe(true);
      expect(config.mcp.codegraph.command).toContain(workspace.worktreePath);
    });

    it("ce status reports the worktree clean when the user made no changes of their own", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line: string) => {
        logs.push(line);
      });

      const { statusCommand } = await import("../../src/commands/status.js");
      await statusCommand();

      expect(logs.some((line) => line.includes("Worktree changes: clean"))).toBe(true);
      expect(logs.some((line) => line.includes("CodeGraph:") && line.includes("available"))).toBe(
        true,
      );
    });

    it("a real user-created untracked file still makes the worktree dirty, alongside the ignored CodeGraph index", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      const { readWorkspace } = await import("../../src/core/workspace.js");
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      await writeFile(join(workspace.worktreePath, "my-real-change.txt"), "real work\n", "utf8");

      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line: string) => {
        logs.push(line);
      });

      const { statusCommand } = await import("../../src/commands/status.js");
      await statusCommand();

      // Exactly one real change (the .codegraph/* entries must not be counted).
      expect(logs.some((line) => line.includes("Worktree changes: 1 changed file(s)"))).toBe(true);
    });

    it("ce cleanup succeeds without --force when only the harness-managed CodeGraph index is present", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      const { readWorkspace } = await import("../../src/core/workspace.js");
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(existsSync(join(workspace.worktreePath, ".codegraph"))).toBe(true);

      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      await expect(cleanupCommand({})).resolves.not.toThrow();

      expect(existsSync(workspace.worktreePath)).toBe(false);
      const { readActivePointer } = await import("../../src/core/workspace.js");
      expect(await readActivePointer()).toBeNull();
    });

    it("ce cleanup still requires --force when a real change exists alongside the CodeGraph index", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      const { readWorkspace } = await import("../../src/core/workspace.js");
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      await writeFile(join(workspace.worktreePath, "my-real-change.txt"), "real work\n", "utf8");

      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      const { CeError } = await import("../../src/core/errors.js");
      await expect(cleanupCommand({})).rejects.toThrow(CeError);

      // Nothing was removed.
      expect(existsSync(workspace.worktreePath)).toBe(true);

      await expect(cleanupCommand({ force: true })).resolves.not.toThrow();
      expect(existsSync(workspace.worktreePath)).toBe(false);
    });

    it("the original repository is never touched -- no .codegraph/ or any other new file appears there", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      expect(existsSync(join(repoDir, ".codegraph"))).toBe(false);
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);

      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      await cleanupCommand({});
      expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
    });

    it('".codegraph" never appears as an untracked directory in real, unfiltered `git status` -- not just ce-harness\'s own summary', async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      const { readWorkspace } = await import("../../src/core/workspace.js");
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      // The real `git status`, run directly -- exactly what a user typing
      // it themselves (or their editor/IDE) would see. Never routed
      // through ce-harness's own filterHarnessManagedChanges.
      const status = await execa("git", ["-C", workspace.worktreePath, "status", "--porcelain"]);
      expect(status.stdout).toBe("");

      const untracked = await execa("git", [
        "-C",
        workspace.worktreePath,
        "status",
        "--porcelain",
        "--ignored",
      ]);
      expect(untracked.stdout).toMatch(/!! \.codegraph\//);
    });

    it("adds the exclude entry to the repository's local, never-committed exclude file -- never a tracked .gitignore change", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      const commonDir = (
        await execa("git", ["-C", repoDir, "rev-parse", "--git-common-dir"])
      ).stdout.trim();
      const excludeContent = await readFile(join(repoDir, commonDir, "info", "exclude"), "utf8");
      expect(excludeContent).toContain("/.codegraph");

      // Never a tracked file change -- confirmed by the original
      // repository's own status staying clean.
      const originalStatus = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(originalStatus.stdout).toBe("");
      expect(existsSync(join(repoDir, ".gitignore"))).toBe(false);
    });

    it("a second workspace for a different issue in the same repository never duplicates the exclude entry", async () => {
      const { startCommand } = await import("../../src/commands/start.js");
      const { cleanupCommand } = await import("../../src/commands/cleanup.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await startCommand({ repo: repoDir, issue: "issue-1" });
      await cleanupCommand({});
      await startCommand({ repo: repoDir, issue: "issue-2" });

      const commonDir = (
        await execa("git", ["-C", repoDir, "rev-parse", "--git-common-dir"])
      ).stdout.trim();
      const excludeContent = await readFile(join(repoDir, commonDir, "info", "exclude"), "utf8");
      const occurrences = excludeContent
        .split("\n")
        .filter((line) => line.trim() === "/.codegraph").length;
      expect(occurrences).toBe(1);
    });
  });

  describe("pre-existing .codegraph/ in the worktree (e.g. tracked by the repository itself)", () => {
    it("never claims ownership, never deletes it, reports unavailable, and skips MCP wiring entirely", async () => {
      // Commit a .codegraph/ directory into the repository itself, so it
      // is already present the moment the fresh worktree is checked out --
      // before ce-harness's own CodeGraph provisioning ever runs.
      await execa("mkdir", ["-p", join(repoDir, ".codegraph")]);
      await writeFile(join(repoDir, ".codegraph", "tracked.db"), "committed content\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a .codegraph directory"]);

      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      const { readWorkspace } = await import("../../src/core/workspace.js");
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");

      expect(workspace.codeGraph?.available).toBe(false);
      expect(workspace.codeGraph?.managedByHarness).toBe(false);
      expect(workspace.codeGraph?.reason).toMatch(/already exists/i);

      // The tracked content is untouched, in both the worktree and the
      // original repository.
      expect(
        await readFile(join(workspace.worktreePath, ".codegraph", "tracked.db"), "utf8"),
      ).toBe("committed content\n");
      expect(await readFile(join(repoDir, ".codegraph", "tracked.db"), "utf8")).toBe(
        "committed content\n",
      );

      // No MCP config was written, and no capability env vars were injected.
      expect(existsSync(join(workspace.workspacePath, "opencode", "opencode.json"))).toBe(false);
      const launch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));
      expect(launch.env.CE_CODE_NAV_AVAILABLE).toBeNull();
      expect(launch.env.CE_CODE_NAV_PROVIDER).toBeNull();

      // ce status must not report this tracked, untouched directory as a
      // change at all (it's committed, unmodified content) -- confirming
      // ce-harness applied no special-case exclusion logic to it either.
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line: string) => {
        logs.push(line);
      });
      const { statusCommand } = await import("../../src/commands/status.js");
      await statusCommand();
      expect(logs.some((line) => line.includes("Worktree changes: clean"))).toBe(true);
    });

    it("never adds an exclude entry for a pre-existing, unowned .codegraph directory", async () => {
      await execa("mkdir", ["-p", join(repoDir, ".codegraph")]);
      await writeFile(join(repoDir, ".codegraph", "tracked.db"), "committed content\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a .codegraph directory"]);

      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      const commonDir = (
        await execa("git", ["-C", repoDir, "rev-parse", "--git-common-dir"])
      ).stdout.trim();
      const excludeFile = join(repoDir, commonDir, "info", "exclude");
      const excludeContent = existsSync(excludeFile) ? await readFile(excludeFile, "utf8") : "";
      expect(excludeContent).not.toContain(".codegraph");
    });
  });

  describe("CodeGraph binary not on PATH", () => {
    it("ce start still succeeds; workspace records unavailable; no capability env vars injected", async () => {
      process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
      process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await expect(startCommand({ repo: repoDir, issue: "issue-1" })).resolves.not.toThrow();

      const { readWorkspace } = await import("../../src/core/workspace.js");
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.codeGraph?.available).toBe(false);
      expect(workspace.codeGraph?.reason).toMatch(/not found on PATH/i);

      const launch = JSON.parse(await readFile(fakeOpenCode.outputFile, "utf8"));
      expect(launch.env.CE_CODE_NAV_AVAILABLE).toBeNull();
    });

    it("never adds an exclude entry when CodeGraph is unavailable -- nothing to exclude", async () => {
      process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
      process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await startCommand({ repo: repoDir, issue: "issue-1" });

      const commonDir = (
        await execa("git", ["-C", repoDir, "rev-parse", "--git-common-dir"])
      ).stdout.trim();
      const excludeFile = join(repoDir, commonDir, "info", "exclude");
      const excludeContent = existsSync(excludeFile) ? await readFile(excludeFile, "utf8") : "";
      expect(excludeContent).not.toContain(".codegraph");
    });
  });

  describe("CodeGraph init failure", () => {
    it("ce start still succeeds; workspace records the failure reason", async () => {
      process.env.FAKE_CODEGRAPH_INIT_EXIT_CODE = "1";
      process.env.FAKE_CODEGRAPH_INIT_STDERR = "simulated init failure\n";
      const { startCommand } = await import("../../src/commands/start.js");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await expect(startCommand({ repo: repoDir, issue: "issue-1" })).resolves.not.toThrow();

      const { readWorkspace } = await import("../../src/core/workspace.js");
      const workspace = await readWorkspace(basenameOf(repoDir), "issue-1");
      expect(workspace.codeGraph?.available).toBe(false);
      expect(workspace.codeGraph?.reason).toMatch(/simulated init failure/);
    });
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
