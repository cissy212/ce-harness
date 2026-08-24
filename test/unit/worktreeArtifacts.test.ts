import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filterHarnessManagedChanges } from "../../src/core/worktreeArtifacts.js";

const worktreePath = "/tmp/demo-worktree";

function workspaceWithCodeGraph(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    project: "demo",
    repositoryPath: "/tmp/demo-repo",
    issue: "issue-1",
    sanitizedIssue: "issue-1",
    baseBranch: "main",
    internalBranch: "ce-harness/issue-1",
    worktreePath,
    workspacePath: "/tmp/demo-workspace",
    createdAt: new Date().toISOString(),
    codeGraph: {
      available: true,
      managedByHarness: true,
      indexPath: join(worktreePath, ".codegraph"),
      initializedAt: new Date().toISOString(),
    },
    ...overrides,
  } as never;
}

describe("filterHarnessManagedChanges", () => {
  it("excludes every porcelain line under a trusted, harness-managed .codegraph directory", () => {
    const workspace = workspaceWithCodeGraph();
    const changes = [
      "?? .codegraph/codegraph.db",
      "?? .codegraph/meta/info.json",
      " M src/index.ts",
    ];

    const result = filterHarnessManagedChanges(changes, workspace);

    expect(result).toEqual([" M src/index.ts"]);
  });

  it("returns changes unmodified when there is no codeGraph metadata at all", () => {
    const workspace = workspaceWithCodeGraph({ codeGraph: undefined });
    const changes = ["?? .codegraph/codegraph.db", " M src/index.ts"];

    expect(filterHarnessManagedChanges(changes, workspace)).toEqual(changes);
  });

  it("never excludes anything when CodeGraph is not managed by ce-harness (pre-existing index case)", () => {
    const workspace = workspaceWithCodeGraph({
      codeGraph: {
        available: false,
        managedByHarness: false,
        reason: 'A ".codegraph" directory already exists in this worktree.',
      },
    });
    const changes = ["?? .codegraph/codegraph.db", " M src/index.ts"];

    expect(filterHarnessManagedChanges(changes, workspace)).toEqual(changes);
  });

  it("never excludes anything when the persisted indexPath does not match the recomputed one (tampered metadata)", () => {
    const workspace = workspaceWithCodeGraph({
      codeGraph: {
        available: true,
        managedByHarness: true,
        indexPath: "/some/other/path/.codegraph",
        initializedAt: new Date().toISOString(),
      },
    });
    const changes = ["?? .codegraph/codegraph.db", " M src/index.ts"];

    // Nothing is excluded -- the mismatch means this can't be trusted, so
    // every entry (including the .codegraph one) is treated as a real change.
    expect(filterHarnessManagedChanges(changes, workspace)).toEqual(changes);
  });

  it("never hides an unrelated file that merely shares a name prefix (e.g. .codegraph-backup)", () => {
    const workspace = workspaceWithCodeGraph();
    const changes = ["?? .codegraph-backup/notes.txt", " M src/index.ts"];

    expect(filterHarnessManagedChanges(changes, workspace)).toEqual(changes);
  });

  it("still counts a real tracked-file modification as significant even when .codegraph/ is present and managed", () => {
    const workspace = workspaceWithCodeGraph();
    const changes = ["?? .codegraph/codegraph.db", " M README.md"];

    const result = filterHarnessManagedChanges(changes, workspace);

    expect(result).toEqual([" M README.md"]);
  });

  it("handles a rename porcelain line by matching against the new path", () => {
    const workspace = workspaceWithCodeGraph();
    const changes = ['R  .codegraph/old.db -> .codegraph/new.db'];

    expect(filterHarnessManagedChanges(changes, workspace)).toEqual([]);
  });

  describe("runner-managed worktree artifacts (e.g. Claude Code's .claude//.mcp.json)", () => {
    function claudeWorkspace(overrides: Partial<Record<string, unknown>> = {}) {
      return workspaceWithCodeGraph({ codeGraph: undefined, runner: "claude", ...overrides });
    }

    it("excludes .claude when the selected runner reports it as managed", () => {
      const workspace = claudeWorkspace({
        runnerWorktreeArtifacts: { commandsManaged: true },
      });
      const changes = ["?? .claude/commands/workspace.md", " M src/index.ts"];

      expect(filterHarnessManagedChanges(changes, workspace)).toEqual([" M src/index.ts"]);
    });

    it("excludes .mcp.json when the selected runner reports it as managed", () => {
      const workspace = claudeWorkspace({
        runnerWorktreeArtifacts: { commandsManaged: true, mcpManaged: true },
      });
      const changes = ["?? .claude/commands/workspace.md", "?? .mcp.json", " M src/index.ts"];

      expect(filterHarnessManagedChanges(changes, workspace)).toEqual([" M src/index.ts"]);
    });

    it('never excludes .claude when commandsManaged is false -- e.g. a pre-existing, untracked ".claude/" ce-harness safely skipped rather than wrote', () => {
      const workspace = claudeWorkspace({
        runnerWorktreeArtifacts: { commandsManaged: false },
      });
      const changes = ["?? .claude/settings.local.json", " M src/index.ts"];

      // Nothing about this path is harness-owned, so it counts as a real
      // change like any other -- exactly the property that prevents
      // ce-harness from ever silently discarding it on `ce cleanup`.
      expect(filterHarnessManagedChanges(changes, workspace)).toEqual(changes);
    });

    it('never excludes .mcp.json when mcpManaged is false/absent -- a pre-existing, untracked ".mcp.json" is treated as a real change', () => {
      const workspace = claudeWorkspace({
        runnerWorktreeArtifacts: { commandsManaged: true },
      });
      const changes = ["?? .mcp.json", " M src/index.ts"];

      expect(filterHarnessManagedChanges(changes, workspace)).toEqual(changes);
    });

    it("never excludes anything when runnerWorktreeArtifacts is absent entirely (legacy workspace, or nothing was ever written)", () => {
      const workspace = claudeWorkspace();
      const changes = ["?? .claude/commands/workspace.md", " M src/index.ts"];

      expect(filterHarnessManagedChanges(changes, workspace)).toEqual(changes);
    });

    describe("per-item array form (current writeConfig contract)", () => {
      it("excludes only the specific commands/skills the array names, not the whole .claude directory", () => {
        const workspace = claudeWorkspace({
          runnerWorktreeArtifacts: {
            commandsManaged: ["commands/adversarial-review.md", "skills/openspec-sync-specs"],
          },
        });
        const changes = [
          "?? .claude/commands/adversarial-review.md",
          "?? .claude/skills/openspec-sync-specs/SKILL.md",
          " M src/index.ts",
        ];

        expect(filterHarnessManagedChanges(changes, workspace)).toEqual([" M src/index.ts"]);
      });

      it("the Oz scenario: excludes the ce-harness-written skill but never the unrelated, repository-owned setup-service-infra skill", () => {
        const workspace = claudeWorkspace({
          runnerWorktreeArtifacts: {
            commandsManaged: ["commands/adversarial-review.md", "skills/openspec-sync-specs"],
          },
        });
        // setup-service-infra is tracked and unmodified in the real
        // scenario (so it would never appear in porcelain output at
        // all) -- modeled here as an untracked sibling to prove the
        // filter itself, not git's own tracked/untracked distinction,
        // is what keeps it out of the exclusion.
        const changes = [
          "?? .claude/commands/adversarial-review.md",
          "?? .claude/skills/openspec-sync-specs/SKILL.md",
          "?? .claude/skills/setup-service-infra/SKILL.md",
          " M src/index.ts",
        ];

        expect(filterHarnessManagedChanges(changes, workspace)).toEqual([
          "?? .claude/skills/setup-service-infra/SKILL.md",
          " M src/index.ts",
        ]);
      });

      it("returns changes unmodified when the array is empty -- every template collided", () => {
        const workspace = claudeWorkspace({ runnerWorktreeArtifacts: { commandsManaged: [] } });
        const changes = ["?? .claude/skills/setup-service-infra/SKILL.md", " M src/index.ts"];

        expect(filterHarnessManagedChanges(changes, workspace)).toEqual(changes);
      });
    });

    it('never excludes ".claude" for an OpenCode workspace, even if runnerWorktreeArtifacts is somehow present', () => {
      const workspace = workspaceWithCodeGraph({
        codeGraph: undefined,
        runner: "opencode",
        runnerWorktreeArtifacts: { commandsManaged: true, mcpManaged: true },
      });
      const changes = ["?? .claude/commands/workspace.md", "?? .mcp.json", " M src/index.ts"];

      // OpenCode never writes anything inside the worktree, regardless of
      // what a (tampered or stale) runnerWorktreeArtifacts block claims.
      expect(filterHarnessManagedChanges(changes, workspace)).toEqual(changes);
    });
  });
});
