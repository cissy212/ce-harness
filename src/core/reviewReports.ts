import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractReportPrNumber, extractReviewedHead, extractVerdict, latestReportFile, type ReportVerdict } from "./workflowStatus.js";

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
 * The filename suffix a PR-scoped review report for pull request
 * `prNumber` ends with, absent any collision counter -- `<date>-pr-<n>-
 * adversarial-review.md`, matching exactly what `ce review`'s
 * `CE_PR_NUMBER` env var lets `templates/commands/adversarial-review.md`
 * build for itself in Step 9 (via `ce review-report-path`, which calls
 * `resolveUniqueReportFilename` below). Exported so a test (or any
 * future caller) can construct the same filename without duplicating the
 * convention.
 */
export function prScopedReportSuffix(prNumber: number): string {
  return `pr-${prNumber}-adversarial-review`;
}

/**
 * Matches a PR-scoped report filename for exactly `prNumber` -- the base
 * `<date>-pr-<n>-adversarial-review.md`, or one with a numeric collision
 * counter appended (`-2`, `-3`, ...; see `resolveUniqueReportFilename`),
 * since more than one review can legitimately happen for the same PR on
 * the same calendar day (e.g. two follow-up refreshes in quick
 * succession) and the date alone doesn't disambiguate those.
 */
