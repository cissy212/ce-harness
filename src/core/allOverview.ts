import { join } from "node:path";
import {
  activeChangeRoot,
  archivedChangeRoot,
  listActiveChanges,
  listArchivedChanges,
  readChangeOwnership,
  readTaskProgress,
  summarizeChangeArtifacts,
} from "./activeChange.js";
import { resolveKnownProjects } from "./knownProjects.js";
import { listReviewReports } from "./reviewReports.js";
import { formatProgressLine } from "./workflowStatus.js";
import { listWorkspaces, readActivePointer, readWorkspace, resolveTrustedOpenSpec } from "./workspace.js";

/**
 * Backs `ce status --all`: "what projects and work has ce-harness
 * retained", across *durable* project knowledge (survives `ce cleanup`),
 * not just workspace directories currently on disk (which are ephemeral
 * -- see workspace.ts's own doc comments). A project with zero currently
 * preserved workspaces but a durable OpenSpec store full of archived
 * changes is exactly the case this must not silently omit.
 *
 * Which projects exist, and what each is currently called, comes from
 * `core/knownProjects.ts`'s `resolveKnownProjects` -- shared with `ce
 * library` so the two can never disagree about a project's label. This
 * module only adds the per-project *content* on top: preserved
 * workspaces, active changes, archived-change history, and review
 * counts.
 *
 * A workspace that resolves to no durable, project-id-keyed store at all
 * (a legacy or non-OpenSpec workspace) is reported separately, never
 * silently dropped and never forced into a project entry it doesn't
 * durably belong to.
 *
 * Deliberately avoids calling the `openspec` binary at all (unlike the
 * default/`--verbose` single-workspace view's health check) -- `--all`
 * can enumerate several projects, and a per-project `openspec store
 * doctor` shell-out would make it noticeably slower for something whose
 * entire point is a fast, compact overview.
 */

export interface ActiveChangeOverview {
  name: string;
  progressLine: string;
}

export interface WorkspaceOverview {
  issue: string;
  sanitizedIssue: string;
  isDefault: boolean;
}

export interface ArchivedChangeOverview {
  name: string;
  /**
   * The original issue/workspace identifier this change was archived
   * under (`workspace.issue`, from the `.ce-workspace.yml` ownership
   * sidecar `/propose` writes and `/archive` carries along into
   * `archive/` unchanged -- see activeChange.ts's `readChangeOwnership`).
   * `null` -- never guessed or inferred from the change's own name --
   * for a change archived before that sidecar existed.
   */
  issue: string | null;
}

export interface ProjectOverview {
  /** `null` covers the fallback grouping below -- a real project entry always has one. */
  projectId: string;
  /** Most human-recognizable label available: the latest identity evidence's recorded project name. */
  label: string;
  workspaces: WorkspaceOverview[];
  activeChanges: ActiveChangeOverview[];
  archivedCount: number;
  /** Up to 3 most-recently-archived changes, most recent first, with their original issue identifier when known. */
  recentArchived: ArchivedChangeOverview[];
  reviewCount: number;
}

export interface UnresolvedWorkspace {
  project: string;
  sanitizedIssue: string;
  issue: string;
  isDefault: boolean;
}

export interface AllOverview {
  projects: ProjectOverview[];
  /** Preserved workspaces with no resolvable durable, project-id-keyed store (legacy or none at all). */
  unresolved: UnresolvedWorkspace[];
}

/** How many most-recently-archived changes `--all` shows per project -- kept small so this stays a compact overview, not a full archive listing. */
const RECENT_ARCHIVED_LIMIT = 3;

async function summarizeProjectChanges(durableRoot: string): Promise<{
  activeChanges: ActiveChangeOverview[];
  archivedCount: number;
  recentArchived: ArchivedChangeOverview[];
  reviewCount: number;
}> {
  const [activeNames, archived, reviews] = await Promise.all([
    listActiveChanges(durableRoot),
    listArchivedChanges(durableRoot),
    listReviewReports(durableRoot),
  ]);

  const activeChanges = await Promise.all(
    activeNames.map(async (name) => {
      const changeRoot = activeChangeRoot(durableRoot, name);
      const [summary, taskProgress] = await Promise.all([
        summarizeChangeArtifacts(changeRoot),
        readTaskProgress(join(changeRoot, "tasks.md")),
      ]);
      return { name, progressLine: formatProgressLine(summary, taskProgress) };
    }),
  );

  // Only the entries actually shown need their ownership sidecar read --
  // reading it for every archived change would scale badly for a project
  // with a long history, working against the "fast, compact overview"
  // goal for something whose whole point is staying lightweight.
  const recentArchived = await Promise.all(
    archived.slice(0, RECENT_ARCHIVED_LIMIT).map(async (entry) => {
      const ownership = await readChangeOwnership(archivedChangeRoot(durableRoot, entry.archiveDirName));
      return { name: entry.name, issue: ownership?.issue ?? null };
    }),
  );

  return {
    activeChanges,
    archivedCount: archived.length,
    recentArchived,
    reviewCount: reviews.length,
  };
}

export async function buildAllOverview(): Promise<AllOverview> {
  const [pointers, activePointer, knownProjects] = await Promise.all([
    listWorkspaces(),
    readActivePointer(),
    resolveKnownProjects(),
  ]);

  const projectsById = new Map<string, ProjectOverview>();

  // Seed every known durable project first (label and durable root
  // already resolved), so one with zero currently preserved workspaces
  // still appears.
  await Promise.all(
    knownProjects.map(async (known) => {
      const changes = await summarizeProjectChanges(known.durableRoot);
      projectsById.set(known.projectId, {
        projectId: known.projectId,
        label: known.label,
        workspaces: [],
        ...changes,
      });
    }),
  );

  const unresolved: UnresolvedWorkspace[] = [];

  for (const pointer of pointers) {
    let workspace;
    try {
      workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);
    } catch {
      // Corrupted/unreadable workspace.yml -- never aborts the overview
      // for every other project; simply contributes nothing here.
      continue;
    }

    const isDefault =
      activePointer?.project === pointer.project && activePointer?.sanitizedIssue === pointer.sanitizedIssue;
    const trusted = resolveTrustedOpenSpec(workspace);

    // `resolveKnownProjects` already unioned every durable, trusted
    // workspace's project id above, so `existing` is always found here
    // when `trusted` resolves at all -- this only ever attaches the
    // workspace entry, never re-decides the label (that decision lives
    // solely in knownProjects.ts, so it can never drift from what it
    // resolved).
    const existing = trusted?.durable && trusted.projectId ? projectsById.get(trusted.projectId) : undefined;
    if (existing) {
      existing.workspaces.push({ issue: workspace.issue, sanitizedIssue: pointer.sanitizedIssue, isDefault });
    } else {
      unresolved.push({
        project: pointer.project,
        sanitizedIssue: pointer.sanitizedIssue,
        issue: workspace.issue,
        isDefault,
      });
    }
  }

  const projects = [...projectsById.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const project of projects) {
    project.workspaces.sort((a, b) => a.sanitizedIssue.localeCompare(b.sanitizedIssue));
  }
  unresolved.sort((a, b) => a.project.localeCompare(b.project) || a.sanitizedIssue.localeCompare(b.sanitizedIssue));

  return { projects, unresolved };
}
