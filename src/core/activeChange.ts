import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { parseTaskProgress } from "./workflowStatus.js";

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

/**
 * Filename of the small, ce-harness-owned sidecar `/propose` writes into
 * a change directory right after creating it, recording which workspace
 * (`project` + `issue`, matching `workspace.project`/`workspace.issue`
 * exactly -- the same values `CE_PROJECT`/`CE_ISSUE` are set to for the
 * runner session, see core/launchEnv.ts) is durably associated with that
 * change. A dotfile so it's never mistaken for one of OpenSpec's own
 * schema artifacts and never shows up in `summarizeChangeArtifacts`'s
 * checklist -- ce-harness bookkeeping, exactly like `explore.md`/
 * `enrich.md` are ce-harness content, just not human-facing.
 */
export const CHANGE_OWNERSHIP_FILENAME = ".ce-workspace.yml";

export interface ChangeOwnership {
  project: string;
  issue: string;
}

/**
 * Best-effort read of a change's ownership sidecar. Never throws: a
 * missing file (every change created before this mechanism existed, or
 * one proposed by hand outside `/propose`) or an unreadable/malformed
 * one just yields `null` -- "no known owner", not an error -- so callers
 * degrade to today's un-narrowed behavior rather than crash.
 */
export async function readChangeOwnership(changeRoot: string): Promise<ChangeOwnership | null> {
  try {
    const raw = await readFile(join(changeRoot, CHANGE_OWNERSHIP_FILENAME), "utf8");
    const parsed = parse(raw) as Record<string, unknown> | null;
    if (typeof parsed?.project === "string" && typeof parsed?.issue === "string") {
      return { project: parsed.project, issue: parsed.issue };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Narrows `listActiveChanges(durableRoot)` down to the change(s) this
 * exact workspace should see -- `ce open --change`'s and `ce status`'s
 * fix for the ambiguity a project with more than one workspace, each
 * with its own active change, hits: the durable OpenSpec store is
 * shared across every workspace for the same project, so an un-narrowed
 * `listActiveChanges` result can't tell which change belongs to which
 * workspace on its own.
 *
 * Three-tier resolution, applied in order:
 * 1. Any change whose sidecar (see above) names exactly this
 *    `(project, issue)` -- returned as soon as at least one exists.
 * 2. Otherwise, every candidate with *no* ownership sidecar at all
 *    (untagged/legacy -- created before this mechanism existed, or by
 *    hand outside `/propose`). Zero, one, or several of these are all
 *    returned as-is -- zero stays `[]`, one is the unambiguous legacy
 *    answer, and several preserve today's existing "pick one" ambiguity
 *    for the caller's own 0/1/many handling to resolve, exactly as
 *    before this mechanism existed.
 * 3. A change whose sidecar names a *different* workspace is never
 *    returned here, in either tier -- narrowing must never let one
 *    workspace's change leak into another's result. This is also what
 *    keeps a legacy workspace usable even after a different, newer
 *    workspace in the same project starts tagging its own changes: the
 *    legacy workspace still finds its own untagged change in tier 2,
 *    it just no longer sees the other workspace's tagged one in tier 1.
 */
export async function resolveActiveChangesForWorkspace(
  durableRoot: string,
  project: string,
  issue: string,
): Promise<string[]> {
  const all = await listActiveChanges(durableRoot);
  const owned: string[] = [];
  const unowned: string[] = [];
  for (const name of all) {
    const ownership = await readChangeOwnership(activeChangeRoot(durableRoot, name));
    if (!ownership) {
      unowned.push(name);
    } else if (ownership.project === project && ownership.issue === issue) {
      owned.push(name);
    }
  }
  return owned.length > 0 ? owned : unowned;
}

export interface ArchivedChangeInfo {
  /** The bare change name, with the `YYYY-MM-DD-` archive-date prefix stripped. */
  name: string;
  /** The archive directory's own name, e.g. `2026-09-02-addressbook-email-notes`. */
  archiveDirName: string;
}

const ARCHIVE_DIR_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

/**
 * Lists this durable store's archived changes, most-recently-archived
 * first (the archive dir name's date prefix sorts chronologically, so a
 * reverse lexicographic sort gives most-recent-first directly). Never
 * throws: a missing `openspec/changes/archive/` directory (nothing
 * archived yet) is reported as an empty list, matching
 * `listActiveChanges`'s tolerant-of-absence convention.
 */
export async function listArchivedChanges(durableRoot: string): Promise<ArchivedChangeInfo[]> {
  const archiveDir = join(durableRoot, "openspec", "changes", "archive");
  try {
    const entries = await readdir(archiveDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        archiveDirName: entry.name,
        name: entry.name.replace(ARCHIVE_DIR_DATE_PREFIX, ""),
      }))
      .sort((a, b) => b.archiveDirName.localeCompare(a.archiveDirName));
  } catch {
    return [];
  }
}

/**
 * The archived change most recently archived by *this exact workspace*
 * (`project` + `issue`, via the same `.ce-workspace.yml` ownership
 * sidecar `resolveActiveChangesForWorkspace` reads -- `mv`ing a change
 * directory into `archive/` at `/archive` time carries the sidecar along
 * with everything else, so it needs no separate archival step of its
 * own). Used by `ce publish` to find the change to derive a publish
 * branch name and PR content from, without requiring the caller to
 * already know its name.
 *
 * Returns null when no archived change is owned by this workspace --
 * either nothing has been archived yet, every archived change predates
 * the ownership mechanism (legacy), or every one belongs to a different
 * workspace. `ce publish` degrades gracefully in that case (an
 * issue-only branch name, PR content derived straight from the diff)
 * rather than guessing which archived change to attribute the publish
 * to.
 */
export async function resolveArchivedChangeForWorkspace(
  durableRoot: string,
  project: string,
  issue: string,
): Promise<{ name: string; changeRoot: string } | null> {
  const archived = await listArchivedChanges(durableRoot);
  for (const entry of archived) {
    const changeRoot = join(durableRoot, "openspec", "changes", "archive", entry.archiveDirName);
    const ownership = await readChangeOwnership(changeRoot);
    if (ownership && ownership.project === project && ownership.issue === issue) {
      return { name: entry.name, changeRoot };
    }
  }
  return null;
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

/**
 * Best-effort read of a change's `tasks.md`, parsed into a checkbox
 * completion count (see `core/workflowStatus.ts`'s `parseTaskProgress`).
 * Never throws: a missing file, or one with no recognizable checkboxes
 * at all, both yield `null` -- "no task-progress signal available", not
 * an error.
 */
export async function readTaskProgress(tasksPath: string): Promise<{ completed: number; total: number } | null> {
  try {
    const content = await readFile(tasksPath, "utf8");
    return parseTaskProgress(content);
  } catch {
    return null;
  }
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
