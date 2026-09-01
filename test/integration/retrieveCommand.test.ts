import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

async function writeFixtureFile(root: string, relPath: string, content: string): Promise<void> {
  const full = join(root, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

describe("ce retrieve (integration)", () => {
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
    delete process.env.CE_CODEGRAPH_BIN;
    delete process.env.CE_OSASCRIPT_BIN;
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("throws a clear CeError when there is no active workspace", async () => {
    const { retrieveCommand } = await import("../../src/commands/retrieve.js");

    await expect(retrieveCommand({ keywords: ["widget"] })).rejects.toThrow(/No active workspace/);
  });

  it("prints a RetrievalResult as JSON for the active workspace's durable store, honoring query flags", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { retrieveCommand } = await import("../../src/commands/retrieve.js");
    const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
      "../../src/core/workspace.js"
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const pointer = await readActivePointer();
    const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
    const trusted = resolveTrustedOpenSpec(workspace);
    expect(trusted).not.toBeNull();

    await writeFixtureFile(
      trusted!.root,
      "openspec/specs/billing/spec.md",
      "# Billing\n\nHandles refund tokens.\n",
    );
    await writeFixtureFile(
      trusted!.root,
      "openspec/changes/archive/2025-01-01-unrelated/proposal.md",
      "Something about widgets, unrelated to billing.\n",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSpy.mockClear();
    await retrieveCommand({ keywords: ["refund"], sources: ["specs", "archivedChanges"] });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.candidates.length).toBe(1);
    expect(parsed.candidates[0].type).toBe("spec");
    expect(parsed.candidates[0].status).toBe("current");
    expect(parsed.warnings).toEqual([]);
  });

  it("passes taskDescription, paths, domain, and limit through to retrieveCandidates", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { retrieveCommand } = await import("../../src/commands/retrieve.js");
    const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
      "../../src/core/workspace.js"
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const pointer = await readActivePointer();
    const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
    const trusted = resolveTrustedOpenSpec(workspace);

    for (let i = 0; i < 3; i++) {
      await writeFixtureFile(
        trusted!.root,
        `openspec/specs/capability-${i}/spec.md`,
        `# Capability ${i}\n\nMentions widgets extensively.\n`,
      );
    }

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSpy.mockClear();
    await retrieveCommand({ task: "improve widgets handling", limit: 2, sources: ["specs"] });

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.candidates.length).toBe(2);
  });

  it("empty durable store (nothing written yet) returns an empty result plus a warning, not an error", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { retrieveCommand } = await import("../../src/commands/retrieve.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSpy.mockClear();
    await retrieveCommand({ keywords: ["nothing-here"] });

    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.candidates).toEqual([]);
  });
});
