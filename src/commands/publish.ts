import { existsSync } from "node:fs";
import { CeError } from "../core/errors.js";
import { parseWorkspaceSelector } from "../core/sanitize.js";
import {
  describeAvailableWorkspaces,
  readActivePointer,
  readWorkspace,
  resolveTrustedOpenSpec,
  workspaceExistsOnDisk,
  workspaceType,
  type ActivePointer,
  type Workspace,
} from "../core/workspace.js";
import {
  commitAllChanges,
  computeWorktreeFingerprint,
  diffNameStatus,
  fetchRemoteBranch,
  hasInProgressMergeOrRebase,
  isDirty,
  logRange,
  mergeRef,
  pushBranch,
  readOriginOrSolitaryRemoteUrl,
  resolveCommit,
  resolveMergeBase,
  statusPorcelain,
  type CommitSummary,
} from "../core/git.js";
import { createPullRequest, findOpenPrForBranch, parseGithubSlug } from "../core/github.js";
import { renderPublishBranchName, resolvePublishBranchPattern } from "../core/branchNaming.js";
import { resolveArchivedChangeForWorkspace } from "../core/activeChange.js";
import { detectBootstrapNeeds } from "../core/bootstrap.js";

/**
 * `ce publish`: the deterministic half of shipping a completed,
 * archived workspace as a normal GitHub pull request -- see
 * templates/commands/publish.md for the agent-driven half (reading the
 * archived change's artifacts and verification evidence to write PR
 * title/body, displaying the plan, and getting explicit confirmation).
 *
 * Two modes, matching the two-phase design the `/publish` template
 * drives:
 *  - prepare (default, `options.confirm` falsy): entirely local/read
 *    plus one `git fetch` -- inspects state, fetches the base branch,
 *    safely updates the workspace's internal branch if the base
 *    advanced and it's a clean merge, and reports a full plan as JSON.
 *    Performs no remote mutation (no push, no PR).
 *  - confirm (`options.confirm: true`): only ever called by the
 *    template *after* the user has seen the plan and explicitly
 *    approved it. Commits any still-uncommitted changes, pushes the
 *    branch, and creates the PR (never merges, never enables
 *    auto-merge).
 *
 * The confirmation boundary is guarded by two independent checks, both
 * required: `expectedHead` (the branch's commit) and `expectedFingerprint`
 * (`computeWorktreeFingerprint` -- HEAD plus every staged/unstaged
 * tracked change plus untracked file content). `expectedHead` alone is
 * not sufficient: a file can be added or modified in the worktree
 * *without* the branch's commit moving at all (nothing has been
 * committed yet), which would let confirm silently commit and push
 * content the user never saw in the approved preview. The fingerprint
 * check is what actually closes that gap.
 */
export interface PublishCommandOptions {
  workspace?: string;
  change?: string;
  confirm?: boolean;
  title?: string;
  bodyFile?: string;
  expectedHead?: string;
  expectedFingerprint?: string;
}

const REMOTE = "origin";

/**
 * Paths that must never end up in what `ce publish` pushes. A defensive
 * audit, not a filter: the target worktree structurally never contains
 * these (ce-harness never writes harness/OpenSpec files inside it -- see
 * README's "The target repository itself is never modified with any
 * harness/OpenSpec files"), so this should never actually fire. It
 * exists as a second, independent check surfaced to the user as a
 * warning before any remote mutation, rather than relying solely on
 * that architectural invariant holding.
 */
