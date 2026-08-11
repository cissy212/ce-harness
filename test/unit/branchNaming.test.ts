import { rm } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempRepo } from "../helpers/tempRepo.js";
import { CeError } from "../../src/core/errors.js";
import {
  BRANCH_PATTERN_CONFIG_KEY,
  DEFAULT_BRANCH_PATTERN,
  renderBranchName,
  resolveBranchPattern,
} from "../../src/core/branchNaming.js";

describe("branch naming (configurable per repository via Git config)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  describe("resolveBranchPattern", () => {
    it('defaults to "ce-harness/{issue}" when nothing is configured', async () => {
      expect(await resolveBranchPattern(repoDir)).toBe("ce-harness/{issue}");
      expect(await resolveBranchPattern(repoDir)).toBe(DEFAULT_BRANCH_PATTERN);
    });

    it("uses the repository's local Git config override when set", async () => {
      await execa("git", ["-C", repoDir, "config", BRANCH_PATTERN_CONFIG_KEY, "feature/{issue}"]);

      expect(await resolveBranchPattern(repoDir)).toBe("feature/{issue}");
    });

    it.each(["feature/{issue}", "bugfix/{issue}", "review/{issue}", "{issue}"])(
      "supports the pattern %s",
      async (pattern) => {
        await execa("git", ["-C", repoDir, "config", BRANCH_PATTERN_CONFIG_KEY, pattern]);
        expect(await resolveBranchPattern(repoDir)).toBe(pattern);
      },
    );

    it("falls back to the default once the override is unset again", async () => {
      await execa("git", ["-C", repoDir, "config", BRANCH_PATTERN_CONFIG_KEY, "feature/{issue}"]);
      expect(await resolveBranchPattern(repoDir)).toBe("feature/{issue}");

      await execa("git", ["-C", repoDir, "config", "--unset", BRANCH_PATTERN_CONFIG_KEY]);
      expect(await resolveBranchPattern(repoDir)).toBe(DEFAULT_BRANCH_PATTERN);
    });
  });

  describe("renderBranchName", () => {
    it("renders the default pattern exactly as before", () => {
      expect(renderBranchName("ce-harness/{issue}", "fix-login-bug")).toBe(
        "ce-harness/fix-login-bug",
      );
    });

    it.each([
      ["feature/{issue}", "fix-login-bug", "feature/fix-login-bug"],
      ["bugfix/{issue}", "issue-42", "bugfix/issue-42"],
      ["review/{issue}", "review-pr-119", "review/review-pr-119"],
      ["{issue}", "fix-login-bug", "fix-login-bug"],
    ])("renders %s with issue %s as %s", (pattern, issue, expected) => {
      expect(renderBranchName(pattern, issue)).toBe(expected);
    });

    it("substitutes every occurrence of the placeholder, not just the first", () => {
      expect(renderBranchName("{issue}/{issue}", "demo")).toBe("demo/demo");
    });

    it("throws a clear, actionable CeError when the pattern has no {issue} placeholder", () => {
      expect(() => renderBranchName("ce-harness", "fix-login-bug")).toThrow(CeError);
      try {
        renderBranchName("ce-harness", "fix-login-bug");
        expect.fail("expected renderBranchName to throw");
      } catch (error) {
        const ceError = error as InstanceType<typeof CeError>;
        expect(ceError.message).toMatch(/does not include the "\{issue\}" placeholder/);
        expect(ceError.recovery).toMatch(/git config ce-harness\.branch-pattern "feature\/\{issue\}"/);
        expect(ceError.recovery).toMatch(/git config --unset ce-harness\.branch-pattern/);
      }
    });
  });
});
