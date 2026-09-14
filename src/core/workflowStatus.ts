import type { ChangeArtifactSummary } from "./activeChange.js";
import { type ProvenanceStage, type StalenessResult, isStageInvalid } from "./provenance.js";

/**
 * Pure derivation of `ce status`'s default, human-oriented summary: "what
 * state is this in" (progress), "does anything need my attention", and
 * "what should I do next" -- for an Implementation workspace's active
 * change, and separately for an Existing PR review workspace's review.
 *
 * Deliberately mirrors the next-step guidance already written into the
 * workflow templates themselves (see templates/commands/*.md's own
 * "Report back" steps and provenance-gate guardrails) rather than
 * inventing a second, independent notion of "what's next" -- this is
 * `ce status` reporting the same thing the runner would tell you inside
 * the session, not a new policy.
 *
 * No I/O here: callers (src/commands/status.ts) gather the raw facts
 * (artifact presence, provenance staleness, task-checkbox counts, report
 * verdicts) and pass them in, which is what keeps this module trivially
 * unit-testable and keeps `ce status` itself fast (no new dependency on
 * shelling out to any binary beyond what it already used).
 */

export type ReportVerdict = "PASS" | "PASS WITH GAPS" | "FAIL";

const VERDICT_PATTERN = /\*\*Verdict:\*\*\s*(PASS WITH GAPS|PASS|FAIL)\b/;

/** Extracts a report's `**Verdict:**` line (verify.md/adversarial-review.md's own machine-parseable sentinel). `null` if absent or unrecognized. */
export function extractVerdict(reportContent: string): ReportVerdict | null {
  const match = VERDICT_PATTERN.exec(reportContent);
  return (match?.[1] as ReportVerdict | undefined) ?? null;
}

const REVIEWED_PR_HEAD_PATTERN = /\*\*Reviewed PR head:\*\*\s*([0-9a-f]{7,40})\b/i;

/**
 * Extracts an Existing PR review workspace's `**Reviewed PR head:**`
 * line -- the exact PR head SHA `/adversarial-review` actually reviewed
 * (see `templates/commands/adversarial-review.md`'s Step 9). `null` when
 * absent: every report written before this field existed, and every
 * report for an Implementation workspace (which never has this field at
 * all -- it has its own "Reviewed worktree commit"/fingerprint instead).
 * Mirrors `extractVerdict`'s exact convention -- a durable, git-tracked,
 * machine-checkable sentinel line, never free-form prose parsing.
 */
export function extractReviewedHead(reportContent: string): string | null {
  const match = REVIEWED_PR_HEAD_PATTERN.exec(reportContent);
  return match?.[1] ?? null;
}

export interface TaskProgress {
  completed: number;
  total: number;
}

const TASK_CHECKBOX_PATTERN = /^\s*-\s\[([ xX])\]/gm;

/** Counts `- [x]`/`- [ ]` checkboxes in a `tasks.md`'s content. `null` when the file has no checkboxes at all (e.g. not yet written in this shape). */
export function parseTaskProgress(tasksContent: string): TaskProgress | null {
  let total = 0;
  let completed = 0;
  for (const match of tasksContent.matchAll(TASK_CHECKBOX_PATTERN)) {
    total += 1;
    if (match[1].toLowerCase() === "x") completed += 1;
  }
  return total > 0 ? { completed, total } : null;
}

/** Picks the most recent report filename ending in `-<suffix>.md` (date-prefixed filenames sort chronologically). `null` if none match. */
export function latestReportFile(filenames: string[], suffix: string): string | null {
  const matching = filenames.filter((f) => f.endsWith(`-${suffix}.md`)).sort();
  return matching.length > 0 ? matching[matching.length - 1] : null;
}

export interface ImplementationWorkflowInput {
  summary: ChangeArtifactSummary;
  /** Staleness result for each *present* planning stage, in explore/enrich/propose order. */
  provenance: { stage: ProvenanceStage; result: StalenessResult }[];
  taskProgress: TaskProgress | null;
  verifyVerdict: ReportVerdict | null;
  adversarialVerdict: ReportVerdict | null;
  bootstrapRequired: boolean;
}

