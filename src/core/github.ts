import { execa } from "execa";
import { z } from "zod";
import { CeError } from "./errors.js";
import { commitExists, fetchRefspec } from "./git.js";

/**
 * GitHub integration module: the only place in ce-harness that shells
 * out to the `gh` (GitHub CLI) executable. Used by `ce review` (creating
 * and refreshing an Existing PR review workspace) and, read-only, by `ce
 * status` (best-effort live PR-head staleness check for an existing
 * review workspace -- see `resolvePrSnapshot`'s callers there). `ce
 * start` remains entirely GitHub-independent and never imports this
 * module, even for its `--base`/`--head` review range.
 *
 * This is deliberately a thin wrapper around the `gh` CLI, never a
 * GitHub API client: every function here shells out to `gh` and lets it
 * handle authentication, host resolution, and the GraphQL/REST calls
 * themselves.
 */

/** Resolves the `gh` executable to invoke. Overridable for tests. */
export function ghBinary(): string {
  return process.env.CE_GH_BIN && process.env.CE_GH_BIN.length > 0 ? process.env.CE_GH_BIN : "gh";
}

async function runGh(cwd: string, args: string[]) {
  try {
    return await execa(ghBinary(), args, { cwd, reject: false });
  } catch (error) {
    // Mirrors isOpenSpecAvailable's defensive try/catch: some execa
    // versions/environments throw on a missing executable even with
    // reject: false, rather than resolving with a non-zero exit code.
    return { exitCode: 1, stdout: "", stderr: (error as Error).message } as const;
  }
}

/** Checks whether the `gh` executable is installed and runnable at all. */
export async function isGhAvailable(): Promise<boolean> {
  const result = await runGh(process.cwd(), ["--version"]);
  return result.exitCode === 0;
}

/** Checks whether `gh` is authenticated for at least one host. */
export async function isGhAuthenticated(): Promise<boolean> {
  const result = await runGh(process.cwd(), ["auth", "status"]);
  return result.exitCode === 0;
}

const PrSnapshotSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  baseRefName: z.string().min(1),
  baseRefOid: z.string().min(1),
  headRefName: z.string().min(1),
  headRefOid: z.string().min(1),
  isCrossRepository: z.boolean(),
  url: z.string().min(1),
});

/** An immutable snapshot of a GitHub pull request's identity and exact commits. */
export type PrSnapshot = z.infer<typeof PrSnapshotSchema>;

const PR_VIEW_JSON_FIELDS =
  "number,title,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository,url";

/**
 * Resolves the exact base/head commit SHAs for pull request `number` in
 * the repository at `repoRoot`, via `gh pr view`. Always invoked with
 * `cwd: repoRoot` so `gh` resolves the repository from that exact
 * repository's own remotes -- never from the calling process's `cwd`,
 * which could be a different repository entirely.
 *
 * Never fetches or mutates anything -- purely a read of the PR's
 * current state on GitHub.
 */
