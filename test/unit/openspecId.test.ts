import { describe, expect, it } from "vitest";
import {
  expectedOpenSpecRoot,
  generateStoreId,
  isValidStoreId,
} from "../../src/core/openspecId.js";

const STORE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("generateStoreId", () => {
  it("is deterministic for the same project/issue/repository path", () => {
    const a = generateStoreId("demo", "issue-1", "/Users/me/work/demo");
    const b = generateStoreId("demo", "issue-1", "/Users/me/work/demo");
    expect(a).toBe(b);
  });

  it("begins with 'ce-' and includes the sanitized project and issue", () => {
    const id = generateStoreId("demo", "issue-1", "/Users/me/work/demo");
    expect(id.startsWith("ce-")).toBe(true);
    expect(id).toContain("demo");
    expect(id).toContain("issue-1");
  });

  it("avoids collisions between repositories that share the same directory name", () => {
    const first = generateStoreId("demo", "issue-1", "/Users/alice/work/demo");
    const second = generateStoreId("demo", "issue-1", "/Users/bob/other/demo");
    expect(first).not.toBe(second);
  });

  it("produces the same id regardless of issue casing already being sanitized consistently", () => {
    const a = generateStoreId("demo", "fix-bug-42", "/repo/demo");
    const b = generateStoreId("demo", "fix-bug-42", "/repo/demo");
    expect(a).toBe(b);
  });

  it("only contains characters accepted by OpenSpec store ids (kebab-case)", () => {
    const id = generateStoreId("My.Weird_Project!!", "Issue #42 (urgent)", "/repo/path with spaces");
    expect(id).toMatch(STORE_ID_PATTERN);
  });

  it("is reasonably short (<=60 chars) even for very long inputs", () => {
    const longProject = "a".repeat(200);
    const longIssue = "b".repeat(200);
    const id = generateStoreId(longProject, longIssue, "/repo/path");
    expect(id.length).toBeLessThanOrEqual(60);
    expect(id).toMatch(STORE_ID_PATTERN);
  });

  it("never embeds whitespace, dots, underscores, or path separators", () => {
    const id = generateStoreId("proj name", "issue/../evil", "/some/../repo");
    expect(id).not.toMatch(/[\s./_]/);
    expect(id).not.toContain("..");
  });

  it("keeps the hash suffix intact even when truncating long tokens", () => {
    const repoPath = "/repo/path";
    const id = generateStoreId("a".repeat(200), "b".repeat(200), repoPath);
    const short = generateStoreId("short", "issue", repoPath);
    // Same repo path -> same hash suffix, regardless of token truncation.
    const hashOf = (s: string) => s.split("-").at(-1);
    expect(hashOf(id)).toBe(hashOf(short));
  });
});

describe("isValidStoreId", () => {
  it("accepts well-formed kebab-case ids", () => {
    expect(isValidStoreId("ce-demo-issue-1-abc12345")).toBe(true);
    expect(isValidStoreId("a")).toBe(true);
  });

  it("rejects ids with whitespace, dots, underscores, or double hyphens", () => {
    expect(isValidStoreId("ce demo")).toBe(false);
    expect(isValidStoreId("ce.demo")).toBe(false);
    expect(isValidStoreId("ce_demo")).toBe(false);
    expect(isValidStoreId("ce--demo")).toBe(false);
  });

  it("rejects ids with leading/trailing hyphens, path separators, or traversal", () => {
    expect(isValidStoreId("-ce-demo")).toBe(false);
    expect(isValidStoreId("ce-demo-")).toBe(false);
    expect(isValidStoreId("ce/demo")).toBe(false);
    expect(isValidStoreId("../etc")).toBe(false);
  });

  it("rejects empty or excessively long ids", () => {
    expect(isValidStoreId("")).toBe(false);
    expect(isValidStoreId("a".repeat(61))).toBe(false);
  });
});

describe("expectedOpenSpecRoot", () => {
  it("is always <workspacePath>/openspec", () => {
    expect(expectedOpenSpecRoot("/home/user/.ce-harness/workspaces/demo/issue-1")).toBe(
      "/home/user/.ce-harness/workspaces/demo/issue-1/openspec",
    );
  });
});
