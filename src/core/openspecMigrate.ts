import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { CeError } from "./errors.js";
import { readOriginOrSolitaryRemoteUrl, resolveRootCommit } from "./git.js";
import { expectedDurableOpenSpecRoot, generateProjectStoreId } from "./openspecId.js";
import { describeOpenSpecStatus, setupStore, storeDoctor, unregisterStore } from "./openspec.js";
import { resolveProjectIdentity, writeIdentityRecord } from "./projectIdentity.js";
import { resolveTrustedOpenSpec, writeWorkspace, type Workspace } from "./workspace.js";

/**
 * Explicit, opt-in migration of a workspace's legacy, per-workspace
 * OpenSpec store (created before durable storage existed -- see
 * WorkspaceSchema's `openSpec.durable`) onto this project's durable,
 * project-scoped store. Never runs implicitly from `ce start`/`ce
 * cleanup`: an existing active workspace must not change behavior just
 * because the CLI was upgraded underneath it.
 *
 * The legacy store's files are never deleted or modified by this
 * function -- only ever read and copied. If anything about the copy or
 * the destination can't be safely reconciled, this throws instead of
 * guessing, leaving both the source and any partial destination state
 * exactly as a human left them.
 */
export interface MigrateOpenSpecOptions {
  /** --project-id: attach to this already-known project id explicitly. */
  projectId?: string;
  /** --new-project: mint a fresh project id regardless of any match/candidate. */
  newProject?: boolean;
}

export interface MigrateOpenSpecResult {
  /**
   * "already-durable": no-op, this workspace already points at a durable
   * store on the current (Project-Identity) scheme. "migrated": the
   * workspace now points at the durable, project-id-keyed store
   * (freshly created, or an already-matching one that was reused
   * as-is) -- covers both a legacy per-workspace store and a durable
   * store still on the pre-Project-Identity, path-hash-keyed shape.
   */
  status: "already-durable" | "migrated";
  storeId: string;
  root: string;
  /** Only set for status "migrated" -- the old store's root, left on disk. */
  sourceRoot?: string;
  /**
   * Only set for status "migrated", and only when unregistering the OLD
   * store's id (see below) failed. The migration itself still succeeded
   * -- this is surfaced so the caller can warn, not to indicate failure.
   */
  oldStoreUnregisterWarning?: string;
}

const IGNORE_STORE_METADATA_DIR = ".openspec-store";

/**
 * Migrates the active workspace's OpenSpec store onto the current,
 * durable, Project-Identity-keyed scheme (core/projectIdentity.ts). Two
 * source shapes are recognized and both migrate the same way from here
 * on: a legacy, per-workspace store (pre-durable-storage), and a
 * durable store still on the pre-Project-Identity, path-hash-keyed
 * shape (`openSpec.durable` true but no `projectId` -- see
 * generateLegacyProjectStoreId). Only a workspace already on the
 * current scheme is a no-op.
 *
 * `options` mirrors `ce start`'s `--project-id`/`--new-project`: Project
 * Identity resolution (resolveProjectIdentity) refuses outright, rather
 * than guessing, on an ambiguous CANDIDATE or CONFLICT match -- there is
 * no interactive-prompt infrastructure in ce-harness -- so a caller must
 * re-run with one of these set to resolve it explicitly.
 */
