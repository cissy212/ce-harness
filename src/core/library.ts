import { existsSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { assertInsideHarnessHome, libraryRoot } from "./paths.js";
import { type KnownProject, resolveKnownProjects } from "./knownProjects.js";

/**
 * `ce library`: a human-readable, browsable projection over every known
 * project's durable OpenSpec store, organized by recognizable project
 * name instead of project id -- see `resolveKnownProjects` for where
 * that name comes from.
 *
 * This is deliberately *derived, not durable*: every entry under
 * `libraryRoot()` is a directory containing only symlinks into the real
 * durable stores under `openspecRoot()` -- never a copy of anything.
 * `rebuildLibrary` wipes and regenerates the whole tree on every call,
 * which is what keeps it always correct (a rename, a newly-created
 * project, a resolved label collision) with no incremental-consistency
 * bookkeeping of its own to maintain or get wrong. Deleting
 * `libraryRoot()` entirely, any time, is always safe and lossless --
 * the next `ce library` run reconstructs it identically from the
 * durable stores, which is the only authoritative source.
 *
 * A legacy durable store with no `.identity.yml` (see
 * `resolveKnownProjects`) has no authoritative label to show here, so it
 * is simply absent -- never guessed, never shown under an invented name.
 * `ce migrate-openspec` remains the documented way to give one an
 * identity and bring it into the library.
 */

/** How many hex characters of a project id to use as a disambiguating suffix when two or more projects currently resolve to the same label. Project ids are 12 hex characters (see openspecId.ts's generateProjectId); 8 is short enough to stay readable while being vanishingly unlikely to collide on its own. */
const COLLISION_SUFFIX_LENGTH = 8;

export interface LibraryEntry {
  projectId: string;
  /** The directory name actually used under `libraryRoot()` -- the project's label, or `<label>-<projectId prefix>` when disambiguated. */
  directoryName: string;
  durableRoot: string;
}

/**
 * Resolves every known project to the exact directory name it gets in
 * the library, disambiguating label collisions deterministically: *every*
 * project sharing a label gets suffixed (never just the second one
 * seen), so the mapping never depends on scan order and stays stable
 * across rebuilds.
 */
export function resolveLibraryEntries(knownProjects: KnownProject[]): LibraryEntry[] {
  const byLabel = new Map<string, KnownProject[]>();
  for (const project of knownProjects) {
    const group = byLabel.get(project.label);
    if (group) {
      group.push(project);
    } else {
      byLabel.set(project.label, [project]);
    }
  }

  const entries: LibraryEntry[] = [];
  for (const group of byLabel.values()) {
    const disambiguate = group.length > 1;
    for (const project of group) {
      entries.push({
        projectId: project.projectId,
        directoryName: disambiguate
          ? `${project.label}-${project.projectId.slice(0, COLLISION_SUFFIX_LENGTH)}`
          : project.label,
        durableRoot: project.durableRoot,
      });
    }
  }

  return entries.sort((a, b) => a.directoryName.localeCompare(b.directoryName));
}

/** Symlinks `target` at `linkPath` only if `target` actually exists -- the library only ever shows what's really there, never a placeholder for something absent. */
async function linkIfExists(target: string, linkPath: string): Promise<void> {
  if (!existsSync(target)) return;
  await symlink(target, linkPath, "dir");
}

export interface RebuildLibraryResult {
  root: string;
  entries: LibraryEntry[];
  /** Non-fatal per-project problems (e.g. a symlink that could not be created) -- one project failing never aborts the rest. */
  warnings: string[];
}

/**
 * Wipes and regenerates `libraryRoot()` from the current durable stores.
 * Safe by construction: `libraryRoot()` holds nothing but symlinks and
 * the directories that contain them, so removing it removes only those
 * links, never anything they point at (`fs.rm` never follows a symlink
 * to delete its target). `assertInsideHarnessHome` is the same guard
 * every other destructive filesystem operation in ce-harness already
 * uses before a recursive removal.
 */
export async function rebuildLibrary(): Promise<RebuildLibraryResult> {
  const root = libraryRoot();
  await assertInsideHarnessHome(root);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const knownProjects = await resolveKnownProjects();
  const entries = resolveLibraryEntries(knownProjects);
  const warnings: string[] = [];

  for (const entry of entries) {
    const projectDir = join(root, entry.directoryName);
    try {
      await mkdir(projectDir, { recursive: true });
      await linkIfExists(join(entry.durableRoot, "openspec", "changes"), join(projectDir, "changes"));
      await linkIfExists(join(entry.durableRoot, "openspec", "changes", "archive"), join(projectDir, "archive"));
      await linkIfExists(join(entry.durableRoot, "openspec", "specs"), join(projectDir, "specs"));
      await linkIfExists(join(entry.durableRoot, "reviews"), join(projectDir, "reviews"));
    } catch (error) {
      // One project's filesystem hiccup (e.g. a permissions error) never
      // aborts the rest of the rebuild.
      warnings.push(`Could not fully build the library entry for "${entry.directoryName}": ${(error as Error).message}`);
    }
  }

  return { root, entries, warnings };
}