function prScopedReportPattern(prNumber: number): RegExp {
  return new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${prScopedReportSuffix(prNumber)}(?:-(\\d+))?\\.md$`);
}

/** Matches a PR-scoped report filename for *any* PR number, base or collision-suffixed -- used to exclude every PR-scoped report from the legacy (unscoped) candidate pool below, regardless of which PR it belongs to. */
const ANY_PR_SCOPED_REPORT = /-pr-\d+-adversarial-review(?:-\d+)?\.md$/;

interface ParsedPrScopedFilename {
  filename: string;
  date: string;
  /** 1 for the base filename (no collision counter); the counter's own value otherwise. Only meaningful for ordering two reports from the *same* date. */
  seq: number;
}

function parsePrScopedFilename(filename: string, prNumber: number): ParsedPrScopedFilename | null {
  const match = prScopedReportPattern(prNumber).exec(filename);
  if (!match) return null;
  return { filename, date: match[1], seq: match[2] ? Number(match[2]) : 1 };
}

/** Picks the chronologically latest of `parsed` -- by date first, then by collision counter within the same date. `null` for an empty list. */
function latestParsed(parsed: ParsedPrScopedFilename[]): ParsedPrScopedFilename | null {
  if (parsed.length === 0) return null;
  return parsed.reduce((latest, candidate) => {
    if (candidate.date !== latest.date) return candidate.date > latest.date ? candidate : latest;
    return candidate.seq > latest.seq ? candidate : latest;
  });
}

/**
 * Resolves a collision-free filename for a PR-scoped `/adversarial-review`
 * report on `date` (`YYYY-MM-DD`) for `prNumber`, given the filenames
 * already present in `reviews/`. The date alone does not guarantee
 * uniqueness -- more than one review of the same PR can legitimately
 * happen on the same calendar day (e.g. two follow-up refreshes in quick
 * succession) -- so this appends a numeric counter (`-2`, `-3`, ...)
 * rather than ever silently overwriting an earlier report from the same
 * day. `ce review-report-path` is the CLI surface over this for
 * `templates/commands/adversarial-review.md` to call, instead of the
 * template hand-rolling collision detection in bash.
 */
export function resolveUniqueReportFilename(
  existingFilenames: string[],
  date: string,
  prNumber: number,
): string {
  const existing = new Set(existingFilenames);
  const base = `${date}-${prScopedReportSuffix(prNumber)}.md`;
  if (!existing.has(base)) return base;
  let seq = 2;
  while (existing.has(`${date}-${prScopedReportSuffix(prNumber)}-${seq}.md`)) {
    seq += 1;
  }
  return `${date}-${prScopedReportSuffix(prNumber)}-${seq}.md`;
}

export interface PrReviewReportFound {
  kind: "found";
  /** The report's filename inside `<durableRoot>/reviews/`. */
  filename: string;
  verdict: ReportVerdict | null;
  /** From the report's own `**Reviewed PR head:**` field; `null` for a report written before that field existed. */
  reviewedHead: string | null;
  /**
   * True when no PR-scoped report exists yet for this PR and this
   * instead falls back to a legacy, unscoped report that could be
   * confidently attributed to this PR via its own `**Pull request:**`
   * field or title (see `extractReportPrNumber`) -- the only kind that
   * existed before PR-number scoping.
   */
  legacyFallback: boolean;
}

/**
 * A legacy (unscoped) report exists in this store, but it could not be
 * confirmed to belong to `prNumber` specifically -- either its own
 * `**Pull request:**`/title fields name a *different* PR (see
 * `extractReportPrNumber`) with nothing else in the store attributable to
 * this one, or no PR number could be extracted from it at all. Callers
 * must never treat `filename`'s verdict/findings as this PR's own --
 * "cannot confirm" is reported explicitly rather than guessing, since a
 * wrongly-attributed report is worse than none.
 */
export interface PrReviewReportUnattributable {
  kind: "unattributable";
  /** The most recent legacy report this store has, kept only so a caller can mention it exists (e.g. "see <filename> if you want to check it manually") -- never used as evidence for `prNumber`. */
  filename: string;
}

export interface PrReviewReportNone {
  kind: "none";
}

export type PrReviewReportLookup = PrReviewReportFound | PrReviewReportUnattributable | PrReviewReportNone;

/**
 * The most recent review report for exactly pull request `prNumber`
 * within this store's shared `reviews/` directory (see the module doc
 * comment above for why scoping matters here).
 *
 * 1. Prefers a PR-scoped report (`<date>-pr-<prNumber>-adversarial-
 *    review[-<n>].md`) -- unambiguous by construction.
 * 2. Otherwise, scans every *legacy* (unscoped, pre-PR-scoping) report in
 *    the store, most recent first, and attributes one to `prNumber` only
 *    when its own `**Pull request:**` field or title names that exact PR
 *    number (`extractReportPrNumber`) -- never merely because it happens
 *    to be the most recent file in a directory shared by every PR this
 *    project has ever reviewed. A legacy report confidently attributed to
 *    a *different* PR is skipped, not used as a fallback for this one.
 * 3. If no report can be attributed to `prNumber` at all, but at least
 *    one legacy report exists whose PR number couldn't be determined
 *    either way, returns `{ kind: "unattributable" }` -- there might be
 *    evidence here, but it cannot be trusted, so it must never be
 *    silently presented as this PR's own review.
 * 4. Returns `{ kind: "none" }` only when nothing in the store could
 *    plausibly relate to `prNumber` (no PR-scoped report, and either no
 *    legacy reports at all or every legacy report is confidently
 *    attributed elsewhere).
 */
export async function latestReviewForPr(durableRoot: string, prNumber: number): Promise<PrReviewReportLookup> {
  const reports = await listReviewReports(durableRoot);

  const scopedCandidates = reports
    .map((f) => parsePrScopedFilename(f, prNumber))
    .filter((p): p is ParsedPrScopedFilename => p !== null);
  const scoped = latestParsed(scopedCandidates);
  if (scoped) {
    return readFound(durableRoot, scoped.filename, false);
  }

  const legacyFilenames = reports
    .filter((f) => !ANY_PR_SCOPED_REPORT.test(f) && f.endsWith("-adversarial-review.md"))
    .sort()
    .reverse(); // most recent first (date-prefixed filenames sort chronologically)

  let mostRecentUnattributable: string | null = null;
  for (const filename of legacyFilenames) {
    let content: string;
    try {
      content = await readFile(join(durableRoot, "reviews", filename), "utf8");
    } catch {
      continue;
    }
    const attributed = extractReportPrNumber(content);
    if (attributed === prNumber) {
      return {
        kind: "found",
        filename,
        verdict: extractVerdict(content),
        reviewedHead: extractReviewedHead(content),
        legacyFallback: true,
      };
    }
    if (attributed === null && mostRecentUnattributable === null) {
      mostRecentUnattributable = filename;
    }
    // attributed to a *different*, confirmed PR number: definitively not
    // this PR's report -- keep looking at older legacy reports rather
    // than giving up.
  }

  if (mostRecentUnattributable) {
    return { kind: "unattributable", filename: mostRecentUnattributable };
  }
  return { kind: "none" };
}

async function readFound(durableRoot: string, filename: string, legacyFallback: boolean): Promise<PrReviewReportFound> {
  try {
    const content = await readFile(join(durableRoot, "reviews", filename), "utf8");
    return {
      kind: "found",
      filename,
      verdict: extractVerdict(content),
      reviewedHead: extractReviewedHead(content),
      legacyFallback,
    };
  } catch {
    return { kind: "found", filename, verdict: null, reviewedHead: null, legacyFallback };
  }
}