export interface WorkflowStatus {
  /** e.g. "explore ✓  enrich ✓  proposal ✓  design ✓  tasks 3/7". */
  progressLine: string;
  /** Each a standalone, human-readable sentence -- printed as a bulleted list. */
  attention: string[];
  /** e.g. "/apply", or "/explore (or /propose if you already know what to build)". */
  nextStep: string;
}

/** Renders the concise progress line for an active change -- artifact checkmarks, with numeric task progress when known. */
export function formatProgressLine(summary: ChangeArtifactSummary, taskProgress: TaskProgress | null): string {
  const mark = (present: boolean) => (present ? "✓" : "✗");
  const parts = [
    `explore ${mark(summary.explore.present)}`,
    `enrich ${mark(summary.enrich.present)}${summary.enrich.status ? ` (${summary.enrich.status})` : ""}`,
    `proposal ${mark(summary.proposal.present)}`,
    `design ${mark(summary.design.present)}`,
    taskProgress ? `tasks ${taskProgress.completed}/${taskProgress.total}` : `tasks ${mark(summary.tasks.present)}`,
  ];
  return parts.join("  ");
}

/**
 * Derives attention items and the next suggested slash command for an
 * Implementation workspace's single active change. Priority order,
 * matching the templates' own hard-gate behavior:
 *
 * 1. The earliest present planning stage (explore -> enrich -> propose)
 *    with stale or unknown provenance -- exactly where `/enrich`/
 *    `/propose`/`/apply` themselves would stop, so this is reported as
 *    the next step rather than anything further along.
 * 2. Otherwise, the first missing planning artifact in the same order.
 * 3. Otherwise, unfinished tasks -- `/apply`.
 * 4. Otherwise, `/verify`, then `/adversarial-review`, then `/archive`,
 *    each gated on the previous one's most recent verdict being a clean
 *    `PASS` (a `PASS WITH GAPS`/`FAIL` verdict is reported as an
 *    attention item, with the same "fix, then re-verify" guidance the
 *    templates themselves give).
 *
 * Bootstrap-required is always surfaced as an attention item when true,
 * independent of the above, since it can block `/apply`/`/verify`
 * regardless of which stage the change is otherwise at.
 */
export function deriveImplementationWorkflowStatus(input: ImplementationWorkflowInput): WorkflowStatus {
  const attention: string[] = [];
  if (input.bootstrapRequired) {
    attention.push("This repository needs local setup before /apply or /verify (see below).");
  }

  for (const { stage, result } of input.provenance) {
    if (isStageInvalid(result)) {
      attention.push(
        result.status === "stale"
          ? `/${stage}'s findings are stale (the repository changed since it last ran) -- rerun /${stage}.`
          : `/${stage}'s findings have no recorded provenance (a legacy artifact) -- rerun /${stage}.`,
      );
      return { progressLine: formatProgressLine(input.summary, input.taskProgress), attention, nextStep: `/${stage}` };
    }
  }

  const progressLine = formatProgressLine(input.summary, input.taskProgress);

  if (!input.summary.explore.present && !input.summary.enrich.present && !input.summary.proposal.present) {
    return { progressLine, attention, nextStep: "/explore (or /propose if you already know what to build)" };
  }
  if (!input.summary.enrich.present && !input.summary.proposal.present) {
    return { progressLine, attention, nextStep: "/enrich" };
  }
  if (!input.summary.proposal.present) {
    return { progressLine, attention, nextStep: "/propose" };
  }

  if (input.taskProgress && input.taskProgress.completed < input.taskProgress.total) {
    return { progressLine, attention, nextStep: "/apply" };
  }

  if (input.verifyVerdict === null) {
    return { progressLine, attention, nextStep: "/verify" };
  }
  if (input.verifyVerdict !== "PASS") {
    attention.push(`The last /verify was ${input.verifyVerdict} -- address the findings, then re-run /verify.`);
    return { progressLine, attention, nextStep: "/apply (fix findings), then /verify" };
  }

  if (input.adversarialVerdict === null) {
    return { progressLine, attention, nextStep: "/adversarial-review" };
  }
  if (input.adversarialVerdict !== "PASS") {
    attention.push(
      `The last /adversarial-review was ${input.adversarialVerdict} -- address the findings, then re-run /verify.`,
    );
    return { progressLine, attention, nextStep: "/apply (fix findings), then /verify" };
  }

  return { progressLine, attention, nextStep: "/archive" };
}

