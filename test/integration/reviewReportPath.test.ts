import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewReportPathCommand } from "../../src/commands/reviewReportPath.js";
import { prScopedReportSuffix } from "../../src/core/reviewReports.js";

describe("ce review-report-path (integration)", () => {
  let rootPath: string;

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), "ce-harness-store-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootPath, { recursive: true, force: true });
  });

  it("prints the base path when nothing exists yet for that date/PR", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await reviewReportPathCommand({ rootPath, prNumber: "127", date: "2026-06-01" });
    expect(logSpy).toHaveBeenCalledWith(join(rootPath, "reviews", `2026-06-01-${prScopedReportSuffix(127)}.md`));
  });

  it("appends a numeric counter when the base path already exists (never overwrites a same-day report)", async () => {
    await mkdir(join(rootPath, "reviews"), { recursive: true });
    await writeFile(join(rootPath, "reviews", `2026-06-01-${prScopedReportSuffix(127)}.md`), "existing report", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await reviewReportPathCommand({ rootPath, prNumber: "127", date: "2026-06-01" });
    expect(logSpy).toHaveBeenCalledWith(
      join(rootPath, "reviews", `2026-06-01-${prScopedReportSuffix(127)}-2.md`),
    );
  });

  it("keeps incrementing across several same-day collisions", async () => {
    await mkdir(join(rootPath, "reviews"), { recursive: true });
    await writeFile(join(rootPath, "reviews", `2026-06-01-${prScopedReportSuffix(127)}.md`), "x", "utf8");
    await writeFile(join(rootPath, "reviews", `2026-06-01-${prScopedReportSuffix(127)}-2.md`), "x", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await reviewReportPathCommand({ rootPath, prNumber: "127", date: "2026-06-01" });
    expect(logSpy).toHaveBeenCalledWith(
      join(rootPath, "reviews", `2026-06-01-${prScopedReportSuffix(127)}-3.md`),
    );
  });

  it("never collides with a different PR's report on the same date", async () => {
    await mkdir(join(rootPath, "reviews"), { recursive: true });
    await writeFile(join(rootPath, "reviews", `2026-06-01-${prScopedReportSuffix(127)}.md`), "x", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await reviewReportPathCommand({ rootPath, prNumber: "128", date: "2026-06-01" });
    expect(logSpy).toHaveBeenCalledWith(join(rootPath, "reviews", `2026-06-01-${prScopedReportSuffix(128)}.md`));
  });

  it("rejects an invalid date", async () => {
    await expect(reviewReportPathCommand({ rootPath, prNumber: "127", date: "06-01-2026" })).rejects.toThrow(
      /not a valid date/i,
    );
  });

  it("rejects an invalid PR number", async () => {
    await expect(reviewReportPathCommand({ rootPath, prNumber: "abc", date: "2026-06-01" })).rejects.toThrow(
      /not a valid pull request number/i,
    );
  });
});
