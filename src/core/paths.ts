import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readdir, realpath, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CeError } from "./errors.js";

/**
 * Root directory for all ce-harness runtime state. Defaults to
 * ~/.ce-harness but can be overridden with CE_HARNESS_HOME, which tests
 * use to guarantee they never touch the real user home directory.
 */
export function harnessHome(): string {
  const override = process.env.CE_HARNESS_HOME;
  return resolve(override && override.length > 0 ? override : join(homedir(), ".ce-harness"));
}

export function worktreesRoot(): string {
  return join(harnessHome(), "worktrees");
}

export function workspacesRoot(): string {
  return join(harnessHome(), "workspaces");
}

export function stateRoot(): string {
  return join(harnessHome(), "state");
}

export function worktreePath(project: string, sanitizedIssue: string): string {
  return join(worktreesRoot(), project, sanitizedIssue);
}

export function workspacePath(project: string, sanitizedIssue: string): string {
  return join(workspacesRoot(), project, sanitizedIssue);
}

export function workspaceFile(project: string, sanitizedIssue: string): string {
  return join(workspacePath(project, sanitizedIssue), "workspace.yml");
}

export function activePointerFile(): string {
  return join(stateRoot(), "active.yml");
}

/**
 * Guarantees `target` resolves to a real path located inside the
 * ce-harness runtime root. Used before every destructive filesystem
 * operation so that a corrupted or tampered state file can never cause
 * deletion of anything outside ~/.ce-harness (or its test override).
 *
 * Throws if the path escapes the root. Non-existent paths are checked
 * against their nearest existing ancestor.
 */
export async function assertInsideHarnessHome(target: string): Promise<void> {
  const root = harnessHome();
  const resolvedRoot = await safeRealpath(root);
  const resolvedTarget = await safeRealpath(target);

  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
    throw new CeError(
      `Refusing to delete "${target}" because it is not inside the ce-harness runtime directory (${root}).`,
      "This indicates corrupted or tampered state; inspect it manually before retrying.",
    );
  }
}

/**
 * Resolves symlinks/`..` segments for `target` where it exists, falling
 * back to plain path resolution otherwise. Exported so callers (e.g. the
 * cwd-inside-worktree guard) can compare canonical paths consistently
 * with the safety checks above.
 */
export async function resolveCanonical(target: string): Promise<string> {
  return safeRealpath(target);
}

/**
 * Resolves the current working directory to a canonical path, with a
 * clear error if it can no longer be read (e.g. it was deleted out from
 * under the process).
 */
export async function canonicalCwd(): Promise<string> {
  try {
    return await realpath(process.cwd());
  } catch (error) {
    throw new CeError(
      `Failed to resolve the current working directory: ${(error as Error).message}`,
      "cd into a directory that still exists and try again.",
    );
  }
}

/** True if `candidate` is exactly `ancestor`, or a descendant of it. */
export function isPathInside(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return true;
  const ancestorWithSep = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return candidate.startsWith(ancestorWithSep);
}

/**
 * Removes `dir` if (and only if) it resolves inside the harness runtime
 * root, is not one of the top-level runtime directories themselves, it
 * exists, and it is empty. Used to tidy up empty project-level
 * directories (e.g. worktrees/<project>) after the last issue under
 * that project has been cleaned up. Silently does nothing otherwise.
 */
export async function removeEmptyProjectDir(dir: string): Promise<void> {
  await assertInsideHarnessHome(dir);

  const resolvedDir = resolve(dir);
  const protectedTopLevelDirs = new Set([harnessHome(), worktreesRoot(), workspacesRoot(), stateRoot()]);
  if (protectedTopLevelDirs.has(resolvedDir)) {
    return;
  }

  if (!existsSync(resolvedDir)) {
    return;
  }

  const entries = await readdir(resolvedDir);
  if (entries.length > 0) {
    return;
  }

  await rmdir(resolvedDir);
}

async function safeRealpath(target: string): Promise<string> {
  let current = resolve(target);
  const trailing: string[] = [];

  while (!existsSync(current)) {
    const parent = resolve(current, "..");
    if (parent === current) {
      // Reached filesystem root without finding an existing ancestor.
      return resolve(target);
    }
    trailing.unshift(current.slice(parent.length).replace(/^[\\/]/, ""));
    current = parent;
  }

  const resolvedExisting = await realpath(current);
  return trailing.length > 0 ? join(resolvedExisting, ...trailing) : resolvedExisting;
}