const SUSPICIOUS_PATH_PATTERNS = [/^\.claude\//, /^\.opencode\//, /^openspec\//, /(^|\/)\.ce-workspace\.yml$/];

function auditSuspiciousPaths(paths: string[]): string[] {
  return paths.filter((path) => SUSPICIOUS_PATH_PATTERNS.some((pattern) => pattern.test(path)));
}

/** Extracts the path from a `git status --porcelain` line ("XY <path>", or "XY <old> -> <new>" for a rename). */
function porcelainPaths(lines: string[]): string[] {
  return lines.map((line) => line.slice(3).trim());
}

async function resolvePublishWorkspace(
  options: PublishCommandOptions,
): Promise<{ pointer: ActivePointer; workspace: Workspace }> {
  const pointer: ActivePointer | null = options.workspace
    ? parseWorkspaceSelector(options.workspace)
    : await readActivePointer();

  if (!pointer) {
    throw new CeError("No active workspace.", ["Start one with:", "", "  ce start <repo> <issue>"].join("\n"));
  }
  if (options.workspace && !workspaceExistsOnDisk(pointer.project, pointer.sanitizedIssue)) {
    throw new CeError(
      `No workspace found for "${pointer.project}/${pointer.sanitizedIssue}".`,
      await describeAvailableWorkspaces(),
    );
  }

  const workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);

  if (workspaceType(workspace) !== "Implementation") {
    throw new CeError(
      "ce publish only applies to an Implementation workspace.",
      "An Existing PR review workspace has no OpenSpec-driven implementation of its own to publish.",
    );
  }
  if (!existsSync(workspace.worktreePath)) {
    throw new CeError(
      `Cannot publish workspace for project "${pointer.project}", issue "${pointer.sanitizedIssue}" -- its worktree is missing.`,
      `Worktree not found at "${workspace.worktreePath}". Run \`ce cleanup --force ${pointer.project}/${pointer.sanitizedIssue}\` to discard this workspace, then \`ce start\` again.`,
    );
  }
  return { pointer, workspace };
}

/** Resolves the GitHub `owner/repo` slug for a workspace's worktree, or throws a clear, actionable CeError. */
async function resolveRepoSlug(worktreePath: string): Promise<{ owner: string; repo: string }> {
  const originUrl = await readOriginOrSolitaryRemoteUrl(worktreePath);
  if (!originUrl) {
    throw new CeError(
      `Could not determine a single "${REMOTE}" remote for "${worktreePath}".`,
      `ce publish (v0) requires exactly one unambiguous remote, named "${REMOTE}" or the repository's sole remote.`,
    );
  }
  const slug = parseGithubSlug(originUrl);
  if (!slug) {
    throw new CeError(
      `The ${REMOTE} remote ("${originUrl}") does not look like a github.com repository.`,
      "ce publish (v0) only supports GitHub. Push and open the pull request manually for other hosts.",
    );
  }
  return slug;
}

/**
 * Refuses before showing a plan (or before committing on `--confirm`) if
 * this worktree still needs local setup `git commit` itself would
 * depend on -- e.g. a repository-managed Git hook (Husky) whose install
 * step never ran in this exact worktree, discovered live rather than
 * trusting the `ce start`-time snapshot on `workspace.bootstrap` (which
 * can be stale: state can change over a workspace's life, and `ce
 * publish` is often the first thing to actually run `git commit`).
 * Read-only, exactly like `detectBootstrapNeeds` itself -- this only
 * ever reports findings and their suggested commands; it never installs
 * or fixes anything automatically, since an install can rewrite a
 * lockfile and that must always be the user's own explicit decision.
 */
async function refuseIfBootstrapRequired(worktreePath: string): Promise<void> {
  const { required, findings } = detectBootstrapNeeds(worktreePath);
  if (!required) return;

  const ecosystems = findings.map((finding) => finding.ecosystem).join(", ");
  const steps = findings.map((finding) => {
    const warning = finding.sideEffectWarning ? ` (${finding.sideEffectWarning})` : "";
    return `- ${finding.message}\n  Run: \`${finding.suggestedCommand}\`${warning}`;
  });

  throw new CeError(
    `This worktree needs local setup before \`ce publish\` can commit successfully (${ecosystems}).`,
    ["Run the following in the worktree, then re-run `ce publish`:", "", ...steps].join("\n"),
  );
}

async function refuseIfMidMergeOrRebase(worktreePath: string): Promise<void> {
  if (await hasInProgressMergeOrRebase(worktreePath)) {
    throw new CeError(
      `The worktree at "${worktreePath}" has an in-progress merge, rebase, or cherry-pick.`,
      "Resolve or abort it first (e.g. `git merge --abort` / `git rebase --abort` in the worktree), then re-run `ce publish`.",
    );
  }
}

/** Resolves the change name/root to attribute this publish to: an explicit override, else the workspace's own most-recently-archived change (if any). */
async function resolveChangeForPublish(
  workspace: Workspace,
  explicitChange: string | undefined,
): Promise<{ changeName: string | null; changeRoot: string | null }> {
  const trusted = resolveTrustedOpenSpec(workspace);
  if (!trusted) return { changeName: explicitChange ?? null, changeRoot: null };

  if (explicitChange) {
    const resolved = await resolveArchivedChangeForWorkspace(trusted.root, workspace.project, workspace.issue);
    return { changeName: explicitChange, changeRoot: resolved && resolved.name === explicitChange ? resolved.changeRoot : null };
  }

  const resolved = await resolveArchivedChangeForWorkspace(trusted.root, workspace.project, workspace.issue);
  return resolved ? { changeName: resolved.name, changeRoot: resolved.changeRoot } : { changeName: null, changeRoot: null };
}

