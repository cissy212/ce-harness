import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  latestReviewForPr,
  latestReviewVerdict,
  listReviewReports,
  prScopedReportSuffix,
  resolveUniqueReportFilename,
} from "../../src/core/reviewReports.js";

describe("reviewReports: PR-scoped lookup", () => {
  let durableRoot: string;

  beforeEach(async () => {
    durableRoot = await mkdtemp(join(tmpdir(), "ce-harness-reviews-"));
  });

  afterEach(async () => {
    await rm(durableRoot, { recursive: true, force: true });
  });

  async function writeReport(filename: string, content: string): Promise<void> {
    await mkdir(join(durableRoot, "reviews"), { recursive: true });
    await writeFile(join(durableRoot, "reviews", filename), content, "utf8");
  }

  it("returns 'none' when nothing has been reviewed yet", async () => {
    expect(await latestReviewForPr(durableRoot, 127)).toEqual({ kind: "none" });
  });

  it("finds a PR-scoped report and extracts its verdict and reviewed head", async () => {
    const filename = `2026-06-01-${prScopedReportSuffix(127)}.md`;
    await writeReport(
      filename,
      "# Adversarial Review\n\n**Verdict:** PASS WITH GAPS\n**Reviewed PR head:** abc1234\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result).toEqual({
      kind: "found",
      filename,
      verdict: "PASS WITH GAPS",
      reviewedHead: "abc1234",
      legacyFallback: false,
    });
  });

  it("picks the most recent PR-scoped report when several exist for the same PR", async () => {
    await writeReport(
      `2026-06-01-${prScopedReportSuffix(127)}.md`,
      "**Verdict:** FAIL\n**Reviewed PR head:** 0001111\n",
    );
    await writeReport(
      `2026-06-05-${prScopedReportSuffix(127)}.md`,
      "**Verdict:** PASS\n**Reviewed PR head:** aaa0000\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result.kind).toBe("found");
    expect(result.kind === "found" && result.verdict).toBe("PASS");
    expect(result.kind === "found" && result.reviewedHead).toBe("aaa0000");
  });

  it("picks the higher collision-suffixed report over the base filename for the same date", async () => {
    await writeReport(
      `2026-06-01-${prScopedReportSuffix(127)}.md`,
      "**Verdict:** FAIL\n**Reviewed PR head:** aaa0000\n",
    );
    await writeReport(
      `2026-06-01-${prScopedReportSuffix(127)}-2.md`,
      "**Verdict:** PASS\n**Reviewed PR head:** bbb0000\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result.kind === "found" && result.filename).toBe(`2026-06-01-${prScopedReportSuffix(127)}-2.md`);
    expect(result.kind === "found" && result.verdict).toBe("PASS");
  });

  it("never attributes another PR's scoped report to this PR", async () => {
    await writeReport(`2026-06-05-${prScopedReportSuffix(128)}.md`, "**Verdict:** PASS\n**Reviewed PR head:** abc0000\n");

    expect(await latestReviewForPr(durableRoot, 127)).toEqual({ kind: "none" });
  });

  it("attributes a legacy (unscoped) report to this PR via its own Pull request field, and flags the fallback", async () => {
    await writeReport(
      "2026-05-01-adversarial-review.md",
      "# Adversarial Review: some PR\n\n**Verdict:** PASS WITH GAPS\n**Pull request:** https://github.com/example/example/pull/127\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result).toEqual({
      kind: "found",
      filename: "2026-05-01-adversarial-review.md",
      verdict: "PASS WITH GAPS",
      reviewedHead: null,
      legacyFallback: true,
    });
  });

  it("attributes a legacy report via a bare #<number> in its title when the Pull request field is absent", async () => {
    await writeReport(
      "2026-05-01-adversarial-review.md",
      "# Adversarial Review: Some Feature (PR #127)\n\n**Verdict:** PASS\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result.kind).toBe("found");
    expect(result.kind === "found" && result.legacyFallback).toBe(true);
  });

  it("prefers a PR-scoped report over a legacy unscoped one when both exist", async () => {
    await writeReport("2026-05-01-adversarial-review.md", "**Verdict:** FAIL\n**Pull request:** #127\n");
    await writeReport(
      `2026-06-01-${prScopedReportSuffix(127)}.md`,
      "**Verdict:** PASS\n**Reviewed PR head:** aaa0000\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result.kind === "found" && result.legacyFallback).toBe(false);
    expect(result.kind === "found" && result.verdict).toBe("PASS");
  });

  it("a PR-scoped report outranks an attributable legacy report even when the legacy report is the newer file (regression)", async () => {
    // Mirrors the real website-exploration/review-pr-127 sequence: an
    // older, attributable legacy report with verdict PASS WITH GAPS,
    // followed later by a newer PR-scoped follow-up report with verdict
    // PASS and a different reviewed head -- the PR-scoped report must
    // win regardless of which file is chronologically newer, since a
    // PR-scoped report is unambiguous by construction and a legacy one
    // never is.
    await writeReport(
      "2026-09-11-adversarial-review.md",
      "# Adversarial Review: Feature Y (PR #127)\n\n**Verdict:** PASS WITH GAPS\n**Pull request:** https://github.com/example/example/pull/127\n",
    );
    await writeReport(
      `2026-09-14-${prScopedReportSuffix(127)}.md`,
      "**Verdict:** PASS\n**Reviewed PR head:** e1e5b48f104ba32679ab307a9fb51a588c9dca96\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result).toEqual({
      kind: "found",
      filename: `2026-09-14-${prScopedReportSuffix(127)}.md`,
      verdict: "PASS",
      reviewedHead: "e1e5b48f104ba32679ab307a9fb51a588c9dca96",
      legacyFallback: false,
    });
  });

  it("a PR-scoped report outranks an attributable legacy report even when the legacy report is CHRONOLOGICALLY LATER, on paper, than the scoped one", async () => {
    // Deliberately the inverse date ordering of the test above -- proves
    // the PR-scoped/legacy preference is a *type* preference, never an
    // artifact of whichever file happens to sort last.
    await writeReport(
      `2026-06-01-${prScopedReportSuffix(127)}.md`,
      "**Verdict:** PASS\n**Reviewed PR head:** bbb0000\n",
    );
    await writeReport(
      "2026-09-11-adversarial-review.md",
      "**Verdict:** FAIL\n**Pull request:** #127\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result.kind === "found" && result.legacyFallback).toBe(false);
    expect(result.kind === "found" && result.verdict).toBe("PASS");
    expect(result.kind === "found" && result.reviewedHead).toBe("bbb0000");
  });

  it("a PR-scoped report outranks an attributable legacy report even when both are dated the same day (filename ordering must never decide this)", async () => {
    await writeReport(
      "2026-09-14-adversarial-review.md", // legacy, same date, sorts AFTER the scoped filename below lexically ("a" < "p")
      "**Verdict:** FAIL\n**Pull request:** #127\n",
    );
    await writeReport(
      `2026-09-14-${prScopedReportSuffix(127)}.md`,
      "**Verdict:** PASS\n**Reviewed PR head:** ccc0000\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result.kind === "found" && result.legacyFallback).toBe(false);
    expect(result.kind === "found" && result.verdict).toBe("PASS");
    expect(result.kind === "found" && result.reviewedHead).toBe("ccc0000");
  });

  it("legacy fallback never matches a PR-scoped report belonging to a different PR", async () => {
    await writeReport(`2026-06-01-${prScopedReportSuffix(128)}.md`, "**Verdict:** PASS\n**Reviewed PR head:** other\n");

    // PR 127 has no scoped report of its own, and the only other report on
    // disk is PR 128's scoped report -- which must never be picked up as
    // an unscoped legacy fallback for PR 127.
    expect(await latestReviewForPr(durableRoot, 127)).toEqual({ kind: "none" });
  });

  describe("two legacy PR-review workspaces/reports in the same project (regression: cross-PR attribution)", () => {
    // Mirrors the real website-exploration project: PR #124 and PR #127
    // each reviewed under the old, unscoped convention, both landing in
    // the same shared reviews/ directory.
    beforeEach(async () => {
      await writeReport(
        "2026-09-10-adversarial-review.md",
        "# Adversarial Review: Feature X (PR #124)\n\n**Verdict:** FAIL\n**Pull request:** https://github.com/example/example/pull/124\n",
      );
      await writeReport(
        "2026-09-11-adversarial-review.md",
        "# Adversarial Review: Feature Y (PR #127)\n\n**Verdict:** PASS WITH GAPS\n**Pull request:** https://github.com/example/example/pull/127\n",
      );
    });

    it("PR 127's lookup finds its own report, never PR 124's, even though 124's report is older", async () => {
      const result = await latestReviewForPr(durableRoot, 127);
      expect(result).toEqual({
        kind: "found",
        filename: "2026-09-11-adversarial-review.md",
        verdict: "PASS WITH GAPS",
        reviewedHead: null,
        legacyFallback: true,
      });
    });

    it("PR 124's lookup finds its own report, never PR 127's, even though 127's report is the most recent file in the directory", async () => {
      const result = await latestReviewForPr(durableRoot, 124);
      expect(result).toEqual({
        kind: "found",
        filename: "2026-09-10-adversarial-review.md",
        verdict: "FAIL",
        reviewedHead: null,
        legacyFallback: true,
      });
    });

    it("a third, never-reviewed PR in the same project gets 'none', not either PR's report", async () => {
      expect(await latestReviewForPr(durableRoot, 999)).toEqual({ kind: "none" });
    });
  });

  it("returns 'unattributable' -- never a guessed attribution -- when the only legacy report names no PR number at all", async () => {
    await writeReport("2026-05-01-adversarial-review.md", "# Adversarial Review: some-branch\n\n**Verdict:** PASS WITH GAPS\n**Pull request:** some-head-branch\n");

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result).toEqual({ kind: "unattributable", filename: "2026-05-01-adversarial-review.md" });
  });

  it("'unattributable' is never returned when a PR-scoped report already resolves the query", async () => {
    await writeReport("2026-05-01-adversarial-review.md", "**Verdict:** FAIL\n"); // no PR identity at all
    await writeReport(`2026-06-01-${prScopedReportSuffix(127)}.md`, "**Verdict:** PASS\n**Reviewed PR head:** a1\n");

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result.kind).toBe("found");
  });

  it("listReviewReports/latestReviewVerdict stay unscoped, whole-project, unaffected by PR scoping", async () => {
    await writeReport(`2026-06-01-${prScopedReportSuffix(127)}.md`, "**Verdict:** FAIL\n");
    await writeReport(`2026-06-05-${prScopedReportSuffix(128)}.md`, "**Verdict:** PASS\n");

    expect(await listReviewReports(durableRoot)).toHaveLength(2);
    // Unscoped lookup picks whichever report sorts last across the whole
    // project -- unchanged, pre-existing behavior this feature must not
    // alter for `ce status --all`/`ce usage`.
    expect(await latestReviewVerdict(durableRoot)).toBe("PASS");
  });
});

describe("resolveUniqueReportFilename (never overwrite a same-day report)", () => {
  it("returns the base filename when nothing exists yet for that date", () => {
    expect(resolveUniqueReportFilename([], "2026-06-01", 127)).toBe(
      `2026-06-01-${prScopedReportSuffix(127)}.md`,
    );
  });

  it("appends -2 when the base filename for that date already exists", () => {
    const base = `2026-06-01-${prScopedReportSuffix(127)}.md`;
    expect(resolveUniqueReportFilename([base], "2026-06-01", 127)).toBe(
      `2026-06-01-${prScopedReportSuffix(127)}-2.md`,
    );
  });

  it("keeps incrementing past multiple existing collisions on the same date", () => {
    const base = `2026-06-01-${prScopedReportSuffix(127)}.md`;
    const two = `2026-06-01-${prScopedReportSuffix(127)}-2.md`;
    const three = `2026-06-01-${prScopedReportSuffix(127)}-3.md`;
    expect(resolveUniqueReportFilename([base, two, three], "2026-06-01", 127)).toBe(
      `2026-06-01-${prScopedReportSuffix(127)}-4.md`,
    );
  });

  it("never collides across different PR numbers or different dates", () => {
    const base127 = `2026-06-01-${prScopedReportSuffix(127)}.md`;
    expect(resolveUniqueReportFilename([base127], "2026-06-01", 128)).toBe(
      `2026-06-01-${prScopedReportSuffix(128)}.md`,
    );
    expect(resolveUniqueReportFilename([base127], "2026-06-02", 127)).toBe(
      `2026-06-02-${prScopedReportSuffix(127)}.md`,
    );
  });
});
