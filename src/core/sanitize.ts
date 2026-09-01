import { basename } from "node:path";
import { CeError } from "./errors.js";

/**
 * Reduces an arbitrary string to a token that is safe to use as a single
 * path segment (directory/file name) and as a Git branch-name component.
 *
 * Rules:
 *  - lowercased
 *  - any character outside [a-z0-9._-] becomes '-'
 *  - runs of '-' collapse to a single '-'
 *  - leading/trailing '-' and '.' are stripped
 *  - any remaining ".." sequence (path traversal) is neutralized
 *  - result is capped to 100 characters
 */
function toSafeSegment(input: string, label: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new CeError(
      `${label} must not be empty.`,
      `Provide a non-empty ${label.toLowerCase()}.`,
    );
  }

  let safe = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");

  // Neutralize any leftover path-traversal sequences.
  while (safe.includes("..")) {
    safe = safe.replace(/\.\.+/g, ".");
  }

  safe = safe.slice(0, 100);

  if (safe.length === 0) {
    throw new CeError(
      `${label} "${input}" contains no characters usable in a directory or branch name.`,
      `Use a ${label.toLowerCase()} that includes at least one letter, number, dot, dash, or underscore.`,
    );
  }

  return safe;
}

/** Sanitizes an issue identifier so it is safe for directory and branch names. */
export function sanitizeIssue(issue: string): string {
  return toSafeSegment(issue, "Issue identifier");
}

/** Derives and sanitizes the project name from a resolved repository root path. */
export function deriveProjectName(repoRoot: string): string {
  const name = basename(repoRoot);
  return toSafeSegment(name, "Project name");
}

export interface WorkspaceSelector {
  project: string;
  sanitizedIssue: string;
}

/**
 * Parses a `<project>/<issue>` workspace selector -- e.g. as typed to
 * `ce resume market-audit-tool/130` to address a specific, non-default
 * workspace (see core/workspace.ts's `ActivePointer` doc comment for
 * the "many workspaces, one default" model this supports). The issue
 * half is sanitized exactly like `ce start` sanitizes it, so a selector
 * copy-pasted from `ce status`'s output and one typed by hand both
 * resolve to the same on-disk directory. The project half is matched
 * exactly as shown by `ce status` -- never re-derived or re-sanitized
 * here (unlike `deriveProjectName`, which only applies when deriving a
 * project name fresh from a repository path, not when matching one a
 * user already typed).
 */
export function parseWorkspaceSelector(selector: string): WorkspaceSelector {
  const separatorIndex = selector.indexOf("/");
  const project = separatorIndex === -1 ? "" : selector.slice(0, separatorIndex).trim();
  const issue = separatorIndex === -1 ? "" : selector.slice(separatorIndex + 1).trim();
  if (project.length === 0 || issue.length === 0) {
    throw new CeError(
      `Invalid workspace selector "${selector}" -- expected the form <project>/<issue>.`,
      'e.g. "market-audit-tool/130". Run `ce status` to see available workspaces.',
    );
  }
  return { project, sanitizedIssue: sanitizeIssue(issue) };
}