export async function migrateOpenSpecStore(
  workspace: Workspace,
  options: MigrateOpenSpecOptions = {},
): Promise<MigrateOpenSpecResult> {
  const trusted = resolveTrustedOpenSpec(workspace);
  if (!trusted) {
    throw new CeError(
      "The active workspace has no valid OpenSpec store to migrate.",
      workspace.openSpec
        ? "Its persisted OpenSpec metadata does not match this workspace (workspace.yml may be corrupted or tampered) and was ignored."
        : "This workspace was never provisioned with an OpenSpec store.",
    );
  }

  if (trusted.durable && trusted.projectId !== undefined) {
    return { status: "already-durable", storeId: trusted.storeId, root: trusted.root };
  }

  const sourceRoot = trusted.root;
  if (!existsSync(sourceRoot)) {
    throw new CeError(
      `This workspace's OpenSpec store root does not exist on disk ("${sourceRoot}").`,
      "There is nothing to migrate. If this is unexpected, inspect the workspace directly.",
    );
  }

  const originUrl = await readOriginOrSolitaryRemoteUrl(workspace.repositoryPath);
  const rootCommit = await resolveRootCommit(workspace.repositoryPath);
  const identityResolution = await resolveProjectIdentity({
    project: workspace.project,
    originUrl,
    rootCommit,
    explicitProjectId: options.projectId,
    mintNew: options.newProject,
  });
  const projectId = identityResolution.projectId;

  const destStoreId = generateProjectStoreId(projectId);
  const destRoot = expectedDurableOpenSpecRoot(projectId);
  const cwd = workspace.workspacePath;

  if (existsSync(destRoot)) {
    await reconcileExistingDestination(cwd, sourceRoot, destStoreId, destRoot);
  } else {
    await performFreshMigration(cwd, sourceRoot, destStoreId, destRoot);
  }

  // Persist (or extend) this project's identity record only now that
  // the destination store is confirmed present and healthy -- mirrors
  // `ce start`'s own ordering (core/commands/start.ts). null for a
  // plain "match": evidence for exactly these signals is already on
  // file.
  if (identityResolution.recordToPersist) {
    await writeIdentityRecord(destRoot, identityResolution.recordToPersist);
  }

  await writeWorkspace({
    ...workspace,
    openSpec: { storeId: destStoreId, root: destRoot, durable: true, projectId },
  });

  // The old store's *files* are never touched (per this module's whole
  // contract), but its *registration* now serves no purpose and, left in
  // place, becomes a trap: a later `ce cleanup` of this same workspace
  // still deletes `<workspacePath>/openspec` (the old store's root, which
  // remains physically nested inside the workspace directory) as part of
  // removing the workspace -- at which point the registry entry would be
  // left dangling, pointing at a path that no longer exists. Unregistering
  // it now, only after the new store is fully verified and persisted,
  // closes that gap. Best-effort: if it fails, the migration itself still
  // fully succeeded (the durable copy is already verified), so this is
  // surfaced as a warning, never a thrown error.
  let oldStoreUnregisterWarning: string | undefined;
  try {
    const unregisterResult = await unregisterStore(cwd, trusted.storeId);
    if (!unregisterResult.success && !unregisterResult.notFound) {
      oldStoreUnregisterWarning =
        `Failed to unregister the old store "${trusted.storeId}" from OpenSpec's registry: ` +
        `${describeOpenSpecStatus(unregisterResult)}. Its files were left ` +
        `untouched; run \`openspec store unregister ${trusted.storeId}\` yourself once you're ready.`;
    }
  } catch (error) {
    oldStoreUnregisterWarning = `Failed to unregister the old store "${trusted.storeId}": ${(error as Error).message}.`;
  }

  return {
    status: "migrated",
    storeId: destStoreId,
    root: destRoot,
    sourceRoot,
    ...(oldStoreUnregisterWarning ? { oldStoreUnregisterWarning } : {}),
  };
}

/**
 * Handles the case where this project's durable path is already
 * occupied -- e.g. a later workspace for the same project already
 * created the durable store, or an earlier migration attempt partially
 * completed. Never overwrites or merges: if the destination is missing
 * or diverges from anything the source has, this throws with an
 * itemized description rather than guessing which side should win.
 */
async function reconcileExistingDestination(
  cwd: string,
  sourceRoot: string,
  destStoreId: string,
  destRoot: string,
): Promise<void> {
  const diff = await diffTrees(sourceRoot, destRoot, [IGNORE_STORE_METADATA_DIR]);
  if (diff.onlyInA.length > 0 || diff.differing.length > 0) {
    const lines = [
      `A durable OpenSpec store already exists at "${destRoot}", but its content does not safely ` +
        `reconcile with this workspace's store at "${sourceRoot}".`,
    ];
    if (diff.onlyInA.length > 0) {
      lines.push(`  Present only in "${sourceRoot}": ${diff.onlyInA.join(", ")}`);
    }
    if (diff.differing.length > 0) {
      lines.push(`  Different content in both: ${diff.differing.join(", ")}`);
    }
    throw new CeError(
      lines.join("\n"),
      "Resolve this manually (e.g. copy the missing/differing files into the durable store yourself), " +
        "then re-run `ce migrate-openspec`. Neither store was modified.",
    );
  }

  // Every file the source has is already present, byte-identical, at the
  // destination -- safe to treat as already migrated. Only require that
  // the destination is actually a healthy, registered store before
  // pointing this workspace at it.
  const doctor = await storeDoctor(cwd, destStoreId);
  if (!doctor.found || !doctor.healthy) {
    throw new CeError(
      `The durable path "${destRoot}" already contains this workspace's data, but is not a healthy, ` +
        `registered OpenSpec store (id "${destStoreId}").`,
      `Inspect it directly, e.g. \`openspec store doctor ${destStoreId}\`.`,
    );
  }
}

