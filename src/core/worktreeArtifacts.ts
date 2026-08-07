import { relative } from "node:path";
import { resolveTrustedCodeGraph } from "./codeGraph.js";
import type { Workspace } from "./workspace.js";

/**
 * Distinguishes forbidden repository/harness artifacts (OpenSpec
 * stores, reports, commands, lenses, runner configuration -- never
 * created inside the target repository or its Git worktree) from
 * allowed ephemeral tool/build artifacts that some of the worktree's
 * own tooling legitimately produces inside itself (e.g. `node_modules/`,
 * build output, or a CodeGraph index ce-harness provisioned there).
 *
 * This module implements the second category's effect on worktree
 * "dirty" detection: `ce status` and `ce cleanup` must never let a
 * harness-managed ephemeral artifact register as a change a human needs
 * to review or would lose on cleanup. Crucially, this is never a
 * by-name exclusion ("always ignore `.codegraph/`") -- it only ever
 * excludes a path that the workspace's own cross-checked metadata
 * proves ce-harness created and owns in this exact workspace (see
 * `resolveTrustedCodeGraph`). A pre-existing `.codegraph/` the
 * repository itself tracks, or one a user created some other way, is
 * never excluded and always counts as a real change like any other.
 */

/**
 * Filters raw `git status --porcelain` lines down to the changes a
 * human should actually see, excluding only entries that fall under a
 * harness-managed ephemeral artifact this workspace is verified to own.
 * Tracked-file modifications are never affected -- only untracked
 * entries under a specifically owned directory can ever be excluded.
 */
export function filterHarnessManagedChanges(changes: string[], workspace: Workspace): string[] {
  const managedRelativePaths = harnessManagedRelativePaths(workspace);
  if (managedRelativePaths.length === 0) return changes;

  return changes.filter((line) => !matchesAnyManagedPath(line, managedRelativePaths));
}

function harnessManagedRelativePaths(workspace: Workspace): string[] {
  const paths: string[] = [];

  const codeGraph = resolveTrustedCodeGraph(workspace);
  if (codeGraph?.indexPath) {
    paths.push(relative(workspace.worktreePath, codeGraph.indexPath));
  }

  return paths;
}

function matchesAnyManagedPath(porcelainLine: string, managedRelativePaths: string[]): boolean {
  const path = porcelainLinePath(porcelainLine);
  if (path === null) return false;
  return managedRelativePaths.some((managed) => path === managed || path.startsWith(`${managed}/`));
}

/**
 * Extracts the path portion of a `git status --porcelain` line (the
 * two-character status code occupies columns 1-2, a space is column 3,
 * the path starts at column 4). Handles the `OLD -> NEW` rename format
 * by keeping only the new path, and strips a quoted-path wrapper if
 * present (git quotes paths containing unusual characters).
 */
function porcelainLinePath(line: string): string | null {
  if (line.length < 4) return null;
  let path = line.slice(3);

  const arrow = path.indexOf(" -> ");
  if (arrow !== -1) path = path.slice(arrow + 4);

  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    path = path.slice(1, -1);
  }

  return path;
}
