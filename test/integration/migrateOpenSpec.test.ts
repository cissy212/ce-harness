import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempRepo } from "../helpers/tempRepo.js";
import { setupFakeOpenSpec, teardownFakeOpenSpec, type FakeOpenSpecEnv } from "../helpers/fakeOpenSpec.js";
import { setupFakeOpenCode, teardownFakeOpenCode, type FakeOpenCodeEnv } from "../helpers/fakeOpenCode.js";
import { nonExistentCodeGraphBin } from "../helpers/fakeCodeGraph.js";
import { nonExistentOsascriptBin } from "../helpers/fakeOsascript.js";

describe("ce migrate-openspec (integration)", () => {
  let harnessHomeDir: string;
  let repoDir: string;
  let fakeOpenSpec: FakeOpenSpecEnv;
  let fakeOpenCode: FakeOpenCodeEnv;
  const originalEnv = process.env.CE_HARNESS_HOME;

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    repoDir = await createTempRepo();
    fakeOpenSpec = await setupFakeOpenSpec();
    fakeOpenCode = await setupFakeOpenCode();
    process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
    process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    await teardownFakeOpenSpec(fakeOpenSpec);
    await teardownFakeOpenCode(fakeOpenCode);
    delete process.env.CE_CODEGRAPH_BIN;
    delete process.env.CE_OSASCRIPT_BIN;
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  function basenameOf(path: string): string {
    return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
  }

  /** Builds a legacy (pre-durable-storage), per-workspace OpenSpec store with real content, exactly what `ce start` created before this feature existed. */
  async function createLegacyWorkspaceWithContent(sanitizedIssue: string) {
    const { worktreePath: buildWorktreePath, workspacePath: buildWorkspacePath } = await import(
      "../../src/core/paths.js"
    );
    const { addWorktree, detectBaseBranch } = await import("../../src/core/git.js");
    const { generateStoreId, expectedOpenSpecRoot } = await import("../../src/core/openspecId.js");
    const { setupStore } = await import("../../src/core/openspec.js");
    const { writeWorkspace, writeActivePointer } = await import("../../src/core/workspace.js");

    const project = basenameOf(repoDir);
    const worktreePath = buildWorktreePath(project, sanitizedIssue);
    const workspacePath = buildWorkspacePath(project, sanitizedIssue);
    const baseBranch = await detectBaseBranch(repoDir);
    await addWorktree(repoDir, worktreePath, `ce-harness/${sanitizedIssue}`, baseBranch!.ref);
    await mkdir(workspacePath, { recursive: true });

    const storeId = generateStoreId(project, sanitizedIssue, repoDir);
    const root = expectedOpenSpecRoot(workspacePath);
    const setupResult = await setupStore(workspacePath, storeId, root);
    if (!setupResult.success) throw new Error("fixture setupStore failed");

    // Real content: an in-progress proposal and an archived change, plus a
    // synced main spec -- exactly the kind of history this feature exists
    // to preserve.
    await mkdir(join(root, "openspec", "changes", "add-widget"), { recursive: true });
    await writeFile(join(root, "openspec", "changes", "add-widget", "proposal.md"), "proposal\n", "utf8");
    await mkdir(join(root, "openspec", "changes", "archive", "2026-01-01-old-change"), { recursive: true });
    await writeFile(
      join(root, "openspec", "changes", "archive", "2026-01-01-old-change", "proposal.md"),
      "archived proposal\n",
      "utf8",
    );
    await mkdir(join(root, "openspec", "specs"), { recursive: true });
    await writeFile(join(root, "openspec", "specs", "widget.md"), "spec content\n", "utf8");

    const workspace = {
      project,
      repositoryPath: repoDir,
      issue: sanitizedIssue,
      sanitizedIssue,
      baseBranch: "main",
      internalBranch: `ce-harness/${sanitizedIssue}`,
      worktreePath,
      workspacePath,
      createdAt: new Date().toISOString(),
      openSpec: { storeId, root },
    };
    await writeWorkspace(workspace as Parameters<typeof writeWorkspace>[0]);
    await writeActivePointer({ project, sanitizedIssue });
    return { project, storeId, root, workspacePath };
  }

  it("migrates a legacy store's content to durable storage, leaving the source untouched", async () => {
    const { migrateOpenSpecCommand } = await import("../../src/commands/migrateOpenSpec.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const { expectedDurableOpenSpecRoot, generateProjectStoreId, isValidProjectId } = await import(
      "../../src/core/openspecId.js"
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { project, storeId: legacyStoreId, root: sourceRoot } = await createLegacyWorkspaceWithContent(
      "issue-1",
    );

    await migrateOpenSpecCommand();

    const workspace = await readWorkspace(project, "issue-1");
    expect(workspace.openSpec?.durable).toBe(true);
    // Project Identity mints an opaque, random project id -- unknowable
    // ahead of time -- so this asserts self-consistency against the id
    // the migration itself actually resolved to, rather than
    // precomputing an expected value independently.
    expect(workspace.openSpec?.projectId).toBeDefined();
    expect(isValidProjectId(workspace.openSpec!.projectId!)).toBe(true);
    expect(workspace.openSpec?.storeId).toBe(generateProjectStoreId(workspace.openSpec!.projectId!));
    const destRoot = expectedDurableOpenSpecRoot(workspace.openSpec!.projectId!);
    expect(workspace.openSpec?.root).toBe(destRoot);

    // Content preserved, byte-for-byte, at the new location.
    expect(await readFile(join(destRoot, "openspec", "changes", "add-widget", "proposal.md"), "utf8")).toBe(
      "proposal\n",
    );
    expect(
      await readFile(
        join(destRoot, "openspec", "changes", "archive", "2026-01-01-old-change", "proposal.md"),
        "utf8",
      ),
    ).toBe("archived proposal\n");
    expect(await readFile(join(destRoot, "openspec", "specs", "widget.md"), "utf8")).toBe("spec content\n");

    // The source is left exactly as it was -- never deleted or modified.
    expect(existsSync(sourceRoot)).toBe(true);
    expect(
      await readFile(join(sourceRoot, "openspec", "changes", "add-widget", "proposal.md"), "utf8"),
    ).toBe("proposal\n");

    // The new store is registered, and the OLD store's registration is
    // cleaned up (its files are untouched -- verified above -- but leaving
    // its registry entry in place would dangle once a later `ce cleanup`
    // deletes the now-unreferenced legacy directory nested in the
    // workspace).
    const registry = JSON.parse(await readFile(fakeOpenSpec.registryFile, "utf8"));
    expect(registry[workspace.openSpec!.storeId].root).toBe(destRoot);
    expect(registry[legacyStoreId]).toBeUndefined();
  });

  it("is a no-op when the active workspace already uses durable storage", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { migrateOpenSpecCommand } = await import("../../src/commands/migrateOpenSpec.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const before = await readWorkspace(basenameOf(repoDir), "issue-1");

    logSpy.mockClear();
    await migrateOpenSpecCommand();

    const after = await readWorkspace(basenameOf(repoDir), "issue-1");
    expect(after).toEqual(before);
    expect(logSpy.mock.calls.map((c) => c[0]).join("\n")).toMatch(/already using the durable/i);
  });

  it("running migration twice on the same workspace is idempotent", async () => {
    const { migrateOpenSpecCommand } = await import("../../src/commands/migrateOpenSpec.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createLegacyWorkspaceWithContent("issue-1");
    await migrateOpenSpecCommand();
    const project = basenameOf(repoDir);
    const first = await readWorkspace(project, "issue-1");

    await expect(migrateOpenSpecCommand()).resolves.toBeUndefined();
    const second = await readWorkspace(project, "issue-1");
    expect(second).toEqual(first);
  });

  /**
   * Project Identity mints an opaque, random project id, so a test that
   * needs to pre-populate content at a KNOWN destination ahead of time
   * (to exercise the conflict/already-migrated reconciliation paths)
   * must pin the destination explicitly via --project-id, which requires
   * that id to already exist as a scanned identity record -- mirroring
   * exactly how a real, already-known project id is recognized.
   */
  async function preRegisterDurableDestination(): Promise<{ projectId: string; destRoot: string; destStoreId: string }> {
    const { generateProjectId, generateProjectStoreId, expectedDurableOpenSpecRoot } = await import(
      "../../src/core/openspecId.js"
    );
    const { writeIdentityRecord } = await import("../../src/core/projectIdentity.js");
    const { setupStore } = await import("../../src/core/openspec.js");

    const projectId = generateProjectId();
    const destRoot = expectedDurableOpenSpecRoot(projectId);
    const destStoreId = generateProjectStoreId(projectId);
    await setupStore(harnessHomeDir, destStoreId, destRoot);
    await writeIdentityRecord(destRoot, {
      projectId,
      createdAt: new Date().toISOString(),
      evidence: [
        { project: basenameOf(repoDir), originUrl: null, rootCommit: null, recordedAt: new Date().toISOString() },
      ],
    });
    return { projectId, destRoot, destStoreId };
  }

  it("refuses (with an itemized error) when the durable destination already has conflicting content, and modifies neither store", async () => {
    const { migrateOpenSpecCommand } = await import("../../src/commands/migrateOpenSpec.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { root: sourceRoot } = await createLegacyWorkspaceWithContent("issue-1");

    // Simulate a durable store that already exists at the expected path,
    // with different, conflicting content (e.g. from an unrelated prior
    // migration attempt or manual setup).
    const { projectId, destRoot } = await preRegisterDurableDestination();
    await mkdir(join(destRoot, "openspec", "changes", "add-widget"), { recursive: true });
    await writeFile(
      join(destRoot, "openspec", "changes", "add-widget", "proposal.md"),
      "a completely different, conflicting proposal\n",
      "utf8",
    );

    await expect(migrateOpenSpecCommand({ projectId })).rejects.toThrow(/does not safely reconcile/i);

    // Neither store was modified.
    expect(await readFile(join(sourceRoot, "openspec", "changes", "add-widget", "proposal.md"), "utf8")).toBe(
      "proposal\n",
    );
    expect(
      await readFile(join(destRoot, "openspec", "changes", "add-widget", "proposal.md"), "utf8"),
    ).toBe("a completely different, conflicting proposal\n");
  });

  it("safely treats an already-identical durable destination as already migrated (no file copy, just repoint)", async () => {
    const { migrateOpenSpecCommand } = await import("../../src/commands/migrateOpenSpec.js");
    const { readWorkspace } = await import("../../src/core/workspace.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { project } = await createLegacyWorkspaceWithContent("issue-1");

    // Pre-populate the durable destination with EXACTLY the same content
    // the source has (e.g. a second legacy workspace for this project was
    // already migrated earlier, syncing the same main spec).
    const { projectId, destRoot } = await preRegisterDurableDestination();
    await mkdir(join(destRoot, "openspec", "changes", "add-widget"), { recursive: true });
    await writeFile(join(destRoot, "openspec", "changes", "add-widget", "proposal.md"), "proposal\n", "utf8");
    await mkdir(join(destRoot, "openspec", "changes", "archive", "2026-01-01-old-change"), { recursive: true });
    await writeFile(
      join(destRoot, "openspec", "changes", "archive", "2026-01-01-old-change", "proposal.md"),
      "archived proposal\n",
      "utf8",
    );
    await mkdir(join(destRoot, "openspec", "specs"), { recursive: true });
    await writeFile(join(destRoot, "openspec", "specs", "widget.md"), "spec content\n", "utf8");

    await expect(migrateOpenSpecCommand({ projectId })).resolves.toBeUndefined();

    const workspace = await readWorkspace(project, "issue-1");
    expect(workspace.openSpec?.durable).toBe(true);
    expect(workspace.openSpec?.projectId).toBe(projectId);
    expect(workspace.openSpec?.root).toBe(destRoot);
  });

  it("migrates a durable-but-legacy-scheme store (durable: true, no projectId) onto the current, Project-Identity-keyed scheme", async () => {
    const { migrateOpenSpecCommand } = await import("../../src/commands/migrateOpenSpec.js");
    const { readWorkspace, writeWorkspace, writeActivePointer } = await import("../../src/core/workspace.js");
    const { worktreePath: buildWorktreePath, workspacePath: buildWorkspacePath } = await import(
      "../../src/core/paths.js"
    );
    const { addWorktree, detectBaseBranch } = await import("../../src/core/git.js");
    const { generateLegacyProjectStoreId, expectedLegacyDurableOpenSpecRoot, isValidProjectId } = await import(
      "../../src/core/openspecId.js"
    );
    const { setupStore } = await import("../../src/core/openspec.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const project = basenameOf(repoDir);
    const sanitizedIssue = "issue-1";
    const worktreePath = buildWorktreePath(project, sanitizedIssue);
    const workspacePath = buildWorkspacePath(project, sanitizedIssue);
    const baseBranch = await detectBaseBranch(repoDir);
    await addWorktree(repoDir, worktreePath, `ce-harness/${sanitizedIssue}`, baseBranch!.ref);
    await mkdir(workspacePath, { recursive: true });

    const legacyDurableStoreId = generateLegacyProjectStoreId(project, repoDir);
    const legacyDurableRoot = expectedLegacyDurableOpenSpecRoot(project, repoDir);
    const setupResult = await setupStore(workspacePath, legacyDurableStoreId, legacyDurableRoot);
    if (!setupResult.success) throw new Error("fixture setupStore failed");
    await mkdir(join(legacyDurableRoot, "openspec", "specs"), { recursive: true });
    await writeFile(join(legacyDurableRoot, "openspec", "specs", "widget.md"), "spec content\n", "utf8");

    const workspace = {
      project,
      repositoryPath: repoDir,
      issue: sanitizedIssue,
      sanitizedIssue,
      baseBranch: "main",
      internalBranch: `ce-harness/${sanitizedIssue}`,
      worktreePath,
      workspacePath,
      createdAt: new Date().toISOString(),
      openSpec: { storeId: legacyDurableStoreId, root: legacyDurableRoot, durable: true },
    };
    await writeWorkspace(workspace as Parameters<typeof writeWorkspace>[0]);
    await writeActivePointer({ project, sanitizedIssue });

    await migrateOpenSpecCommand();

    const migrated = await readWorkspace(project, sanitizedIssue);
    expect(migrated.openSpec?.durable).toBe(true);
    expect(migrated.openSpec?.projectId).toBeDefined();
    expect(isValidProjectId(migrated.openSpec!.projectId!)).toBe(true);
    expect(migrated.openSpec?.storeId).not.toBe(legacyDurableStoreId);
    expect(migrated.openSpec?.root).not.toBe(legacyDurableRoot);
    expect(
      await readFile(join(migrated.openSpec!.root, "openspec", "specs", "widget.md"), "utf8"),
    ).toBe("spec content\n");
    // The old, path-hash-keyed store is left on disk untouched.
    expect(existsSync(legacyDurableRoot)).toBe(true);
  });

  it("throws a clear error when there is no active workspace", async () => {
    const { migrateOpenSpecCommand } = await import("../../src/commands/migrateOpenSpec.js");
    await expect(migrateOpenSpecCommand()).rejects.toThrow(/no active workspace/i);
  });

  it("throws a clear error when the active workspace has no OpenSpec store at all", async () => {
    const { migrateOpenSpecCommand } = await import("../../src/commands/migrateOpenSpec.js");
    const { writeActivePointer } = await import("../../src/core/workspace.js");
    const { worktreePath: buildWorktreePath, workspacePath: buildWorkspacePath } = await import(
      "../../src/core/paths.js"
    );
    const { addWorktree, detectBaseBranch } = await import("../../src/core/git.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const project = basenameOf(repoDir);
    const worktreePath = buildWorktreePath(project, "issue-1");
    const workspacePath = buildWorkspacePath(project, "issue-1");
    const baseBranch = await detectBaseBranch(repoDir);
    await addWorktree(repoDir, worktreePath, "ce-harness/issue-1", baseBranch!.ref);
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

    await expect(migrateOpenSpecCommand()).rejects.toThrow(/no valid openspec store/i);
  });
});
