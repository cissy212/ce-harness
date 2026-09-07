import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractVerdict, latestReportFile, type ReportVerdict } from "./workflowStatus.js";

/**
 * Read-only discovery of an Existing PR review workspace's review
 * reports -- `<durableRoot>/reviews/*-adversarial-review.md` (see
 * `templates/commands/adversarial-review.md`'s Step 9: this is its
 * dedicated report location for this workspace type, since there is no
 * OpenSpec change to nest a `reports/` directory under). Deliberately
 * separate from `core/activeChange.ts`'s change-scoped `reports/`
 * discovery, which this workspace type never uses.
 */

/** Lists filenames directly under `<durableRoot>/reviews/`, sorted. Never throws: a missing directory (nothing reviewed yet) yields an empty list. */
export async function listReviewReports(durableRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(durableRoot, "reviews"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The most recent `/adversarial-review` report's verdict for this store's
 * `reviews/` directory, or `null` when none exists yet or it has no
 * recognizable `**Verdict:**` line.
 */
export async function latestReviewVerdict(durableRoot: string): Promise<ReportVerdict | null> {
  const reports = await listReviewReports(durableRoot);
  const latest = latestReportFile(reports, "adversarial-review");
  if (!latest) return null;
  try {
    const content = await readFile(join(durableRoot, "reviews", latest), "utf8");
    return extractVerdict(content);
  } catch {
    return null;
  }
}
