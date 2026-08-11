import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempRepo } from "../helpers/tempRepo.js";
import {
  setupFakeCodeGraph,
  teardownFakeCodeGraph,
  nonExistentCodeGraphBin,
} from "../helpers/fakeCodeGraph.js";

describe("initializeCodeGraph", () => {
  let worktreeDir: string;

  beforeEach(async () => {
    setupFakeCodeGraph();
    worktreeDir = await mkdtemp(join(tmpdir(), "ce-harness-codegraph-worktree-"));
  });

  afterEach(async () => {
    teardownFakeCodeGraph();
    await rm(worktreeDir, { recursive: true, force: true });
  });

  it("reports unavailable, without attempting init, when the binary is not on PATH", async () => {
    process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
    const { initializeCodeGraph } = await import("../../src/core/codeGraph.js");

    const result = await initializeCodeGraph(worktreeDir);

    expect(result.available).toBe(false);
    expect(result.managedByHarness).toBe(false);
    expect(result.reason).toMatch(/not found on PATH/i);
    expect(existsSync(join(worktreeDir, ".codegraph"))).toBe(false);
  });

  it("succeeds: creates the index, reports available + managedByHarness with indexPath/initializedAt", async () => {
    const { initializeCodeGraph, expectedCodeGraphIndexPath } = await import(
      "../../src/core/codeGraph.js"
    );

    const result = await initializeCodeGraph(worktreeDir);

    expect(result.available).toBe(true);
    expect(result.managedByHarness).toBe(true);
    expect(result.indexPath).toBe(expectedCodeGraphIndexPath(worktreeDir));
    expect(result.initializedAt).toBeTruthy();
    expect(existsSync(join(worktreeDir, ".codegraph"))).toBe(true);
  });

  it("reports unavailable when `codegraph init` exits non-zero", async () => {
    process.env.FAKE_CODEGRAPH_INIT_EXIT_CODE = "1";
    process.env.FAKE_CODEGRAPH_INIT_STDERR = "disk full\n";
    const { initializeCodeGraph } = await import("../../src/core/codeGraph.js");

    const result = await initializeCodeGraph(worktreeDir);

    expect(result.available).toBe(false);
    expect(result.managedByHarness).toBe(false);
    expect(result.reason).toMatch(/init.*failed/i);
    expect(result.reason).toMatch(/disk full/);
    expect(existsSync(join(worktreeDir, ".codegraph"))).toBe(false);
  });

  it("reports unavailable when init reports success but no .codegraph directory appears", async () => {
    process.env.FAKE_CODEGRAPH_SKIP_CREATE = "1";
    const { initializeCodeGraph } = await import("../../src/core/codeGraph.js");

    const result = await initializeCodeGraph(worktreeDir);

    expect(result.available).toBe(false);
    expect(result.managedByHarness).toBe(false);
    expect(result.reason).toMatch(/no ".codegraph" directory was found/i);
  });

  it("never claims, modifies, or deletes a pre-existing .codegraph directory", async () => {
    const preExistingDir = join(worktreeDir, ".codegraph");
    await mkdir(preExistingDir, { recursive: true });
    await writeFile(join(preExistingDir, "committed-file.txt"), "tracked content\n", "utf8");

    const { initializeCodeGraph } = await import("../../src/core/codeGraph.js");
    const result = await initializeCodeGraph(worktreeDir);

    expect(result.available).toBe(false);
    expect(result.managedByHarness).toBe(false);
    expect(result.reason).toMatch(/already exists/i);
    // The pre-existing content must be completely untouched.
    expect(existsSync(join(preExistingDir, "committed-file.txt"))).toBe(true);
  });

  it("never throws even on an unexpected internal error", async () => {
    // Pointing CE_CODEGRAPH_BIN at a directory (not an executable file)
    // forces execa to fail in a way that isn't the normal ENOENT path.
    process.env.CE_CODEGRAPH_BIN = worktreeDir;
    const { initializeCodeGraph } = await import("../../src/core/codeGraph.js");

    await expect(initializeCodeGraph(worktreeDir)).resolves.toMatchObject({
      available: false,
      managedByHarness: false,
    });
  });
});

