import { expectedDurableOpenSpecRoot } from "./openspecId.js";
import { scanProjectIdentities } from "./projectIdentity.js";
import { listWorkspaces, readWorkspace, resolveTrustedOpenSpec } from "./workspace.js";

/**
 * The single source of truth for "what is this durable project currently
 * called" -- shared by `ce status --all` (core/allOverview.ts) and `ce
 * library` (core/library.ts) so the two can never silently disagree about
 * a project's label. Previously this resolution lived only inside
 * `allOverview.ts`; extracted here, unchanged in behavior, once a second
 * consumer needed the exact same answer.
 *
 * Unions two sources, exactly as `allOverview.ts` always has:
 * 1. `scanProjectIdentities()` -- every durable store's own identity
 *    record, regardless of whether any workspace for it currently exists
 *    on disk. Its label is the latest recorded evidence's `project` field.
 * 2. `listWorkspaces()`, each resolved to its trusted OpenSpec metadata --
 *    a *live* workspace's own `.project` (its repository folder's current
 *    basename) is preferred over identity evidence once one exists, since
 *    evidence is only appended when a project's Git signals genuinely
 *    change (see core/projectIdentity.ts's `resolveProjectIdentity`) --
 *    a folder rename alone, with the same origin/root-commit, would
 *    otherwise leave the recorded label stale indefinitely.
 *
 * A workspace with no resolvable durable, project-id-keyed store at all
 * (legacy, or never OpenSpec-enabled) contributes nothing here -- it has
 * no project identity to attach a label to. Never throws: a corrupted or
 * unreadable workspace.yml simply contributes nothing, exactly like
 * `listWorkspaces`'s own tolerant-of-absence convention.
 */

export interface KnownProject {
  projectId: string;
  /** Most human-recognizable label currently available -- see this module's own doc comment for how it's chosen. Never guessed: always a real, previously-recorded project label. */
  label: string;
  /** `core/openspecId.ts`'s `expectedDurableOpenSpecRoot(projectId)` -- included so callers never need to recompute it. */
  durableRoot: string;
}

export async function resolveKnownProjects(): Promise<KnownProject[]> {
  const [identities, pointers] = await Promise.all([scanProjectIdentities(), listWorkspaces()]);

  const byId = new Map<string, KnownProject>();
  for (const identity of identities) {
    const label = identity.evidence[identity.evidence.length - 1].project;
    byId.set(identity.projectId, {
      projectId: identity.projectId,
      label,
      durableRoot: expectedDurableOpenSpecRoot(identity.projectId),
    });
  }

  for (const pointer of pointers) {
    let workspace;
    try {
      workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);
    } catch {
      continue;
    }

    const trusted = resolveTrustedOpenSpec(workspace);
    if (!trusted?.durable || !trusted.projectId) continue;

    const existing = byId.get(trusted.projectId);
    if (existing) {
      existing.label = workspace.project;
    } else {
      byId.set(trusted.projectId, { projectId: trusted.projectId, label: workspace.project, durableRoot: trusted.root });
    }
  }

  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}
