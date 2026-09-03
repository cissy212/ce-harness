import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { computeWorktreeFingerprint } from "./git.js";

/**
 * Provenance/staleness tracking for a change's *planning* artifacts --
 * `explore.md`, `enrich.md`, and the `/propose`-produced
 * `proposal.md`/`design.md`/`tasks.md` (tracked together as one
 * "propose" stage, since a single `/propose` run writes all three
 * against the same worktree snapshot). These are exactly the durable
 * artifacts that had zero provenance tracking before this module: a
 * durable OpenSpec store survives `ce cleanup` and is reused by every
 * later workspace for the same project, so a much later `/enrich`,
 * `/propose`, or `/apply` run can otherwise silently trust findings or a
 * plan written against a codebase snapshot that no longer resembles the
 * current one, with no signal anything might be stale.
 *
 * Staleness is a hard dependency gate for `/enrich`, `/propose`, and
 * `/apply` -- each stops rather than proceeding when the artifact it
 * depends on is stale *or* has no recorded provenance at all (see
 * `isStageInvalid`). Only `ce status`'s own reporting is purely
 * informational.
 *
 * Deliberately separate from -- and does not touch -- `/verify`'s and
 * `/adversarial-review`'s own, already-established worktree-fingerprint
 * + artifacts-hash mechanism (which `/archive`'s gate uses to detect
 * whether *verification evidence* has gone stale relative to the
 * *implementation*): that mechanism is unrelated in purpose (checking
 * conformance evidence, not planning-artifact currency) and already
 * fully working; this module exists to close a different, previously
 * unaddressed gap.
 *
 * Each stage's stamp is a small, ce-harness-owned sidecar file inside
 * the change directory (never one of OpenSpec's own schema artifacts),
 * following the exact same convention `core/activeChange.ts`'s
 * `.ce-workspace.yml` ownership sidecar already established: written
 * directly by the producing template via a plain shell `printf`, read
 * here via the same `yaml` parser `readChangeOwnership` uses, and
 * degrading to "not recorded" (never a crash, never treated as an
 * error) for any change that predates this mechanism.
 */

export type ProvenanceStage = "explore" | "enrich" | "propose";

const STAGE_FILENAMES: Record<ProvenanceStage, string> = {
  explore: ".ce-provenance-explore.yml",
  enrich: ".ce-provenance-enrich.yml",
  propose: ".ce-provenance-propose.yml",
};

export interface ProvenanceStamp {
  /** Full commit SHA -- human reference only, never itself compared. */
  commit: string;
  /** 12-char worktree fingerprint (see computeWorktreeFingerprint) as of when this stage last ran. */
  fingerprint: string;
  /** YYYY-MM-DD, from the same deterministic `date -u +%Y-%m-%d` source every other durable artifact date uses. */
  recordedAt: string;
}

/**
 * Best-effort read of `stage`'s provenance stamp for the change at
 * `changeRoot`. Never throws: a missing sidecar (every change/stage
 * that predates this mechanism) or a malformed one both simply mean
 * "not recorded" -- callers degrade to that, never crash or error.
 */
export async function readProvenance(changeRoot: string, stage: ProvenanceStage): Promise<ProvenanceStamp | null> {
  try {
    const raw = await readFile(join(changeRoot, STAGE_FILENAMES[stage]), "utf8");
    const parsed = parse(raw) as Record<string, unknown> | null;
    if (
      typeof parsed?.commit === "string" &&
      typeof parsed?.fingerprint === "string" &&
      typeof parsed?.recordedAt === "string"
    ) {
      return { commit: parsed.commit, fingerprint: parsed.fingerprint, recordedAt: parsed.recordedAt };
    }
    return null;
  } catch {
    return null;
  }
}

export type StalenessResult =
  | { status: "unknown" }
  | { status: "fresh"; stamp: ProvenanceStamp }
  | { status: "stale"; stamp: ProvenanceStamp; currentFingerprint: string };

/**
 * Compares `stage`'s recorded provenance fingerprint against
 * `worktreePath`'s current one (via `computeWorktreeFingerprint`, the
 * exact same HEAD + uncommitted-tracked-and-untracked-content algorithm
 * `/verify`/`/adversarial-review`/`/archive` and `ce publish` already
 * use). Exact match only, no tolerance -- the same convention the
 * existing verify/archive freshness gate already uses. `"unknown"` (not
 * `"stale"`) when nothing was recorded at all, and also when the
 * fingerprint can't be computed at all (e.g. a broken worktree) --
 * never lets a provenance check itself crash a caller like `ce status`.
 */
export async function checkStaleness(
  changeRoot: string,
  stage: ProvenanceStage,
  worktreePath: string,
): Promise<StalenessResult> {
  const stamp = await readProvenance(changeRoot, stage);
  if (!stamp) return { status: "unknown" };

  let currentFingerprint: string;
  try {
    currentFingerprint = await computeWorktreeFingerprint(worktreePath);
  } catch {
    return { status: "unknown" };
  }

  return currentFingerprint === stamp.fingerprint
    ? { status: "fresh", stamp }
    : { status: "stale", stamp, currentFingerprint };
}

/**
 * True unless `result` is `"fresh"` -- both `"stale"` and `"unknown"`
 * count as invalid for gating purposes. This is the crux of the
 * "existing artifacts without provenance must not be treated as fresh"
 * requirement: a legacy artifact (present on disk, but predating this
 * mechanism, so with no sidecar at all) is exactly as untrustworthy as
 * one whose recorded fingerprint no longer matches -- neither is safe
 * for a later stage to silently build on. Every consuming template
 * (`/enrich`, `/propose`, `/apply`) gates on this, not just on
 * `"stale"` alone.
 */
export function isStageInvalid(result: StalenessResult): boolean {
  return result.status !== "fresh";
}

/**
 * Renders a compact, one-line-per-change summary of every stage with a
 * *present* artifact (callers pass only those), e.g. `explore fresh (as
 * of 2026-09-01)  enrich unknown (no provenance recorded -- legacy) --
 * rerun /enrich  propose stale (repo changed since 2026-08-15) -- rerun
 * /propose`. Unlike a change with nothing recorded (nothing to
 * summarize -- returns null), a stage whose *artifact exists* but has
 * `"unknown"` provenance is always shown, exactly as prominently as
 * `"stale"` -- `ce status` must surface a legacy/unrecorded stage just
 * as clearly as a genuinely stale one, per the same
 * never-treat-unknown-as-fresh principle `isStageInvalid` encodes. Each
 * non-fresh entry names the exact command to rerun.
 */
export function formatProvenanceSummary(entries: { stage: ProvenanceStage; result: StalenessResult }[]): string | null {
  const parts = entries.map(({ stage, result }) => {
    if (result.status === "fresh") return `${stage} fresh (as of ${result.stamp.recordedAt})`;
    if (result.status === "stale") {
      return `${stage} stale (repo changed since ${result.stamp.recordedAt}) -- rerun /${stage}`;
    }
    return `${stage} unknown (no provenance recorded -- legacy) -- rerun /${stage}`;
  });
  return parts.length > 0 ? parts.join("  ") : null;
}
