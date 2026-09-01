import { describe, expect, it } from "vitest";
import { deriveProjectName, parseWorkspaceSelector, sanitizeIssue } from "../../src/core/sanitize.js";
import { CeError } from "../../src/core/errors.js";

describe("sanitizeIssue", () => {
  it("lowercases and keeps simple alphanumeric issue ids unchanged", () => {
    expect(sanitizeIssue("ISSUE-123")).toBe("issue-123");
  });

  it("replaces disallowed characters with dashes", () => {
    expect(sanitizeIssue("Fix bug #42 (urgent!)")).toBe("fix-bug-42-urgent");
  });

  it("collapses repeated dashes", () => {
    expect(sanitizeIssue("a---b")).toBe("a-b");
  });

  it("strips leading and trailing dashes and dots", () => {
    expect(sanitizeIssue("--.foo.--")).toBe("foo");
  });

  it("neutralizes path traversal sequences", () => {
    expect(sanitizeIssue("../../etc/passwd")).not.toContain("..");
  });

  it("does not produce a leading slash or path separators", () => {
    const result = sanitizeIssue("foo/bar/../baz");
    expect(result).not.toContain("/");
  });

  it("throws for empty input", () => {
    expect(() => sanitizeIssue("   ")).toThrow(CeError);
  });

  it("throws when nothing usable remains after sanitization", () => {
    expect(() => sanitizeIssue("###")).toThrow(CeError);
  });

  it("caps length at 100 characters", () => {
    const long = "a".repeat(500);
    expect(sanitizeIssue(long).length).toBe(100);
  });
});

describe("deriveProjectName", () => {
  it("derives the sanitized basename from a repo root path", () => {
    expect(deriveProjectName("/Users/me/Work/My Repo")).toBe("my-repo");
  });

  it("handles trailing slash-free paths", () => {
    expect(deriveProjectName("/tmp/some-project")).toBe("some-project");
  });
});

describe("parseWorkspaceSelector", () => {
  it("splits <project>/<issue> into its two parts", () => {
    expect(parseWorkspaceSelector("market-audit-tool/130")).toEqual({
      project: "market-audit-tool",
      sanitizedIssue: "130",
    });
  });

  it("sanitizes the issue half the same way ce start does, so a hand-typed selector still resolves", () => {
    expect(parseWorkspaceSelector("market-audit-tool/Fix Bug #42")).toEqual({
      project: "market-audit-tool",
      sanitizedIssue: "fix-bug-42",
    });
  });

  it("matches the project half exactly, never re-sanitizing it", () => {
    // A project segment with characters toSafeSegment would normally
    // strip (e.g. uppercase) is passed through as-is -- it's expected to
    // already match what `ce status` displays, not be re-derived here.
    expect(parseWorkspaceSelector("My Project/130")).toEqual({
      project: "My Project",
      sanitizedIssue: "130",
    });
  });

  it("uses only the first slash as the separator, so an issue containing a slash survives (then gets sanitized)", () => {
    expect(parseWorkspaceSelector("market-audit-tool/feature/foo")).toEqual({
      project: "market-audit-tool",
      sanitizedIssue: "feature-foo",
    });
  });

  it("throws a CeError with no slash at all", () => {
    expect(() => parseWorkspaceSelector("market-audit-tool")).toThrow(CeError);
  });

  it("throws a CeError for an empty project or issue half", () => {
    expect(() => parseWorkspaceSelector("/130")).toThrow(CeError);
    expect(() => parseWorkspaceSelector("market-audit-tool/")).toThrow(CeError);
    expect(() => parseWorkspaceSelector("  /  ")).toThrow(CeError);
  });

  it("trims surrounding whitespace from both halves", () => {
    expect(parseWorkspaceSelector("  market-audit-tool / 130  ")).toEqual({
      project: "market-audit-tool",
      sanitizedIssue: "130",
    });
  });
});