describe("ignoreCodeGraphIndex", () => {
  let repoDir: string;

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("adds /.codegraph to the repository's local exclude file, and reports { ignored: true }", async () => {
    repoDir = await createTempRepo();
    const { ignoreCodeGraphIndex } = await import("../../src/core/codeGraph.js");

    const result = await ignoreCodeGraphIndex(repoDir);

    expect(result).toEqual({ ignored: true });
    const commonDir = (
      await execa("git", ["-C", repoDir, "rev-parse", "--git-common-dir"])
    ).stdout.trim();
    const excludeContent = await readFile(join(repoDir, commonDir, "info", "exclude"), "utf8");
    expect(excludeContent).toContain("/.codegraph");
  });

  it("makes an actually-created .codegraph directory disappear from git status", async () => {
    repoDir = await createTempRepo();
    const { ignoreCodeGraphIndex } = await import("../../src/core/codeGraph.js");

    await ignoreCodeGraphIndex(repoDir);
    await mkdir(join(repoDir, ".codegraph"), { recursive: true });
    await writeFile(join(repoDir, ".codegraph", "codegraph.db"), "data", "utf8");

    const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
    expect(status.stdout).toBe("");
  });

  it("never throws -- reports { ignored: false, reason } when the path is not a Git repository at all", async () => {
    repoDir = await mkdtemp(join(tmpdir(), "ce-harness-not-a-repo-"));
    const { ignoreCodeGraphIndex } = await import("../../src/core/codeGraph.js");

    const result = await ignoreCodeGraphIndex(repoDir);

    expect(result.ignored).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("resolveTrustedCodeGraph", () => {
  const baseWorkspace = {
    project: "demo",
    repositoryPath: "/tmp/demo-repo",
    issue: "issue-1",
    sanitizedIssue: "issue-1",
    baseBranch: "main",
    internalBranch: "ce-harness/issue-1",
    worktreePath: "/tmp/demo-worktree",
    workspacePath: "/tmp/demo-workspace",
    createdAt: new Date().toISOString(),
  };

  it("returns null when no codeGraph block is present", async () => {
    const { resolveTrustedCodeGraph } = await import("../../src/core/codeGraph.js");
    expect(resolveTrustedCodeGraph(baseWorkspace as never)).toBeNull();
  });

  it("returns null when available is false", async () => {
    const { resolveTrustedCodeGraph } = await import("../../src/core/codeGraph.js");
    const workspace = {
      ...baseWorkspace,
      codeGraph: { available: false, managedByHarness: false, reason: "not found" },
    };
    expect(resolveTrustedCodeGraph(workspace as never)).toBeNull();
  });

  it("returns null when managedByHarness is false even if available is true", async () => {
    const { resolveTrustedCodeGraph, expectedCodeGraphIndexPath } = await import(
      "../../src/core/codeGraph.js"
    );
    const workspace = {
      ...baseWorkspace,
      codeGraph: {
        available: true,
        managedByHarness: false,
        indexPath: expectedCodeGraphIndexPath(baseWorkspace.worktreePath),
        initializedAt: new Date().toISOString(),
      },
    };
    expect(resolveTrustedCodeGraph(workspace as never)).toBeNull();
  });

  it("returns null when indexPath does not match what ce-harness would itself compute", async () => {
    const { resolveTrustedCodeGraph } = await import("../../src/core/codeGraph.js");
    const workspace = {
      ...baseWorkspace,
      codeGraph: {
        available: true,
        managedByHarness: true,
        indexPath: "/some/tampered/path/.codegraph",
        initializedAt: new Date().toISOString(),
      },
    };
    expect(resolveTrustedCodeGraph(workspace as never)).toBeNull();
  });

  it("returns the metadata when available, managed, and indexPath matches exactly", async () => {
    const { resolveTrustedCodeGraph, expectedCodeGraphIndexPath } = await import(
      "../../src/core/codeGraph.js"
    );
    const codeGraph = {
      available: true,
      managedByHarness: true,
      indexPath: expectedCodeGraphIndexPath(baseWorkspace.worktreePath),
      initializedAt: new Date().toISOString(),
    };
    const workspace = { ...baseWorkspace, codeGraph };
    expect(resolveTrustedCodeGraph(workspace as never)).toEqual(codeGraph);
  });
});
