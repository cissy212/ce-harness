import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractReviewedHead, extractVerdict, latestReportFile, type ReportVerdict } from "./workflowStatus.js";

/**
 * Read-only discovery of an Existing PR review workspace's review
 * reports -- `<durableRoot>/reviews/*-adversarial-review.md` (see
 * `templates/commands/adversarial-review.md`'s Step 9: this is its
 * dedicated report location for this workspace type, since there is no
 * OpenSpec change to nest a `reports/` directory under). Deliberately
 * separate from `core/activeChange.ts`'s change-scoped `reports/`
 * discovery, which this workspace type never uses.
 *
 * `<durableRoot>/reviews/` is shared by every PR review workspace of the
 * same project (see `core/openspecId.ts` -- the durable store is keyed
 * by project, not by workspace), so a project that has reviewed more
 * than one pull request accumulates all of their reports in this one
 * directory. `listReviewReports`/`latestReviewVerdict` below are
 * deliberately unscoped (exactly as before this module gained PR-number
 * awareness) -- used by `ce status --all`/`ce usage` for a whole-project
 * count, where that's the right behavior. `latestReviewForPr` is the
 * PR-scoped counterpart, for `ce status`'s per-workspace stale-review
 * check, which must never attribute one PR's review to another's
 * workspace.
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

/**
 * The filename suffix (passed to `latestReportFile`) a PR-scoped review
 * report for pull request `prNumber` ends with -- `<date>-pr-<n>-
 * adversarial-review.md`, matching exactly what `ce review`'s
 * `CE_PR_NUMBER` env var lets `templates/commands/adversarial-review.md`
 * build for itself in Step 9. Exported so a test (or any future caller)
 * can construct the same filename without duplicating the convention.
 */
export function prScopedReportSuffix(prNumber: number): string {
  return `pr-${prNumber}-adversarial-review`;
}

const ANY_PR_SCOPED_REPORT = /-pr-\d+-adversarial-review\.md$/;

export interface PrReviewReportLookup {
  /** The report's filename inside `<durableRoot>/reviews/`. */
  filename: string;
  verdict: ReportVerdict | null;
  /** From the report's own `**Reviewed PR head:**` field; `null` for a report written before that field existed. */
  reviewedHead: string | null;
  /**
   * True when no PR-scoped report (`*-pr-<prNumber>-adversarial-review.md`)
   * exists yet and this instead falls back to the most recent *unscoped*
   * report -- the only kind that existed before PR-number scoping. Best
   * effort only: if this project has ever reviewed more than one pull
   * request under the legacy, unscoped convention, this cannot tell
   * which of them the fallback report actually covers.
   */
  legacyFallback: boolean;
}

/**
 * The most recent review report for exactly pull request `prNumber`
 * within this store's shared `reviews/` directory (see the module doc
 * comment above for why scoping matters here). Prefers a PR-scoped
 * report; when none exists yet, falls back to the most recent *unscoped*
 * report (the legacy, pre-PR-scoping convention) so a workspace that
 * reviewed its PR before this feature shipped still reports its
 * existing verdict -- see `legacyFallback` on the result for exactly
 * when that happened. Returns `null` only when no report of either kind
 * exists at all (nothing reviewed yet).
 */
export async function latestReviewForPr(
  durableRoot: string,
  prNumber: number,
): Promise<PrReviewReportLookup | null> {
  const reports = await listReviewReports(durableRoot);

  const scopedFilename = latestReportFile(reports, prScopedReportSuffix(prNumber));
  if (scopedFilename) {
    return readReport(durableRoot, scopedFilename, false);
  }

  const legacyFilename = latestReportFile(
    reports.filter((f) => !ANY_PR_SCOPED_REPORT.test(f)),
    "adversarial-review",
  );
  if (!legacyFilename) return null;
  return readReport(durableRoot, legacyFilename, true);
}

async function readReport(
  durableRoot: string,
  filename: string,
  legacyFallback: boolean,
): Promise<PrReviewReportLookup> {
  try {
    const content = await readFile(join(durableRoot, "reviews", filename), "utf8");
    return {
      filename,
      verdict: extractVerdict(content),
      reviewedHead: extractReviewedHead(content),
      legacyFallback,
    };
  } catch {
    return { filename, verdict: null, reviewedHead: null, legacyFallback };
  }
}
