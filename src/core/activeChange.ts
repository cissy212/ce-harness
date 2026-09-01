import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read-only discovery of a durable OpenSpec store's active (i.e. not yet
 * archived) changes, and of which major artifacts exist for one of them.
 * Backs `ce status`'s "Active change" section and `ce open --change` --
 * see their doc comments for why this exists: after `/explore`,
 * `/enrich`, `/propose` persist real work, a user should never have to
 * learn the durable store's internal path layout just to find it.
 *
 * Deliberately filesystem-based rather than a new `openspec` CLI
 * wrapper: `openspec/changes/<name>/` (active) vs.
 * `openspec/changes/archive/<date>-<name>/` (archived) is the exact
 * layout core/retrieval.ts already relies on, and this project's own
 * first end-to-end usability test confirmed it against a real durable
 * store (`~/.ce-harness/openspec/<project-id>/openspec/changes/
 * <name>/`). "Which major artifacts exist" is answered by simple
 * existence checks -- exactly what this feature needs -- so there is no
 * need to depend on the real `openspec status --change --json`'s exact
 * schema, which this codebase has no local copy or version pin to
 * verify against.
 */

export interface ArtifactPresence {
  present: boolean;
  /** Only ever set for `enrich`: its own `**Status:**` line, when the file exists and that line is readable. */
  status?: "ready" | "needs-clarification";
}

export interface ChangeArtifactSummary {
  explore: ArtifactPresence;
  enrich: ArtifactPresence;
  proposal: ArtifactPresence;
  design: ArtifactPresence;
  tasks: ArtifactPresence;
  /** Capability names with a delta spec.md under this change's own `specs/` (e.g. ["billing"]). Empty if none. */
  specs: string[];
  /** Filenames under this change's `reports/` (e.g. `/verify`, `/adversarial-review` output). Empty if none. */
  reports: string[];
}

/** Resolves `<durableRoot>/openspec/changes/<name>` -- the same active-change layout every workflow template, and core/retrieval.ts, already assume. Never constructed anywhere else by hand. */
export function activeChangeRoot(durableRoot: string, name: string): string {
  return join(durableRoot, "openspec", "changes", name);
}

/**
 * Lists this durable store's active (non-archived) change names, sorted.
 * Never throws: a missing or unreadable `openspec/changes/` directory
 * (e.g. a brand-new store with no change proposed yet) is reported as
 * simply "no active changes", not an error -- exactly the same
 * tolerant-of-absence convention `core/retrieval.ts` already follows for
 * this same store.
 */
export async function listActiveChanges(durableRoot: string): Promise<string[]> {
  const changesDir = join(durableRoot, "openspec", "changes");
  try {
    const entries = await readdir(changesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== "archive")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Best-effort read of `enrich.md`'s own `**Status:**` line. Never throws -- an unreadable or unexpectedly-shaped file just yields no status, never a crash. */
async function readEnrichStatus(path: string): Promise<"ready" | "needs-clarification" | undefined> {
  try {
    const content = await readFile(path, "utf8");
    const match = /\*\*Status:\*\*\s*(ready|needs-clarification)\b/i.exec(content);
    if (!match) return undefined;
    return match[1].toLowerCase() as "ready" | "needs-clarification";
  } catch {
    return undefined;
  }
}

async function listDirectoryNames(dir: string, kind: "directory" | "file"): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => (kind === "directory" ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Which of `changeRoot`'s major artifacts currently exist, read-only.
 * Covers both OpenSpec's own schema artifacts (proposal/design/tasks,
 * and any delta spec.md files under `specs/`) and ce-harness's own
 * non-schema artifacts (`explore.md`, `enrich.md`, and `/verify`'s and
 * `/adversarial-review`'s `reports/` files) -- the same distinction the
 * workflow templates themselves already draw.
 */
export async function summarizeChangeArtifacts(changeRoot: string): Promise<ChangeArtifactSummary> {
  const explorePresent = existsSync(join(changeRoot, "explore.md"));
  const enrichPath = join(changeRoot, "enrich.md");
  const enrichPresent = existsSync(enrichPath);
  const enrichStatus = enrichPresent ? await readEnrichStatus(enrichPath) : undefined;

  const [specs, reports] = await Promise.all([
    listDirectoryNames(join(changeRoot, "specs"), "directory"),
    listDirectoryNames(join(changeRoot, "reports"), "file"),
  ]);

  return {
    explore: { present: explorePresent },
    enrich: { present: enrichPresent, ...(enrichStatus ? { status: enrichStatus } : {}) },
    proposal: { present: existsSync(join(changeRoot, "proposal.md")) },
    design: { present: existsSync(join(changeRoot, "design.md")) },
    tasks: { present: existsSync(join(changeRoot, "tasks.md")) },
    specs,
    reports,
  };
}

/** Renders a `ChangeArtifactSummary` as a single compact line, e.g. `explore ✓  enrich ✓ (ready)  proposal ✓  design ✓  tasks ✗  specs (2: billing, auth)`. Used by `ce status`; the workflow templates use the same convention in their own prose. */
export function formatArtifactChecklist(summary: ChangeArtifactSummary): string {
  const mark = (p: ArtifactPresence) => (p.present ? "✓" : "✗");
  const parts = [
    `explore ${mark(summary.explore)}`,
    `enrich ${mark(summary.enrich)}${summary.enrich.status ? ` (${summary.enrich.status})` : ""}`,
    `proposal ${mark(summary.proposal)}`,
    `design ${mark(summary.design)}`,
    `tasks ${mark(summary.tasks)}`,
  ];
  if (summary.specs.length > 0) {
    parts.push(`specs (${summary.specs.length}: ${summary.specs.join(", ")})`);
  }
  if (summary.reports.length > 0) {
    parts.push(`reports (${summary.reports.length})`);
  }
  return parts.join("  ");
}
