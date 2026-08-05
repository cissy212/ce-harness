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

export const WorkspaceSchema = z.object({
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
