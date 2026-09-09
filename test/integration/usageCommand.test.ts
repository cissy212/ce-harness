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
import { claudeCodeProjectDirName } from "../../src/core/claudeCodeUsage.js";

async function writeFixtureFile(root: string, relPath: string, content: string): Promise<void> {
  const full = join(root, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

describe("ce usage (integration)", () => {
  let harnessHomeDir: string;
  let claudeHomeDir: string;
  let repoDir: string;
  let fakeOpenSpec: FakeOpenSpecEnv;
  let fakeOpenCode: FakeOpenCodeEnv;
  const originalHarnessHome = process.env.CE_HARNESS_HOME;
  const originalClaudeHome = process.env.CE_CLAUDE_HOME;

  beforeEach(async () => {
    harnessHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-home-"));
    claudeHomeDir = await mkdtemp(join(tmpdir(), "ce-harness-claude-home-"));
    process.env.CE_HARNESS_HOME = harnessHomeDir;
    process.env.CE_CLAUDE_HOME = claudeHomeDir;
    repoDir = await createTempRepo();
    fakeOpenSpec = await setupFakeOpenSpec();
    fakeOpenCode = await setupFakeOpenCode();
    process.env.CE_CODEGRAPH_BIN = nonExistentCodeGraphBin();
    process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHarnessHome === undefined) delete process.env.CE_HARNESS_HOME;
    else process.env.CE_HARNESS_HOME = originalHarnessHome;
    if (originalClaudeHome === undefined) delete process.env.CE_CLAUDE_HOME;
    else process.env.CE_CLAUDE_HOME = originalClaudeHome;
    await teardownFakeOpenSpec(fakeOpenSpec);
    await teardownFakeOpenCode(fakeOpenCode);
    delete process.env.CE_CODEGRAPH_BIN;
    delete process.env.CE_OSASCRIPT_BIN;
    await rm(harnessHomeDir, { recursive: true, force: true });
    await rm(claudeHomeDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("reports no local session data and no reports for a brand-new workspace", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { usageCommand } = await import("../../src/commands/usage.js");

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await usageCommand({});

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Usage summary: ");
    expect(output).toContain("none found for this workspace");
    expect(output).toContain("no /verify or /adversarial-review reports written yet");
  });

  it("aggregates real token usage by attributionSkill and surfaces a written verify report's verdict/lenses/warnings", async () => {
    const { startCommand } = await import("../../src/commands/start.js");
    const { usageCommand } = await import("../../src/commands/usage.js");
    const { readActivePointer, readWorkspace, resolveTrustedOpenSpec } = await import(
      "../../src/core/workspace.js"
    );
    const { resolveActiveChangesForWorkspace, activeChangeRoot } = await import("../../src/core/activeChange.js");

    await startCommand({ repo: repoDir, issue: "issue-1" });

    const pointer = await readActivePointer();
    const workspace = await readWorkspace(pointer!.project, pointer!.sanitizedIssue);
    const trusted = resolveTrustedOpenSpec(workspace)!;

    // A change with a written /verify report, exactly matching how
    // /verify's own Step 9 report structure lays this out.
    await writeFixtureFile(
      trusted.root,
      "openspec/changes/add-widgets/proposal.md",
      "# Add widgets\n",
    );
    const activeChanges = await resolveActiveChangesForWorkspace(trusted.root, workspace.project, workspace.issue);
    expect(activeChanges).toEqual(["add-widgets"]);
    const changeRoot = activeChangeRoot(trusted.root, "add-widgets");
    await writeFixtureFile(
      changeRoot,
      "reports/2026-01-02-verify.md",
      [
        "# Verification Report: add-widgets",
        "",
        "**Lenses applied:** frontend-developer",
        "",
        "## Commands Executed and Outcomes",
        "",
        "- `npm run build` (scope: `.`): PASS",
        "  - Warnings: a deprecation warning",
        "",
        "## Overall Verdict",
        "",
        "**Verdict:** PASS",
        "",
      ].join("\n"),
    );

    // Real-shaped Claude Code session data for this exact worktree path.
    const projectDirName = claudeCodeProjectDirName(workspace.worktreePath);
    const projectDir = join(claudeHomeDir, "projects", projectDirName);
    await mkdir(projectDir, { recursive: true });
    const afterCreated = new Date(Date.parse(workspace.createdAt) + 60_000).toISOString();
    await writeFile(
      join(projectDir, "session-1.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          timestamp: afterCreated,
          attributionSkill: "verify",
          message: {
            role: "assistant",
            usage: { input_tokens: 3, output_tokens: 456, cache_read_input_tokens: 7000 },
          },
        }),
        JSON.stringify({
          type: "cost-state",
          sessionId: "session-1",
          totalCostUSD: 1.23,
          startTime: Date.parse(afterCreated),
        }),
      ].join("\n"),
      "utf8",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await usageCommand({});

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("1 session(s)");
    expect(output).toMatch(/verify\s+input\s+3\s+output\s+456/);
    expect(output).toContain("$1.23 across 1 session(s)");
    expect(output).toContain("add-widgets:");
    expect(output).toContain("2026-01-02-verify.md  verdict PASS  lenses: frontend-developer, warnings recorded: 1");
  });

  it("throws a clear CeError for an explicit workspace selector that doesn't exist", async () => {
    const { usageCommand } = await import("../../src/commands/usage.js");
    await expect(usageCommand({ workspace: "no-such-project/1" })).rejects.toThrow(/No workspace found/);
  });
});
