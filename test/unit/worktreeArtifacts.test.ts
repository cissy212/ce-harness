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
});
