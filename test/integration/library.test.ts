import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { nonExistentOsascriptBin } from "../helpers/fakeOsascript.js";
import {
  setupFakeEditor,
  teardownFakeEditor,
  type FakeEditorEnv,
} from "../helpers/fakeEditor.js";

describe("ce library (integration)", () => {
  let harnessHomeDir: string;
  let repoDir: string;
  let fakeOpenSpec: FakeOpenSpecEnv;
  let fakeOpenCode: FakeOpenCodeEnv;
  let fakeEditor: FakeEditorEnv;
  const originalEnv = process.env.CE_HARNESS_HOME;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    repoDir = await createTempRepo();
    fakeOpenSpec = await setupFakeOpenSpec();
    fakeOpenCode = await setupFakeOpenCode();
    fakeEditor = await setupFakeEditor();
    process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
    process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();
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
    await teardownFakeEditor(fakeEditor);
    delete process.env.CE_CODEGRAPH_BIN;
    delete process.env.CE_OSASCRIPT_BIN;
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  function libraryRootPath(): string {
    return join(harnessHomeDir, "library");
  }

  async function trustedRoot(): Promise<string> {
    const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
      "../../src/core/workspace.js"
    );
    const pointer = await readActivePointer();
    const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
    const trusted = resolveTrustedOpenSpec(workspace);
    return trusted!.root;
  }

  it("creates a project folder named after the project's label, opened in the editor", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { libraryCommand } = await import("../../src/commands/library.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const label = basenameOf(repoDir);

    await libraryCommand();

    expect(existsSync(join(libraryRootPath(), label))).toBe(true);
    const recorded = JSON.parse(await readFile(fakeEditor.outputFile, "utf8"));
    expect(recorded.argv).toEqual([libraryRootPath()]);
  });

  it("only shows changes/archive/specs/reviews that actually exist -- symlinked, never copied, verified by content matching through the link", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { libraryCommand } = await import("../../src/commands/library.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const root = await trustedRoot();
    const label = basenameOf(repoDir);

    // An active change (contributes to `changes/`) and an archived one
    // (contributes to both `changes/` and `archive/`).
    await mkdir(join(root, "openspec", "changes", "add-contact-notes"), { recursive: true });
    await writeFile(
      join(root, "openspec", "changes", "add-contact-notes", "proposal.md"),
      "# Proposal\n\nUnique marker: contact-notes-proposal\n",
      "utf8",
    );
    await mkdir(join(root, "openspec", "changes", "archive", "2026-05-01-old-change"), { recursive: true });
    await writeFile(
      join(root, "openspec", "changes", "archive", "2026-05-01-old-change", "proposal.md"),
      "# Proposal\n\nUnique marker: old-change-proposal\n",
      "utf8",
    );
    // No specs/ and no reviews/ -- both should be absent from the library.

    await libraryCommand();

    const projectDir = join(libraryRootPath(), label);
    const entries = (await readdir(projectDir)).sort();
    expect(entries).toEqual(["archive", "changes"]);

    // The symlinks resolve to the real content -- no copy was made.
    const proposalThroughChangesLink = await readFile(
      join(projectDir, "changes", "add-contact-notes", "proposal.md"),
      "utf8",
    );
    expect(proposalThroughChangesLink).toContain("contact-notes-proposal");

    const proposalThroughArchiveLink = await readFile(
      join(projectDir, "archive", "2026-05-01-old-change", "proposal.md"),
      "utf8",
    );
    expect(proposalThroughArchiveLink).toContain("old-change-proposal");

    // Genuinely symlinks, not real directories/copies.
    const changesLinkStat = await lstat(join(projectDir, "changes"));
    expect(changesLinkStat.isSymbolicLink()).toBe(true);
    expect(await realpath(join(projectDir, "changes"))).toBe(
      await realpath(join(root, "openspec", "changes")),
    );
  });

  it("shows specs/ and reviews/ when they exist", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { libraryCommand } = await import("../../src/commands/library.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const root = await trustedRoot();
    const label = basenameOf(repoDir);

    await mkdir(join(root, "openspec", "specs", "billing"), { recursive: true });
    await writeFile(join(root, "openspec", "specs", "billing", "spec.md"), "spec\n", "utf8");
    await mkdir(join(root, "reviews"), { recursive: true });
    await writeFile(join(root, "reviews", "2026-06-01-adversarial-review.md"), "review\n", "utf8");

    await libraryCommand();

    const projectDir = join(libraryRootPath(), label);
    const entries = (await readdir(projectDir)).sort();
    expect(entries).toEqual(["reviews", "specs"]);
  });

  it("excludes a legacy durable store with no recorded Project Identity -- never shown under a guessed name", async () => {
    const { libraryCommand } = await import("../../src/commands/library.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    // The pre-Project-Identity legacy shape: openspec/<project>/<hash>/,
    // with no .identity.yml at all.
    const legacyRoot = join(harnessHomeDir, "openspec", "legacy-project", "abcd1234");
    await mkdir(join(legacyRoot, "openspec", "changes", "archive", "2026-01-01-something"), {
      recursive: true,
    });

    await libraryCommand();

    expect(existsSync(libraryRootPath())).toBe(true);
    const topLevel = await readdir(libraryRootPath());
    expect(topLevel).toEqual([]);
  });

  it("disambiguates two distinct projects that currently resolve to the same label, with a stable, deterministic suffix", async () => {
    const { libraryCommand } = await import("../../src/commands/library.js");
    const { writeIdentityRecord } = await import("../../src/core/projectIdentity.js");
    const { expectedDurableOpenSpecRoot } = await import("../../src/core/openspecId.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const projectIdA = "111111111111";
    const projectIdB = "222222222222";
    await writeIdentityRecord(expectedDurableOpenSpecRoot(projectIdA), {
      projectId: projectIdA,
      createdAt: "2026-01-01T00:00:00.000Z",
      evidence: [{ project: "web", originUrl: null, rootCommit: "a".repeat(40), recordedAt: "2026-01-01T00:00:00.000Z" }],
    });
    await writeIdentityRecord(expectedDurableOpenSpecRoot(projectIdB), {
      projectId: projectIdB,
      createdAt: "2026-01-02T00:00:00.000Z",
      evidence: [{ project: "web", originUrl: null, rootCommit: "b".repeat(40), recordedAt: "2026-01-02T00:00:00.000Z" }],
    });

    await libraryCommand();

    const topLevel = (await readdir(libraryRootPath())).sort();
    expect(topLevel).toEqual([`web-${projectIdA.slice(0, 8)}`, `web-${projectIdB.slice(0, 8)}`]);
    expect(topLevel).not.toContain("web");
  });

  it("rebuilds from scratch every run -- a project that no longer resolves is gone, never left behind stale", async () => {
    const { libraryCommand } = await import("../../src/commands/library.js");
    const { writeIdentityRecord } = await import("../../src/core/projectIdentity.js");
    const { expectedDurableOpenSpecRoot } = await import("../../src/core/openspecId.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await writeIdentityRecord(expectedDurableOpenSpecRoot("aaaaaaaaaaaa"), {
      projectId: "aaaaaaaaaaaa",
      createdAt: "2026-01-01T00:00:00.000Z",
      evidence: [{ project: "temp-project", originUrl: null, rootCommit: "c".repeat(40), recordedAt: "2026-01-01T00:00:00.000Z" }],
    });

    await libraryCommand();
    expect(await readdir(libraryRootPath())).toEqual(["temp-project"]);

    // The identity record is gone (e.g. hand-removed, or -- more
    // realistically -- this run reflects only currently-known
    // projects); the next rebuild must not keep a stale entry around.
    await rm(join(harnessHomeDir, "openspec", "aaaaaaaaaaaa"), { recursive: true, force: true });

    await libraryCommand();
    expect(await readdir(libraryRootPath())).toEqual([]);
  });

  it("never modifies the real durable store -- rebuilding the library twice leaves the underlying content untouched", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { libraryCommand } = await import("../../src/commands/library.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    const root = await trustedRoot();
    await mkdir(join(root, "openspec", "changes", "add-contact-notes"), { recursive: true });
    await writeFile(
      join(root, "openspec", "changes", "add-contact-notes", "proposal.md"),
      "original content\n",
      "utf8",
    );

    await libraryCommand();
    await libraryCommand();

    const content = await readFile(
      join(root, "openspec", "changes", "add-contact-notes", "proposal.md"),
      "utf8",
    );
    expect(content).toBe("original content\n");
  });

  it("creates (and opens) an empty library root when no project is known yet", async () => {
    const { libraryCommand } = await import("../../src/commands/library.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await libraryCommand();

    expect(existsSync(libraryRootPath())).toBe(true);
    expect(await readdir(libraryRootPath())).toEqual([]);
    const recorded = JSON.parse(await readFile(fakeEditor.outputFile, "utf8"));
    expect(recorded.argv).toEqual([libraryRootPath()]);
  });

  it("prints how many projects were rebuilt", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { libraryCommand } = await import("../../src/commands/library.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });
    logSpy.mockClear();
    await libraryCommand();

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Library rebuilt: 1 project\(s\)\./);
  });

  it("reports zero projects clearly when none are known", async () => {
    const { libraryCommand } = await import("../../src/commands/library.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await libraryCommand();

    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toMatch(/Library rebuilt: no known projects yet\./);
  });
});

function basenameOf(path: string): string {
  return (path.split("/").filter(Boolean).at(-1) as string).toLowerCase();
}
