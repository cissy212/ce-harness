import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { openspecRoot } from "./paths.js";

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

/** Hyphens in the "ce-<project>-<issue>-<hash>" shape (see generateStoreId). */
const HYPHEN_COUNT = 3;

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
 * the store id (and the durable store's directory path -- see
 * expectedDurableOpenSpecRoot) so that two repositories that happen to
 * share a basename (e.g. "~/work/api" and "~/other/api") never collide,
 * without ever embedding the raw repository path itself in the id or path.
 * Exported for reuse by the durable, project-scoped identity/path
 * functions below.
 */
export function repositoryHash(repositoryPath: string): string {
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

  const fixedLength = PREFIX.length + HYPHEN_COUNT + hash.length;
  const budget = Math.max(STORE_ID_MAX_LENGTH - fixedLength, 2);
  const [project2, issue2] = shareBudget(projectToken, issueToken, budget);

  const id = `${PREFIX}-${project2}-${issue2}-${hash}`;
  return id.slice(0, STORE_ID_MAX_LENGTH);
}

/** The only path an OpenSpec store may live at for a given workspace. */
export function expectedOpenSpecRoot(workspacePath: string): string {
  return join(workspacePath, "openspec");
}

/** Hyphens in the "ce-<project>-<hash>" shape (see generateProjectStoreId). */
const PROJECT_HYPHEN_COUNT = 2;

/**
 * LEGACY (pre-Project-Identity) shape: `ce-<project>-<repo-path-hash>`,
 * keyed by the repository's literal filesystem path -- kept unchanged,
 * byte-for-byte, so `resolveTrustedOpenSpec` can still recompute and
 * trust an already-active durable store created before Project Identity
 * existed, without forcing every existing durable workspace to migrate
 * immediately. Never used to create anything new: `ce start` always
 * resolves a project id now (see projectIdentity.ts and the
 * project-id-keyed generateProjectStoreId below) -- only
 * `resolveTrustedOpenSpec` and `ce migrate-openspec` still reference
 * this, to recognize and offer to migrate this shape onto the current
 * one. This path-hash scheme is exactly what Project Identity replaces:
 * it breaks the moment the repository is cloned to, or the project
 * folder is renamed to, a different path, since the hash is derived
 * from that path.
 */
export function generateLegacyProjectStoreId(project: string, repositoryPath: string): string {
  const hash = repositoryHash(repositoryPath);
  const projectToken = toKebabToken(project, "project");

  const fixedLength = PREFIX.length + PROJECT_HYPHEN_COUNT + hash.length;
  const budget = Math.max(STORE_ID_MAX_LENGTH - fixedLength, 1);
  const truncated =
    projectToken.length > budget
      ? projectToken.slice(0, budget).replace(/-+$/, "") || projectToken.slice(0, 1)
      : projectToken;

  const id = `${PREFIX}-${truncated}-${hash}`;
  return id.slice(0, STORE_ID_MAX_LENGTH);
}

/**
 * LEGACY (pre-Project-Identity) shape:
 * ~/.ce-harness/openspec/<project>/<repo-path-hash>/ -- see
 * generateLegacyProjectStoreId above for why this still exists and when
 * it's used. Superseded by the project-id-keyed
 * expectedDurableOpenSpecRoot below for everything new.
 */
export function expectedLegacyDurableOpenSpecRoot(project: string, repositoryPath: string): string {
  return join(openspecRoot(), project, repositoryHash(repositoryPath));
}

/**
 * Mints a brand-new, ce-harness-owned project id: opaque, random hex,
 * and never derived from (or dependent on) any Git signal, repository
 * path, or project name/label -- see core/projectIdentity.ts's module
 * comment for why identity must be independent of all three. 48 bits of
 * randomness makes collisions negligible, and even a collision could
 * only ever surface as a spurious CANDIDATE/CONFLICT once evidence is
 * compared (see projectIdentity.ts's classifyIdentityMatch) -- a
 * project id is never trusted as identity on its own, only alongside
 * matching evidence, so this never needs to be cryptographically
 * unguessable, just practically unique.
 */
export function generateProjectId(): string {
  return randomBytes(6).toString("hex");
}

const PROJECT_ID_PATTERN = /^[a-f0-9]{12}$/;

/** True if `id` is shaped like a value generateProjectId could return. */
export function isValidProjectId(id: string): boolean {
  return typeof id === "string" && PROJECT_ID_PATTERN.test(id);
}

/**
 * Generates the OpenSpec store id for a project's durable store, keyed
 * *only* by its ce-harness project id -- deliberately never the project
 * name/label. The project name is derived from the repository folder's
 * basename (see sanitize.ts's deriveProjectName), so it changes across
 * a rename or a differently-named clone -- exactly the kind of
 * "path/clone change" Project Identity exists to survive (see
 * core/projectIdentity.ts). Baking the name into the store id would mean
 * resolveTrustedOpenSpec silently stops trusting a project's own durable
 * metadata the moment its checkout is renamed.
 */
export function generateProjectStoreId(projectId: string): string {
  return `${PREFIX}-${projectId}`.slice(0, STORE_ID_MAX_LENGTH);
}

/**
 * The only path a project's durable OpenSpec store may live at:
 * ~/.ce-harness/openspec/<projectId>/ -- a sibling of
 * workspacesRoot()/worktreesRoot(), never nested under either, so `ce
 * cleanup` (which only ever removes paths under those two roots)
 * structurally cannot reach it. Keyed by project id alone (see
 * generateProjectStoreId above for why), so unlike the legacy shape
 * above this never needs a repository-path hash to avoid collisions --
 * project ids are already unique by construction.
 */
export function expectedDurableOpenSpecRoot(projectId: string): string {
  return join(openspecRoot(), projectId);
}
