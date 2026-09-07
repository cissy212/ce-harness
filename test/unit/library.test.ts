import { describe, expect, it } from "vitest";
import { resolveLibraryEntries } from "../../src/core/library.js";
import type { KnownProject } from "../../src/core/knownProjects.js";

function project(overrides: Partial<KnownProject> & Pick<KnownProject, "projectId" | "label">): KnownProject {
  return { durableRoot: `/durable/${overrides.projectId}`, ...overrides };
}

describe("resolveLibraryEntries", () => {
  it("uses the plain label with no suffix when it's unique", () => {
    const entries = resolveLibraryEntries([
      project({ projectId: "aaaaaaaaaaaa", label: "market-audit-tool" }),
      project({ projectId: "bbbbbbbbbbbb", label: "oz" }),
    ]);

    expect(entries.map((e) => e.directoryName).sort()).toEqual(["market-audit-tool", "oz"]);
  });

  it("disambiguates every member of a colliding label, never just the second one seen", () => {
    const entries = resolveLibraryEntries([
      project({ projectId: "111111111111", label: "web" }),
      project({ projectId: "222222222222", label: "web" }),
    ]);

    const names = entries.map((e) => e.directoryName).sort();
    expect(names).toEqual(["web-11111111", "web-22222222"]);
    // Neither collides with a plain "web" -- both are suffixed.
    expect(names).not.toContain("web");
  });

  it("suffixes are derived from each project's own id, so the mapping is stable across rebuilds regardless of input order", () => {
    const a = resolveLibraryEntries([
      project({ projectId: "111111111111", label: "web" }),
      project({ projectId: "222222222222", label: "web" }),
    ]);
    const b = resolveLibraryEntries([
      project({ projectId: "222222222222", label: "web" }),
      project({ projectId: "111111111111", label: "web" }),
    ]);

    const byId = (entries: typeof a) => new Map(entries.map((e) => [e.projectId, e.directoryName]));
    expect(byId(a)).toEqual(byId(b));
  });

  it("a three-way collision disambiguates every one of the three", () => {
    const entries = resolveLibraryEntries([
      project({ projectId: "111111111111", label: "web" }),
      project({ projectId: "222222222222", label: "web" }),
      project({ projectId: "333333333333", label: "web" }),
    ]);

    const names = new Set(entries.map((e) => e.directoryName));
    expect(names.size).toBe(3);
    for (const name of names) {
      expect(name).toMatch(/^web-[0-9a-f]{8}$/);
    }
  });

  it("does not disambiguate a project whose label doesn't collide, even when other labels do", () => {
    const entries = resolveLibraryEntries([
      project({ projectId: "111111111111", label: "web" }),
      project({ projectId: "222222222222", label: "web" }),
      project({ projectId: "333333333333", label: "market-audit-tool" }),
    ]);

    const marketAuditTool = entries.find((e) => e.projectId === "333333333333")!;
    expect(marketAuditTool.directoryName).toBe("market-audit-tool");
  });

  it("returns entries sorted by directory name", () => {
    const entries = resolveLibraryEntries([
      project({ projectId: "aaaaaaaaaaaa", label: "zeta" }),
      project({ projectId: "bbbbbbbbbbbb", label: "alpha" }),
    ]);

    expect(entries.map((e) => e.directoryName)).toEqual(["alpha", "zeta"]);
  });

  it("returns an empty list for no known projects", () => {
    expect(resolveLibraryEntries([])).toEqual([]);
  });
});
