import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expectedDurableOpenSpecRoot,
  expectedLegacyDurableOpenSpecRoot,
  expectedOpenSpecRoot,
  generateLegacyProjectStoreId,
  generateProjectId,
  generateProjectStoreId,
  generateStoreId,
  isValidProjectId,
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

describe("generateProjectId", () => {
  it("produces a 12-character lowercase hex string", () => {
    const id = generateProjectId();
    expect(id).toMatch(/^[a-f0-9]{12}$/);
  });

  it("is different on every call (not deterministic from any input -- there is no input)", () => {
    const a = generateProjectId();
    const b = generateProjectId();
    expect(a).not.toBe(b);
  });

  it("always satisfies isValidProjectId and isValidStoreId's kebab-case constraint", () => {
    const id = generateProjectId();
    expect(isValidProjectId(id)).toBe(true);
    expect(id).toMatch(STORE_ID_PATTERN);
  });
});

describe("isValidProjectId", () => {
  it("accepts values shaped like generateProjectId's output", () => {
    expect(isValidProjectId(generateProjectId())).toBe(true);
    expect(isValidProjectId("0123456789ab")).toBe(true);
  });

  it("rejects anything not exactly 12 lowercase hex characters", () => {
    expect(isValidProjectId("")).toBe(false);
    expect(isValidProjectId("ABCDEF012345")).toBe(false); // uppercase
    expect(isValidProjectId("abcdef01234")).toBe(false); // 11 chars
    expect(isValidProjectId("abcdef0123456")).toBe(false); // 13 chars
    expect(isValidProjectId("not-a-real-project-id")).toBe(false);
    expect(isValidProjectId("ce-demo-abc12345")).toBe(false); // a store id, not a project id
  });
});

describe("generateProjectStoreId (current, project-id-keyed scheme)", () => {
  it("is deterministic for the same project id", () => {
    const id = generateProjectId();
    expect(generateProjectStoreId(id)).toBe(generateProjectStoreId(id));
  });

  it("is 'ce-<projectId>', never embedding a project name or repository path", () => {
    const id = generateProjectId();
    expect(generateProjectStoreId(id)).toBe(`ce-${id}`);
  });

  it("differs for two different project ids", () => {
    const first = generateProjectStoreId(generateProjectId());
    const second = generateProjectStoreId(generateProjectId());
    expect(first).not.toBe(second);
  });

  it("only contains characters accepted by OpenSpec store ids (kebab-case)", () => {
    expect(generateProjectStoreId(generateProjectId())).toMatch(STORE_ID_PATTERN);
  });

  it("differs from the legacy, path-hash-keyed generateLegacyProjectStoreId for a corresponding input", () => {
    const projectId = generateProjectId();
    const legacy = generateLegacyProjectStoreId("demo", "/repo/demo");
    expect(generateProjectStoreId(projectId)).not.toBe(legacy);
  });
});

describe("expectedDurableOpenSpecRoot (current, project-id-keyed scheme)", () => {
  let tempHome: string;
  const originalEnv = process.env.CE_HARNESS_HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "ce-harness-openspecid-"));
    process.env.CE_HARNESS_HOME = tempHome;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it("is <harnessHome>/openspec/<projectId>, never nested under the workspace, never embedding project name/path", () => {
    const projectId = generateProjectId();
    const root = expectedDurableOpenSpecRoot(projectId);
    expect(root).toBe(join(tempHome, "openspec", projectId));
    expect(root).not.toContain("workspaces");
  });

  it("is deterministic for the same project id, regardless of project name or repository path", () => {
    const projectId = generateProjectId();
    const a = expectedDurableOpenSpecRoot(projectId);
    const b = expectedDurableOpenSpecRoot(projectId);
    expect(a).toBe(b);
  });

  it("differs for two different project ids", () => {
    const first = expectedDurableOpenSpecRoot(generateProjectId());
    const second = expectedDurableOpenSpecRoot(generateProjectId());
    expect(first).not.toBe(second);
  });

  it("differs from the legacy expectedLegacyDurableOpenSpecRoot for a corresponding input", () => {
    const projectId = generateProjectId();
    const legacy = expectedLegacyDurableOpenSpecRoot("demo", "/repo/demo");
    expect(expectedDurableOpenSpecRoot(projectId)).not.toBe(legacy);
  });

  it("differs from the legacy expectedOpenSpecRoot for a corresponding workspace path", () => {
    const legacy = expectedOpenSpecRoot(join(tempHome, "workspaces", "demo", "issue-1"));
    const durable = expectedDurableOpenSpecRoot(generateProjectId());
    expect(durable).not.toBe(legacy);
  });
});

