import { execa } from "execa";
import { z } from "zod";
import { CeError } from "./errors.js";
import { commitExists, fetchRefspec } from "./git.js";

/**
 * GitHub integration module: the only place in ce-harness that shells
 * out to the `gh` (GitHub CLI) executable. Used exclusively by
 * `ce review` -- `ce start` (including its `--base`/`--head` review
 * range) remains entirely GitHub-independent and never imports this
 * module.
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