export async function resolvePrSnapshot(repoRoot: string, number: number): Promise<PrSnapshot> {
  const result = await runGh(repoRoot, [
    "pr",
    "view",
    String(number),
    "--json",
    PR_VIEW_JSON_FIELDS,
  ]);

  if (result.exitCode !== 0) {
    throw new CeError(
      `Could not resolve pull request #${number} for the repository at "${repoRoot}": ${
        result.stderr.trim() || "no further details were provided by the gh CLI."
      }`,
      "Confirm the PR number is correct, that this repository's remote points at the PR's " +
        "repository, and that `gh` is authenticated for it (`gh auth status`).",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new CeError(
      `"gh pr view" returned output that could not be parsed as JSON for PR #${number}: ${(error as Error).message}`,
    );
  }

  const validated = PrSnapshotSchema.safeParse(parsed);
  if (!validated.success) {
    throw new CeError(
      `"gh pr view" returned an unexpected shape for PR #${number}: ${validated.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return validated.data;
}

function prNamespace(pr: Pick<PrSnapshot, "number">): string {
  return `refs/ce-harness/reviews/pr-${pr.number}`;
}

/**
 * Fetches exactly the two commits `ce review` needs to make `pr`
 * reviewable locally, and nothing else. Works identically for a
 * same-repository PR and a fork PR: `refs/pull/<n>/head` is a ref
 * GitHub always maintains on the base repository itself, pointing at
 * the PR's head commit, regardless of which repository that commit's
 * branch actually lives on -- so no fork-specific branching is needed
 * here at all.
 *
 * Destinations are namespaced under `refs/ce-harness/reviews/pr-<n>/`,
 * never under `refs/heads/*` -- this never creates, moves, or updates a
 * local branch, and never touches the working tree.
 */
export async function fetchPrCommits(repoRoot: string, pr: PrSnapshot): Promise<void> {
  const ns = prNamespace(pr);
  await fetchRefspec(repoRoot, "origin", `+refs/pull/${pr.number}/head:${ns}/head`);
  await fetchRefspec(repoRoot, "origin", `+refs/heads/${pr.baseRefName}:${ns}/base`);
}

/**
 * Confirms the exact `baseRefOid`/`headRefOid` gh reported are now
 * present locally after `fetchPrCommits`. Guards against the rare race
 * where the PR was updated (e.g. force-pushed) between resolution and
 * fetch, in which case the fetched ref may point at a different commit
 * than the one already resolved -- this must surface as a clear error,
 * never a silent review of the wrong commit.
 */
/**
 * Parses a GitHub `owner/repo` slug out of a remote URL -- HTTPS
 * (`https://github.com/owner/repo(.git)?`), SSH shorthand
 * (`git@github.com:owner/repo.git`), and full SSH URL
 * (`ssh://git@github.com/owner/repo.git`) forms. Returns null for
 * anything else (a non-GitHub host, or a URL this doesn't recognize) --
 * `ce publish` requires a real slug before it will proceed, rather than
 * guessing or falling back to `gh`'s own cwd-based inference, so the
 * repository it's about to push to and create a PR against is always
 * the exact one already shown to the user.
 */
export function parseGithubSlug(remoteUrl: string): { owner: string; repo: string } | null {
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  ];
  for (const pattern of patterns) {
    const match = remoteUrl.match(pattern);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * The URL of an already-open pull request whose head is `branch` in
 * `repoSlug`, or null if there is none. `ce publish` checks this
 * immediately before creating a PR so re-publishing a workspace (pushing
 * more commits to the same deterministic branch name) reports the
 * existing PR instead of failing on "a pull request for this branch
 * already exists" or, worse, creating a duplicate.
 */
export async function findOpenPrForBranch(
  repoRoot: string,
  repoSlug: string,
  branch: string,
): Promise<string | null> {
  const result = await runGh(repoRoot, [
    "pr",
    "list",
    "--repo",
    repoSlug,
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "url",
    "--limit",
    "1",
  ]);
  if (result.exitCode !== 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0] as { url?: unknown };
  return typeof first.url === "string" ? first.url : null;
}

export interface CreatePullRequestOptions {
  repoSlug: string;
  base: string;
  head: string;
  title: string;
  bodyFile: string;
}

/**
 * Creates a pull request via `gh pr create`, always against an
 * explicitly named `repoSlug`/`base`/`head` -- never relying on `gh`'s
 * own cwd-based repository inference -- so the PR is created exactly
 * where the publish preview said it would be. `--body-file` (rather than
 * `--body`) avoids any shell-escaping risk from a multi-paragraph,
 * agent-generated PR description. Never passes `--merge`, `--auto`, or
 * any option that would enable auto-merge -- `ce publish` only ever
 * creates a PR, it never merges one.
 */
export async function createPullRequest(repoRoot: string, options: CreatePullRequestOptions): Promise<string> {
  const result = await runGh(repoRoot, [
    "pr",
    "create",
    "--repo",
    options.repoSlug,
    "--base",
    options.base,
    "--head",
    options.head,
    "--title",
    options.title,
    "--body-file",
    options.bodyFile,
  ]);
  if (result.exitCode !== 0) {
    throw new CeError(
      `Failed to create the pull request: ${result.stderr.trim() || "no further details were provided by the gh CLI."}`,
      "Confirm `gh` is authenticated (`gh auth status`) and that the branch was pushed successfully, then try again.",
    );
  }

  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const url = lines[lines.length - 1];
  if (!url || !url.startsWith("http")) {
    throw new CeError(
      `"gh pr create" succeeded but did not report a recognizable PR URL (got: ${JSON.stringify(result.stdout)}).`,
      "Check `gh pr list` in the target repository to find the pull request manually.",
    );
  }
  return url;
}

/**
 * Best-effort live lookup of pull request `prNumber`'s current head SHA,
 * for `ce status`'s stale-review check -- entirely read-only (unlike
 * `resolvePrSnapshot`'s other callers, never followed by a fetch). Never
 * throws: `gh` missing, unauthenticated, offline, or unable to resolve
 * the PR (e.g. `repoRoot`'s remote isn't actually this pull request's
 * repository) all degrade to `null`, which callers treat exactly like
 * "the check could not be attempted" -- `ce status` must never fail, or
 * even look different, just because this optional check couldn't run.
 */
export async function resolveLivePrHead(repoRoot: string, prNumber: number): Promise<string | null> {
  if (!(await isGhAvailable())) return null;
  if (!(await isGhAuthenticated())) return null;
  try {
    const pr = await resolvePrSnapshot(repoRoot, prNumber);
    return pr.headRefOid;
  } catch {
    return null;
  }
}

export async function verifyPrCommitsFetched(repoRoot: string, pr: PrSnapshot): Promise<void> {
  const [baseOk, headOk] = await Promise.all([
    commitExists(repoRoot, pr.baseRefOid),
    commitExists(repoRoot, pr.headRefOid),
  ]);

  if (!baseOk || !headOk) {
    const missing = [
      !baseOk ? `base commit ${pr.baseRefOid} (${pr.baseRefName})` : null,
      !headOk ? `head commit ${pr.headRefOid} (${pr.headRefName})` : null,
    ]
      .filter((v): v is string => v !== null)
      .join(" and ");

    throw new CeError(
      `Fetched pull request #${pr.number}'s refs, but ${missing} could not be found in "${repoRoot}".`,
      "The pull request may have been updated (e.g. force-pushed) between resolution and fetch. Run `ce review` again.",
    );
  }
}
