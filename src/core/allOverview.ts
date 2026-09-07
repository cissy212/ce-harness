import { join } from "node:path";
import {
  activeChangeRoot,
  listActiveChanges,
  listArchivedChanges,
  readTaskProgress,
  summarizeChangeArtifacts,
} from "./activeChange.js";
import { expectedDurableOpenSpecRoot } from "./openspecId.js";
import { listReviewReports } from "./reviewReports.js";
import { scanProjectIdentities } from "./projectIdentity.js";
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
 * Two data sources are unioned by project id:
 * 1. `scanProjectIdentities()` -- every durable store's own identity
 *    record, regardless of whether any workspace for it currently exists
 *    on disk.
 * 2. `listWorkspaces()`, each resolved to its trusted OpenSpec metadata
 *    (if any) -- covers a workspace whose durable store predates this
 *    scan somehow being out of sync, and is also how preserved
 *    workspaces get attached to the right project entry.
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

export interface ProjectOverview {
  /** `null` covers the fallback grouping below -- a real project entry always has one. */
  projectId: string;
  /** Most human-recognizable label available: the latest identity evidence's recorded project name. */
  label: string;
  workspaces: WorkspaceOverview[];
  activeChanges: ActiveChangeOverview[];
  archivedCount: number;
  /** Up to 3 most-recently-archived change names, most recent first. */
  recentArchived: string[];
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

async function summarizeProjectChanges(durableRoot: string): Promise<{
  activeChanges: ActiveChangeOverview[];
  archivedCount: number;
  recentArchived: string[];
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

  return {
    activeChanges,
    archivedCount: archived.length,
    recentArchived: archived.slice(0, 3).map((a) => a.name),
    reviewCount: reviews.length,
  };
}

export async function buildAllOverview(): Promise<AllOverview> {
  const [pointers, activePointer, identities] = await Promise.all([
    listWorkspaces(),
    readActivePointer(),
    scanProjectIdentities(),
  ]);

  const projectsById = new Map<string, ProjectOverview>();

  // Seed every known durable project first, so one with zero currently
  // preserved workspaces still appears.
  await Promise.all(
    identities.map(async (identity) => {
      const label = identity.evidence[identity.evidence.length - 1].project;
      const durableRoot = expectedDurableOpenSpecRoot(identity.projectId);
      const changes = await summarizeProjectChanges(durableRoot);
      projectsById.set(identity.projectId, {
        projectId: identity.projectId,
        label,
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

    if (trusted?.durable && trusted.projectId) {
      const existing = projectsById.get(trusted.projectId);
      const entry: WorkspaceOverview = { issue: workspace.issue, sanitizedIssue: pointer.sanitizedIssue, isDefault };
      if (existing) {
        existing.workspaces.push(entry);
        // A workspace's own project label (its repo folder's current
        // basename) is often more current/recognizable than a possibly
        // older identity-evidence label -- prefer it once we have one.
        existing.label = workspace.project;
      } else {
        const durableRoot = trusted.root;
        const changes = await summarizeProjectChanges(durableRoot);
        projectsById.set(trusted.projectId, {
          projectId: trusted.projectId,
          label: workspace.project,
          workspaces: [entry],
          ...changes,
        });
      }
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