export interface PublishPlan {
  project: string;
  issue: string;
  repositoryPath: string;
  worktreePath: string;
  internalBranch: string;
  baseBranch: string;
  repoSlug: string;
  remoteBaseCommit: string;
  updateStatus: "already-current" | "safely-updated";
  publishBranch: string;
  changeName: string | null;
  changeRoot: string | null;
  headCommit: string;
  /** Pass back verbatim as `--expected-fingerprint` on `--confirm` -- see PublishCommandOptions's doc comment for why `headCommit` alone isn't sufficient. */
  expectedFingerprint: string;
  includedCommits: CommitSummary[];
  includedFiles: string[];
  uncommittedFiles: string[];
  warnings: string[];
}

async function runPrepare(options: PublishCommandOptions): Promise<void> {
  const { workspace } = await resolvePublishWorkspace(options);
  const worktreePath = workspace.worktreePath;

  await refuseIfMidMergeOrRebase(worktreePath);
  await refuseIfBootstrapRequired(worktreePath);
  const slug = await resolveRepoSlug(worktreePath);
  const repoSlugText = `${slug.owner}/${slug.repo}`;

  await fetchRemoteBranch(worktreePath, REMOTE, workspace.baseBranch);
  const remoteBaseRef = `${REMOTE}/${workspace.baseBranch}`;
  let remoteBaseCommit: string;
  try {
    remoteBaseCommit = await resolveCommit(worktreePath, remoteBaseRef);
  } catch {
    throw new CeError(
      `Could not resolve "${remoteBaseRef}" after fetching -- "${workspace.baseBranch}" may not be a real branch on "${REMOTE}".`,
      `Confirm "${workspace.baseBranch}" exists on ${repoSlugText}'s ${REMOTE} remote.`,
    );
  }

  let internalBranchCommit = await resolveCommit(worktreePath, workspace.internalBranch);
  const mergeBase = await resolveMergeBase(worktreePath, remoteBaseCommit, internalBranchCommit);

  let updateStatus: "already-current" | "safely-updated" = "already-current";
  if (mergeBase !== remoteBaseCommit) {
    const { merged } = await mergeRef(worktreePath, remoteBaseRef);
    if (!merged) {
      throw new CeError(
        `"${workspace.baseBranch}" has advanced on ${repoSlugText} and merging it into "${workspace.internalBranch}" produced conflicts.`,
        `Resolve the conflicts manually in the worktree ("${worktreePath}"): \`git merge ${remoteBaseRef}\`, fix conflicts, \`git add\`, \`git commit\` -- then re-run \`ce publish\`.`,
      );
    }
    updateStatus = "safely-updated";
    internalBranchCommit = await resolveCommit(worktreePath, workspace.internalBranch);
  }

  const { changeName, changeRoot } = await resolveChangeForPublish(workspace, options.change);
  const pattern = await resolvePublishBranchPattern(worktreePath, workspace.sanitizedIssue, changeName);
  const publishBranch = renderPublishBranchName(pattern, workspace.sanitizedIssue, changeName);

  const includedCommits = await logRange(worktreePath, remoteBaseRef, workspace.internalBranch);
  const includedFiles = await diffNameStatus(worktreePath, remoteBaseRef, workspace.internalBranch);
  const uncommittedFiles = porcelainPaths(await statusPorcelain(worktreePath));

  const warnings = auditSuspiciousPaths([...includedFiles, ...uncommittedFiles]).map(
    (path) => `Suspicious, harness-looking path in the product diff: "${path}" -- verify before publishing.`,
  );

  // Computed last, after any merge above has already settled -- this is
  // the exact state `--confirm` must still match immediately before it
  // commits/pushes anything.
  const expectedFingerprint = await computeWorktreeFingerprint(worktreePath);

  const plan: PublishPlan = {
    project: workspace.project,
    issue: workspace.issue,
    repositoryPath: workspace.repositoryPath,
    worktreePath,
    internalBranch: workspace.internalBranch,
    baseBranch: workspace.baseBranch,
    repoSlug: repoSlugText,
    remoteBaseCommit,
    updateStatus,
    publishBranch,
    changeName,
    changeRoot,
    headCommit: internalBranchCommit,
    expectedFingerprint,
    includedCommits,
    includedFiles,
    uncommittedFiles,
    warnings,
  };
  console.log(JSON.stringify(plan, null, 2));
}