/**
 * Best-effort signal of whether a completed review is stale -- the pull
 * request has moved since the review that produced `reviewVerdict` last
 * ran. Entirely optional on `ReviewWorkflowInput`: absent whenever `ce
 * status` couldn't attempt (or didn't need) the live GitHub check (a
 * legacy `--base/--head` workspace with no recoverable PR number, `gh`
 * unavailable/unauthenticated, offline, or no completed review to even
 * compare against yet) -- `deriveReviewWorkflowStatus` then behaves
 * exactly as it always has, with no staleness claim made either way.
 */
export interface PrReviewStaleness {
  /** The PR head SHA the most recent completed review actually reviewed, or `null` if it could not be recovered at all (see `extractReviewedHead`'s doc comment). */
  reviewedHead: string | null;
  /** The pull request's current head SHA, live from GitHub. */
  currentHead: string;
  /** True only when `reviewedHead` was recovered from a legacy fallback (the workspace's own configured diff head) rather than a report's own structured field -- surfaced so `ce status` can caveat it rather than presenting it as equally authoritative. */
  reviewedHeadInferred: boolean;
}

export interface ReviewWorkflowInput {
  reviewVerdict: ReportVerdict | null;
  /** See `PrReviewStaleness`. Only ever meaningful when `reviewVerdict` is non-null -- a review that hasn't run yet can't be "stale". */
  staleness?: PrReviewStaleness | null;
}

export interface ReviewWorkflowStatus {
  attention: string[];
  nextStep: string;
  /** e.g. "not yet done", "done -- verdict PASS", or "stale -- PR updated since last review". */
  summaryLine: string;
  /** Present only when `summaryLine` reports staleness -- the exact heads to show (`ce status` prints these as their own labeled lines). */
  staleness?: { reviewedHead: string | null; currentHead: string };
}

/** Same idea as `deriveImplementationWorkflowStatus`, for an Existing PR review workspace, whose entire workflow is a single `/adversarial-review` run. */
export function deriveReviewWorkflowStatus(input: ReviewWorkflowInput): ReviewWorkflowStatus {
  if (input.reviewVerdict === null) {
    return { attention: [], nextStep: "/adversarial-review", summaryLine: "not yet done" };
  }

  const staleness = input.staleness;
  if (staleness && staleness.currentHead !== staleness.reviewedHead) {
    return {
      attention: [
        `This pull request has new commits since the last review${
          staleness.reviewedHeadInferred
            ? " (reviewed head inferred from this workspace's configured PR head -- the report itself predates head-tracking)"
            : ""
        } -- the previous verdict (${input.reviewVerdict}) no longer reflects the current code.`,
      ],
      nextStep:
        "follow-up review -- run `ce review <repo> <pr-number>` to pull the new commits, then re-run /adversarial-review",
      summaryLine: "stale -- PR updated since last review",
      staleness: { reviewedHead: staleness.reviewedHead, currentHead: staleness.currentHead },
    };
  }

  if (input.reviewVerdict !== "PASS") {
    return {
      attention: [`The review verdict was ${input.reviewVerdict} -- see the report for findings.`],
      nextStep: "address the findings, then re-run /adversarial-review",
      summaryLine: `done -- verdict ${input.reviewVerdict}`,
    };
  }
  return { attention: [], nextStep: "none -- review complete", summaryLine: "done -- verdict PASS" };
}