/**
 * Performs a from-scratch migration: stages a verified copy of the
 * source in a scratch directory first (so a failure or interruption
 * during the copy itself never creates or registers anything at
 * `destRoot`), then creates the real durable store fresh and overlays
 * the staged content onto it -- never copying the source's own
 * `.openspec-store/` metadata (which embeds the *old* store id) over the
 * newly-created store's own registration metadata.
 */
async function performFreshMigration(
  cwd: string,
  sourceRoot: string,
  destStoreId: string,
  destRoot: string,
): Promise<void> {
  const stagingRoot = `${destRoot}.migrating`;
  await rm(stagingRoot, { recursive: true, force: true });

  try {
    await mkdir(dirname(destRoot), { recursive: true });
    await cp(sourceRoot, stagingRoot, { recursive: true });

    const stagingDiff = await diffTrees(sourceRoot, stagingRoot, []);
    if (stagingDiff.onlyInA.length > 0 || stagingDiff.onlyInB.length > 0 || stagingDiff.differing.length > 0) {
      throw new CeError(
        `Staging a copy of the OpenSpec store from "${sourceRoot}" produced an unexpected mismatch.`,
        "The source was not modified. This is unexpected -- please report it.",
      );
    }

    const setupResult = await setupStore(cwd, destStoreId, destRoot);
    if (!setupResult.success) {
      throw new CeError(
        `Failed to create the durable OpenSpec store "${destStoreId}" at "${destRoot}": ` +
          describeOpenSpecStatus(setupResult),
      );
    }

    const freshDoctor = await storeDoctor(cwd, destStoreId);
    if (!freshDoctor.found || !freshDoctor.healthy) {
      throw new CeError(
        `The newly created durable OpenSpec store "${destStoreId}" failed its health check: ` +
          describeOpenSpecStatus(freshDoctor),
      );
    }

    await cp(stagingRoot, destRoot, {
      recursive: true,
      force: true,
      filter: (source: string) => {
        const rel = relative(stagingRoot, source);
        return rel !== IGNORE_STORE_METADATA_DIR && !rel.startsWith(`${IGNORE_STORE_METADATA_DIR}${sep}`);
      },
    });

    const finalDiff = await diffTrees(sourceRoot, destRoot, [IGNORE_STORE_METADATA_DIR]);
    if (finalDiff.onlyInA.length > 0 || finalDiff.differing.length > 0) {
      throw new CeError(
        `Migration copy to "${destRoot}" completed, but final verification found a mismatch against ` +
          `the source at "${sourceRoot}" (which was left untouched): ` +
          [
            finalDiff.onlyInA.length > 0 ? `missing: ${finalDiff.onlyInA.join(", ")}` : "",
            finalDiff.differing.length > 0 ? `differing: ${finalDiff.differing.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; "),
        `Inspect "${destRoot}" directly before retrying.`,
      );
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

interface TreeDiff {
  /** Relative file paths present in `a` but not `b`. */
  onlyInA: string[];
  /** Relative file paths present in `b` but not `a`. */
  onlyInB: string[];
  /** Relative file paths present in both, with different byte content. */
  differing: string[];
}

/** Deep, byte-level comparison of two directory trees, ignoring any top-level entry named in `ignoreTopLevel`. */
async function diffTrees(a: string, b: string, ignoreTopLevel: string[]): Promise<TreeDiff> {
  const ignore = new Set(ignoreTopLevel);
  const [filesA, filesB] = await Promise.all([listFilesRelative(a, ignore), listFilesRelative(b, ignore)]);
  const setA = new Set(filesA);
  const setB = new Set(filesB);

  const onlyInA = filesA.filter((f) => !setB.has(f));
  const onlyInB = filesB.filter((f) => !setA.has(f));
  const common = filesA.filter((f) => setB.has(f));

  const differing: string[] = [];
  for (const rel of common) {
    const [bufA, bufB] = await Promise.all([readFile(join(a, rel)), readFile(join(b, rel))]);
    if (!bufA.equals(bufB)) differing.push(rel);
  }

  return { onlyInA, onlyInB, differing };
}

/** Every regular file under `root`, as paths relative to it, excluding any top-level entry in `ignoreTopLevel`. */
async function listFilesRelative(root: string, ignoreTopLevel: Set<string>): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = relative(root, join(entry.parentPath, entry.name));
    const topLevel = rel.split(sep)[0];
    if (ignoreTopLevel.has(topLevel)) continue;
    results.push(rel);
  }
  return results.sort();
}