export interface PublishResult {
  url: string;
  alreadyExisted: boolean;
  publishBranch: string;
  base: string;
}

async function runConfirm(options: PublishCommandOptions): Promise<void> {
  if (!options.title || !options.bodyFile || !options.expectedHead || !options.expectedFingerprint) {
    throw new CeError(
      "ce publish --confirm requires --title, --body-file, --expected-head, and --expected-fingerprint.",
      "Run `ce publish` first (without --confirm) to generate the plan, then pass its headCommit and expectedFingerprint back as --expected-head and --expected-fingerprint.",
    );
  }

  const { workspace } = await resolvePublishWorkspace(options);
  const worktreePath = workspace.worktreePath;

  await refuseIfMidMergeOrRebase(worktreePath);
  await refuseIfBootstrapRequired(worktreePath);

  const currentHead = await resolveCommit(worktreePath, workspace.internalBranch);
  if (currentHead !== options.expectedHead) {
    throw new CeError(
      `The workspace's branch has changed since the publish plan was generated (expected ${options.expectedHead}, found ${currentHead}).`,
      "Run `/publish` again to regenerate the plan against the current state, then retry.",
    );
  }

  // Closes the gap `--expected-head` alone leaves open: a file can be
  // added, modified, or removed in the worktree without the branch's
  // commit moving at all, which would otherwise let this silently
  // commit and push content the approved preview never showed. Checked
  // before anything below is touched -- a commit, in particular, would
  // itself change the fingerprint and mask exactly the drift this
  // exists to catch.
  const currentFingerprint = await computeWorktreeFingerprint(worktreePath);
  if (currentFingerprint !== options.expectedFingerprint) {
    throw new CeError(
      "The workspace's worktree has changed since the publish plan was generated -- a file was added, modified, or removed after the plan was shown, even though the branch's commit itself hasn't moved.",
      "Run `/publish` again to regenerate the plan against the current state, then retry.",
    );
  }

  if (await isDirty(worktreePath)) {
    await commitAllChanges(worktreePath, options.title);
  }

  // Defense in depth: `runPrepare`'s suspicious-path audit only ever
  // *warns*, on the assumption `/publish` (the template) honors it and
  // stops -- this is the hard, deterministic backstop that makes the
  // warning a real guarantee rather than something an agent could
  // silently ignore. Re-audits against the final, post-commit diff
  // (never the possibly-stale one from `runPrepare`), and refuses to
  // push at all if anything suspicious is still there.
  const finalIncludedFiles = await diffNameStatus(worktreePath, `${REMOTE}/${workspace.baseBranch}`, workspace.internalBranch);
  const suspicious = auditSuspiciousPaths(finalIncludedFiles);
  if (suspicious.length > 0) {
    throw new CeError(
      `Refusing to publish: the product diff contains harness/OpenSpec-looking path(s): ${suspicious.join(", ")}.`,
      "These must never reach the target repository. Remove them from the workspace branch, then re-run `ce publish`.",
    );
  }

  const slug = await resolveRepoSlug(worktreePath);
  const repoSlugText = `${slug.owner}/${slug.repo}`;

  const { changeName } = await resolveChangeForPublish(workspace, options.change);
  const pattern = await resolvePublishBranchPattern(worktreePath, workspace.sanitizedIssue, changeName);
  const publishBranch = renderPublishBranchName(pattern, workspace.sanitizedIssue, changeName);

  await pushBranch(worktreePath, REMOTE, workspace.internalBranch, publishBranch);

  const existingUrl = await findOpenPrForBranch(worktreePath, repoSlugText, publishBranch);
  const result: PublishResult = existingUrl
    ? { url: existingUrl, alreadyExisted: true, publishBranch, base: workspace.baseBranch }
    : {
        url: await createPullRequest(worktreePath, {
          repoSlug: repoSlugText,
          base: workspace.baseBranch,
          head: publishBranch,
          title: options.title,
          bodyFile: options.bodyFile,
        }),
        alreadyExisted: false,
        publishBranch,
        base: workspace.baseBranch,
      };
  console.log(JSON.stringify(result, null, 2));
}

export async function publishCommand(options: PublishCommandOptions): Promise<void> {
  if (options.confirm) {
    await runConfirm(options);
  } else {
    await runPrepare(options);
  }
}
