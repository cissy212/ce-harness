import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Deterministic OpenSpec store identity.
 *
 * OpenSpec store IDs must be kebab-case: lowercase ASCII letters, digits,
 * and single hyphen separators (no leading/trailing hyphen, no doubled
 * hyphens, no dots/underscores/whitespace). See STORE_ID_PATTERN below.
 */
const STORE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Hard cap on generated store IDs, comfortably under any OpenSpec limit. */
const STORE_ID_MAX_LENGTH = 60;

/** Length of the repository-path hash suffix used to prevent collisions. */
const HASH_LENGTH = 8;

const PREFIX = "ce";

/** True if `id` is safe to pass to the OpenSpec CLI as a store id. */
export function isValidStoreId(id: string): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= STORE_ID_MAX_LENGTH &&
    STORE_ID_PATTERN.test(id)
  );
}

/** Reduces `input` to a kebab-case token: [a-z0-9] joined by single hyphens. */
function toKebabToken(input: string, fallback: string): string {
  const lowered = input.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "-");
  const collapsed = replaced.replace(/-{2,}/g, "-");
  const trimmed = collapsed.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Deterministic short hash of the canonical repository path. Included in
 * the store id so that two repositories that happen to share a basename
 * (e.g. "~/work/api" and "~/other/api") never collide, without ever
 * embedding the raw repository path itself in the id.
 */
function repositoryHash(repositoryPath: string): string {
  return createHash("sha256").update(repositoryPath).digest("hex").slice(0, HASH_LENGTH);
}

/**
 * Splits `budget` characters between `a` and `b`, truncating from the end
 * of whichever token(s) are too long, and never truncating below 1
 * character as long as budget allows. Trailing hyphens exposed by
 * truncation are stripped so the result stays valid kebab-case.
 */
function shareBudget(a: string, b: string, budget: number): [string, string] {
  if (a.length + b.length <= budget) return [a, b];

  const half = Math.floor(budget / 2);
  let aMax = half;
  let bMax = budget - half;
  if (a.length <= aMax) {
    bMax = budget - a.length;
  } else if (b.length <= bMax) {
    aMax = budget - b.length;
  }

  const stripTrailingHyphen = (s: string) => s.replace(/-+$/, "");
  const aTrunc = stripTrailingHyphen(a.slice(0, Math.max(aMax, 0)));
  const bTrunc = stripTrailingHyphen(b.slice(0, Math.max(bMax, 0)));
  return [aTrunc.length > 0 ? aTrunc : a.slice(0, 1), bTrunc.length > 0 ? bTrunc : b.slice(0, 1)];
}

/**
 * Generates a deterministic, safe OpenSpec store id for a workspace.
 *
 * Shape: `ce-<project>-<issue>-<repo-path-hash>`. Deterministic given the
 * same (project, sanitizedIssue, repositoryPath) triple, so it can always
 * be recomputed later (e.g. to validate persisted workspace metadata)
 * without trusting a stored value.
 */
export function generateStoreId(
  project: string,
  sanitizedIssue: string,
  repositoryPath: string,
): string {
  const hash = repositoryHash(repositoryPath);
  const projectToken = toKebabToken(project, "project");
  const issueToken = toKebabToken(sanitizedIssue, "issue");

  // Fixed length: "ce-" + projectToken + "-" + issueToken + "-" + hash
  const fixedLength = PREFIX.length + 1 + 1 + 1 + hash.length;
  const budget = Math.max(STORE_ID_MAX_LENGTH - fixedLength, 2);
  const [project2, issue2] = shareBudget(projectToken, issueToken, budget);

  const id = `${PREFIX}-${project2}-${issue2}-${hash}`;
  return id.slice(0, STORE_ID_MAX_LENGTH);
}

/** The only path an OpenSpec store may live at for a given workspace. */
export function expectedOpenSpecRoot(workspacePath: string): string {
  return join(workspacePath, "openspec");
}
