import { describe, expect, it } from "vitest";
import { deriveProjectName, sanitizeIssue } from "../../src/core/sanitize.js";
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
