import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { latestReviewForPr, latestReviewVerdict, listReviewReports, prScopedReportSuffix } from "../../src/core/reviewReports.js";

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

  it("returns null when nothing has been reviewed yet", async () => {
    expect(await latestReviewForPr(durableRoot, 127)).toBeNull();
  });

  it("finds a PR-scoped report and extracts its verdict and reviewed head", async () => {
    const filename = `2026-06-01-${prScopedReportSuffix(127)}.md`;
    await writeReport(
      filename,
      "# Adversarial Review\n\n**Verdict:** PASS WITH GAPS\n**Reviewed PR head:** abc1234\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result).toEqual({
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
    expect(result?.verdict).toBe("PASS");
    expect(result?.reviewedHead).toBe("aaa0000");
  });

  it("never attributes another PR's scoped report to this PR", async () => {
    await writeReport(`2026-06-05-${prScopedReportSuffix(128)}.md`, "**Verdict:** PASS\n**Reviewed PR head:** xyz\n");

    expect(await latestReviewForPr(durableRoot, 127)).toBeNull();
  });

  it("falls back to the most recent legacy (unscoped) report when no PR-scoped report exists, and flags the fallback", async () => {
    await writeReport("2026-05-01-adversarial-review.md", "**Verdict:** PASS WITH GAPS\n");

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result).toEqual({
      filename: "2026-05-01-adversarial-review.md",
      verdict: "PASS WITH GAPS",
      reviewedHead: null,
      legacyFallback: true,
    });
  });

  it("prefers a PR-scoped report over a legacy unscoped one when both exist", async () => {
    await writeReport("2026-05-01-adversarial-review.md", "**Verdict:** FAIL\n");
    await writeReport(
      `2026-06-01-${prScopedReportSuffix(127)}.md`,
      "**Verdict:** PASS\n**Reviewed PR head:** new0000\n",
    );

    const result = await latestReviewForPr(durableRoot, 127);
    expect(result?.legacyFallback).toBe(false);
    expect(result?.verdict).toBe("PASS");
  });

  it("legacy fallback never matches a PR-scoped report belonging to a different PR", async () => {
    await writeReport(`2026-06-01-${prScopedReportSuffix(128)}.md`, "**Verdict:** PASS\n**Reviewed PR head:** other\n");

    // PR 127 has no scoped report of its own, and the only other report on
    // disk is PR 128's scoped report -- which must never be picked up as
    // an unscoped legacy fallback for PR 127.
    expect(await latestReviewForPr(durableRoot, 127)).toBeNull();
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