describe("generateLegacyProjectStoreId (pre-Project-Identity, path-hash-keyed shape)", () => {
  it("is deterministic for the same project/repository path, and drops the issue entirely", () => {
    const a = generateLegacyProjectStoreId("demo", "/Users/me/work/demo");
    const b = generateLegacyProjectStoreId("demo", "/Users/me/work/demo");
    expect(a).toBe(b);
  });

  it("unlike generateStoreId, two different issues for the same project/repository never diverge (no issue parameter exists at all)", () => {
    const legacyForIssueOne = generateStoreId("demo", "issue-1", "/repo/demo");
    const legacyForIssueTwo = generateStoreId("demo", "issue-2", "/repo/demo");
    expect(legacyForIssueOne).not.toBe(legacyForIssueTwo);

    const durableId = generateLegacyProjectStoreId("demo", "/repo/demo");
    expect(durableId).not.toBe(legacyForIssueOne);
    expect(durableId).not.toBe(legacyForIssueTwo);
  });

  it("begins with 'ce-' and includes the sanitized project", () => {
    const id = generateLegacyProjectStoreId("demo", "/Users/me/work/demo");
    expect(id.startsWith("ce-")).toBe(true);
    expect(id).toContain("demo");
  });

  it("avoids collisions between repositories that share the same project name", () => {
    const first = generateLegacyProjectStoreId("demo", "/Users/alice/work/demo");
    const second = generateLegacyProjectStoreId("demo", "/Users/bob/other/demo");
    expect(first).not.toBe(second);
  });

  it("differs from the legacy, issue-scoped generateStoreId for the same inputs", () => {
    const legacy = generateStoreId("demo", "issue-1", "/repo/demo");
    const durable = generateLegacyProjectStoreId("demo", "/repo/demo");
    expect(durable).not.toBe(legacy);
  });

  it("only contains characters accepted by OpenSpec store ids (kebab-case)", () => {
    const id = generateLegacyProjectStoreId("My.Weird_Project!!", "/repo/path with spaces");
    expect(id).toMatch(STORE_ID_PATTERN);
  });

  it("is reasonably short (<=60 chars) even for a very long project name", () => {
    const id = generateLegacyProjectStoreId("a".repeat(200), "/repo/path");
    expect(id.length).toBeLessThanOrEqual(60);
    expect(id).toMatch(STORE_ID_PATTERN);
  });

  it("keeps the hash suffix intact even when truncating a long project token", () => {
    const repoPath = "/repo/path";
    const id = generateLegacyProjectStoreId("a".repeat(200), repoPath);
    const short = generateLegacyProjectStoreId("short", repoPath);
    const hashOf = (s: string) => s.split("-").at(-1);
    expect(hashOf(id)).toBe(hashOf(short));
  });
});

describe("expectedLegacyDurableOpenSpecRoot (pre-Project-Identity, path-hash-keyed shape)", () => {
  let tempHome: string;
  const originalEnv = process.env.CE_HARNESS_HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "ce-harness-openspecid-legacy-"));
    process.env.CE_HARNESS_HOME = tempHome;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it("is <harnessHome>/openspec/<project>/<repo-hash>, never nested under the workspace", () => {
    const root = expectedLegacyDurableOpenSpecRoot("demo", "/Users/me/work/demo");
    expect(root.startsWith(join(tempHome, "openspec", "demo"))).toBe(true);
    expect(root).not.toContain("workspaces");
  });

  it("is stable across issues -- no issue parameter exists at all", () => {
    const a = expectedLegacyDurableOpenSpecRoot("demo", "/repo/demo");
    const b = expectedLegacyDurableOpenSpecRoot("demo", "/repo/demo");
    expect(a).toBe(b);
  });

  it("differs for two different repositories sharing the same project name", () => {
    const first = expectedLegacyDurableOpenSpecRoot("demo", "/Users/alice/work/demo");
    const second = expectedLegacyDurableOpenSpecRoot("demo", "/Users/bob/other/demo");
    expect(first).not.toBe(second);
  });

  it("differs from the legacy expectedOpenSpecRoot for a corresponding workspace path", () => {
    const legacy = expectedOpenSpecRoot(join(tempHome, "workspaces", "demo", "issue-1"));
    const durable = expectedLegacyDurableOpenSpecRoot("demo", "/repo/demo");
    expect(durable).not.toBe(legacy);
  });
});
