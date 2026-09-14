import { join } from "node:path";
import { CeError } from "../core/errors.js";
import { listReviewReports, resolveUniqueReportFilename } from "../core/reviewReports.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PR_NUMBER_PATTERN = /^[1-9]\d*$/;

export interface ReviewReportPathOptions {
  /** Absolute path to the OpenSpec store root (`root.path`, from `openspec list --json` -- see Step 1 of adversarial-review.md). */
  rootPath: string;
  /** Raw CLI argument -- validated as a positive integer before use. */
  prNumber: string;
  /** Raw CLI argument -- validated as `YYYY-MM-DD` before use. Must be the exact output of `date -u +%Y-%m-%d`, never inferred. */
  date: string;
}

/**
 * `ce review-report-path`: resolves the exact, collision-free filesystem
 * path `/adversarial-review` (an Existing PR review workspace) should
 * write its report to, for `date`/`prNumber`. Centralizes
 * `resolveUniqueReportFilename`'s collision-avoidance logic here rather
 * than having the template hand-roll it in bash (checking for an
 * existing file and picking the next free numeric suffix) -- the same
 * rationale as `ce diff-scope` centralizing its own algorithm.
 *
 * More than one review can legitimately happen for the same PR on the
 * same calendar day (e.g. two follow-up refreshes in quick succession);
 * the date-only filename convention alone doesn't disambiguate those, so
 * this appends a numeric counter (`-2`, `-3`, ...) rather than ever
 * resolving to a path that would silently overwrite an earlier report.
 *
 * Read-only: only lists `<rootPath>/reviews/`'s existing filenames, never
 * writes anything itself -- the template writes the report to the path
 * this prints.
 */
export async function reviewReportPathCommand({ rootPath, prNumber, date }: ReviewReportPathOptions): Promise<void> {
  if (!DATE_PATTERN.test(date)) {
    throw new CeError(
      `"${date}" is not a valid date -- expected YYYY-MM-DD.`,
      "Pass the exact output of `date -u +%Y-%m-%d`, never an inferred or remembered date.",
    );
  }
  const trimmedPr = prNumber.trim();
  if (!PR_NUMBER_PATTERN.test(trimmedPr)) {
    throw new CeError(
      `"${prNumber}" is not a valid pull request number.`,
      "Provide the PR number as a positive integer (e.g. the value of $CE_PR_NUMBER).",
    );
  }
  const number = Number(trimmedPr);

  const existing = await listReviewReports(rootPath);
  const filename = resolveUniqueReportFilename(existing, date, number);
  console.log(join(rootPath, "reviews", filename));
}
