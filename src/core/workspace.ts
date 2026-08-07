import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { CeError } from "./errors.js";
import { activePointerFile, workspaceFile, workspacePath } from "./paths.js";
import { expectedOpenSpecRoot, generateStoreId, isValidStoreId } from "./openspecId.js";

export const OpenSpecMetadataSchema = z.object({
  storeId: z.string().min(1),
  root: z.string().min(1),
});

export type OpenSpecMetadata = z.infer<typeof OpenSpecMetadataSchema>;

/**
 * Optional semantic-code-navigation adapter state (CodeGraph today).
 * `available`/`managedByHarness` are independent flags: this
 * implementation only ever sets `available: true` when
 * `managedByHarness` is also true (ce-harness never wires up navigation
 * for an index it did not create and cannot vouch for), but the schema
 * does not hard-couple them, in case a future adapter safely verifies a
 * pre-existing index without claiming ownership of it.
 */
export const CodeGraphMetadataSchema = z
  .object({
    available: z.boolean(),
    managedByHarness: z.boolean(),
    indexPath: z.string().min(1).optional(),
    initializedAt: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .refine((c) => !c.available || (c.indexPath !== undefined && c.initializedAt !== undefined), {
    message: "available CodeGraph metadata requires indexPath and initializedAt",
  });

export type CodeGraphMetadata = z.infer<typeof CodeGraphMetadataSchema>;

export const WorkspaceSchema = z
  .object({
    project: z.string().min(1),
    repositoryPath: z.string().min(1),
    issue: z.string().min(1),
    sanitizedIssue: z.string().min(1),
    baseBranch: z.string().min(1),
    internalBranch: z.string().min(1),
    worktreePath: z.string().min(1),
    workspacePath: z.string().min(1),
    createdAt: z.string().min(1),
    // Optional: older workspace files predate OpenSpec integration and
    // have no openSpec block. Readers must treat its absence as valid.
    openSpec: OpenSpecMetadataSchema.optional(),
    // Optional: only present when `ce start` was given an explicit
    // --base/--head review range instead of using the local main/master
    // tip. Resolved, immutable commit SHAs -- never raw refs. Absent on
    // every workspace created with the default flow, and on all
    // workspaces that predate this field.
    diffBase: z.string().min(1).optional(),
    diffHead: z.string().min(1).optional(),
    // Optional: the merge base of diffBase/diffHead at the time `ce
    // start` resolved them, persisted so `status` can show the exact
    // effective comparison point without recomputing it. Only ever set
    // together with diffBase/diffHead.
    diffMergeBase: z.string().min(1).optional(),
    // Optional: older workspace files predate the semantic-code-navigation
    // integration and have no codeGraph block. Readers must treat its
    // absence as valid, exactly like the openSpec block above.
    codeGraph: CodeGraphMetadataSchema.optional(),
  })
  .refine((w) => (w.diffBase === undefined) === (w.diffHead === undefined), {
    message: "diffBase and diffHead must both be present or both be absent",
  })
  .refine((w) => w.diffMergeBase === undefined || (w.diffBase !== undefined && w.diffHead !== undefined), {
    message: "diffMergeBase requires diffBase and diffHead to also be present",
  });

export type Workspace = z.infer<typeof WorkspaceSchema>;

const ActivePointerSchema = z.object({
  project: z.string().min(1),
  sanitizedIssue: z.string().min(1),
});

export type ActivePointer = z.infer<typeof ActivePointerSchema>;

export async function writeWorkspace(workspace: Workspace): Promise<void> {
  const file = workspaceFile(workspace.project, workspace.sanitizedIssue);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringify(workspace), "utf8");
}

export async function readWorkspace(project: string, sanitizedIssue: string): Promise<Workspace> {
  const file = workspaceFile(project, sanitizedIssue);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new CeError(
      `Workspace file not found at "${file}".`,
      "The workspace may have been removed manually; run `ce cleanup` to clear the active pointer.",
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new CeError(
      `Workspace file at "${file}" is not valid YAML: ${(error as Error).message}`,
    );
  }

  const result = WorkspaceSchema.safeParse(parsed);
  if (!result.success) {
    throw new CeError(
      `Workspace file at "${file}" is invalid: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      "Run `ce cleanup --force` to discard this workspace, then `ce start` again.",
    );
  }
  return result.data;
}

export function workspaceExistsOnDisk(project: string, sanitizedIssue: string): boolean {
  return existsSync(workspacePath(project, sanitizedIssue));
}

export async function removeWorkspaceDir(project: string, sanitizedIssue: string): Promise<void> {
  await rm(workspacePath(project, sanitizedIssue), { recursive: true, force: true });
}

export async function writeActivePointer(pointer: ActivePointer): Promise<void> {
  const file = activePointerFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringify(pointer), "utf8");
}

export async function readActivePointer(): Promise<ActivePointer | null> {
  const file = activePointerFile();
  if (!existsSync(file)) return null;

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new CeError(
      `Active workspace pointer at "${file}" is not valid YAML: ${(error as Error).message}`,
      "Run `ce cleanup --force` to reset harness state.",
    );
  }

  const result = ActivePointerSchema.safeParse(parsed);
  if (!result.success) {
    throw new CeError(
      `Active workspace pointer at "${file}" is invalid.`,
      "Run `ce cleanup --force` to reset harness state.",
    );
  }
  return result.data;
}

export async function clearActivePointer(): Promise<void> {
  await rm(activePointerFile(), { force: true });
}

/**
 * Returns the workspace's OpenSpec metadata only if it can be trusted,
 * or `null` otherwise (legacy workspace with no `openSpec` block, or a
 * workspace file whose `openSpec` block does not match what ce-harness
 * would itself have generated for this project/issue/repository).
 *
 * Treats persisted YAML as untrusted input: the persisted `storeId` and
 * `root` are only ever acted on (unregistered, displayed as healthy,
 * etc.) after being cross-checked against values deterministically
 * recomputed from the workspace's other trusted fields. This is what
 * prevents a corrupted or tampered workspace.yml from causing ce to
 * unregister or otherwise act on an unrelated OpenSpec store.
 */
export function resolveTrustedOpenSpec(workspace: Workspace): OpenSpecMetadata | null {
  const persisted = workspace.openSpec;
  if (!persisted) return null;

  if (!isValidStoreId(persisted.storeId)) return null;

  const expectedStoreId = generateStoreId(
    workspace.project,
    workspace.sanitizedIssue,
    workspace.repositoryPath,
  );
  const expectedRoot = expectedOpenSpecRoot(workspace.workspacePath);

  if (persisted.storeId !== expectedStoreId) return null;
  if (persisted.root !== expectedRoot) return null;

  return persisted;
}

export type WorkspaceType = "Implementation" | "Existing PR review";

/**
 * Whether this workspace is implementing an OpenSpec change (the default
 * flow) or reviewing an existing, already-given commit range (`ce start
 * --base --head`). Derived entirely from the existing `diffBase`/`diffHead`
 * fields -- the same ones that gate `CE_DIFF_BASE`/`CE_DIFF_HEAD` at
 * launch and the "Review base/head" fields in `ce status` -- so this
 * never introduces a second, separately-maintained source of truth for
 * the same fact.
 */
export function workspaceType(workspace: Workspace): WorkspaceType {
  return workspace.diffBase && workspace.diffHead ? "Existing PR review" : "Implementation";
}
