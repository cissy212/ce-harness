import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
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
 * Resolves symlinks for the closest existing ancestor of `target` and
 * reattaches any non-existent trailing segments, so paths that don't
 * exist yet can still be validated safely.
 */
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
