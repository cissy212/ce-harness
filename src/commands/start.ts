import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { CeError } from "../core/errors.js";
import { deriveProjectName, sanitizeIssue } from "../core/sanitize.js";
import {
  worktreePath as buildWorktreePath,
  workspacePath as buildWorkspacePath,
} from "../core/paths.js";
import {
  addWorktree,
  branchExists,
  deleteBranch,
  detectBaseBranch,
  isDirty,
  pruneWorktrees,
  readOriginOrSolitaryRemoteUrl,
  removeWorktree,
  resolveCommit,
  resolveMergeBase,
  resolveRootCommit,
  resolveTargetRepo,
} from "../core/git.js";
import {
  clearActivePointer,
  readActivePointer,
  removeWorkspaceDir,
  workspaceExistsOnDisk,
  workspaceType,
  writeActivePointer,
  writeWorkspace,
  type PrReviewMetadata,
  type Workspace,
} from "../core/workspace.js";
import { expectedDurableOpenSpecRoot, generateProjectStoreId } from "../core/openspecId.js";
import { resolveProjectIdentity, writeIdentityRecord } from "../core/projectIdentity.js";
import {
  describeOpenSpecStatus,
  isOpenSpecAvailable,
  isStoreRegistered,
  setupStore,
  storeDoctor,
  unregisterStore,
} from "../core/openspec.js";
import { resolveRunner } from "../core/runners/index.js";
import { createLensesDir } from "../core/lenses.js";
import {
  codeGraphBinary,
  ignoreCodeGraphIndex,
  initializeCodeGraph,
  type CodeGraphResult,
} from "../core/codeGraph.js";
import { detectBootstrapNeeds, type BootstrapCheckResult } from "../core/bootstrap.js";
import { renderBranchName, resolveBranchPattern } from "../core/branchNaming.js";
import { buildStartupSummary, formatStartupSummary } from "../core/startupSummary.js";
import { buildLaunchEnv } from "../core/launchEnv.js";
import { presentAndLaunch } from "../core/workspacePresenter.js";

export interface StartOptions {
  repo: string;
  issue: string;
  /** Exact base ref/commit for an explicit review range. Requires `head`. */
  base?: string;
  /** Exact head ref/commit for an explicit review range. Requires `base`. */
  head?: string;
  /**
   * Explicit starting ref for an Implementation workspace -- any ref
   * `resolveCommit` can resolve locally (a local branch, a remote-tracking
   * ref like `origin/<branch>`, a tag, or a raw commit). The internal
   * worktree branch is created from it instead of `detectBaseBranch`'s
   * auto-detected default. Mutually exclusive with `base`/`head`: this
   * never changes the workspace type (see `workspaceType`), which stays
   * "Implementation" -- `--base`/`--head` remain the only way to create an
   * "Existing PR review" workspace.
   */
  from?: string;
  /**
   * Coding-agent runner id (e.g. "opencode", "claude"). Left `undefined`
   * here, `resolveRunner` falls back to `DEFAULT_RUNNER_ID` ("opencode") --
   * that fallback exists for legacy-workspace-resolution and any other
   * caller that bypasses the CLI, not for real end-user default behavior:
   * the `ce` CLI itself (cliMain.ts) always supplies "claude" here when
   * `--runner` is omitted, so this field is undefined in practice only
   * when `startCommand` is called directly (e.g. from tests).
   */
  runner?: string;
  /**
   * Explicit Project Identity override: attach this repository's durable
   * OpenSpec store to an already-known project id instead of letting
   * ce-harness detect or mint one automatically. Mutually exclusive with
   * `newProject`. See core/projectIdentity.ts.
   */
  projectId?: string;
  /**
   * Explicit Project Identity override: mint a brand-new project id for
   * this repository even if ce-harness recognizes it (fully or
   * partially) as an existing project. Mutually exclusive with
   * `projectId`.
   */
  newProject?: boolean;
  /**
   * Structured GitHub PR identity to persist alongside an explicit
   * --base/--head review range -- passed through verbatim from `ce
   * review` (see `core/workspace.ts`'s `PrReviewMetadataSchema`).
   * `startCommand` never fetches or validates anything about it; it only
   * writes what it's handed, which is what keeps this command entirely
   * GitHub-independent (see the module doc comment on `../commands/review.js`
   * -- `ce review` and `ce status` are the only callers that ever touch
   * `core/github.js`, not this one). Ignored (never persisted) unless
   * `base`/`head` are also given -- see `WorkspaceSchema`'s own refine.
   */
  prReview?: PrReviewMetadata;
}

export async function startCommand({
  repo,
  issue,
  base,
  head,
  from,
  runner,
  projectId: projectIdOption,
  newProject,
  prReview,
}: StartOptions): Promise<void> {
  // Pure input-shape validation, checked before touching the filesystem
  // at all: an explicit review range requires both --base and --head,
  // never just one, and --from is a different, mutually exclusive way of
  // picking a starting point (an Implementation workspace, never a
  // review), so combining it with either is rejected outright rather than
  // silently letting one win. Resolving the runner is validated here too,
  // for the same reason -- an unsupported --runner must never leave a
  // worktree, workspace, or OpenSpec store behind.
  if ((base && !head) || (!base && head)) {
    throw new CeError(
      "--base and --head must both be provided together (or neither).",
      base
        ? "Add --head <ref> to specify the exact review range."
        : "Add --base <ref> to specify the exact review range.",
    );
  }
  if (from && (base || head)) {
    throw new CeError(
      "--from cannot be combined with --base/--head.",
      "--from starts a normal Implementation workspace from an explicit ref; --base/--head start an " +
        "Existing PR review workspace from an explicit commit range. Use exactly one of these.",
    );
  }
  if (projectIdOption && newProject) {
    throw new CeError(
      "--project-id and --new-project are mutually exclusive.",
      "--project-id attaches to an already-known project; --new-project mints a fresh one. Use exactly one.",
    );
  }
  const selectedRunner = resolveRunner(runner);

  const repoRoot = await resolveTargetRepo(repo);

  if (await isDirty(repoRoot)) {
    throw new CeError(
      `Repository at "${repoRoot}" has uncommitted or untracked changes.`,
      "Commit, stash, or discard your changes before running `ce start`.",
    );
  }

  const project = deriveProjectName(repoRoot);
  const sanitizedIssue = sanitizeIssue(issue);

  // worktreeSeed is the ref/commit `git worktree add` starts the
  // internal ce-harness branch from. In the default flow that's the
  // repository's detected base branch (never assumed to be "main" --
  // see detectBaseBranch), exactly as before. In the explicit-range
  // flow it's the resolved head commit -- the worktree must actually
  // contain the reviewed head, not just fork from the base. In the
  // explicit --from flow it's the resolved --from ref itself.
  let worktreeSeed: string;
  let baseBranchName: string;
  let baseBranchCommit: string | undefined;
  let baseRefExplicit: boolean | undefined;
  let diffBase: string | undefined;
  let diffHead: string | undefined;
  let diffMergeBase: string | undefined;

  if (base && head) {
    // Resolved to immutable SHAs -- and their merge base confirmed to
    // exist -- entirely before any persistent resource is created.
    // Never fetches: resolveCommit throws its own clear, actionable
    // error if either ref isn't already present locally.
    diffBase = await resolveCommit(repoRoot, base);
    diffHead = await resolveCommit(repoRoot, head);
    // Deliberately not an ancestor check: base does not need to be an
    // ancestor of head. An open PR whose base branch has advanced since
    // the PR diverged is still a valid review -- only requires that the
    // two commits share some common history at all.
    diffMergeBase = await resolveMergeBase(repoRoot, diffBase, diffHead);
    worktreeSeed = diffHead;
    baseBranchName = diffHead;
  } else if (from) {
    // An explicit starting point for a normal Implementation workspace
    // (e.g. a completed dependency branch that hasn't merged to the
    // repository's default branch yet) -- deliberately reuses the exact
    // same resolution primitive the review flow already relies on
    // (resolveCommit: never fetches, fails clearly if unresolvable, and
    // already supports local branches, remote-tracking refs, tags, and
    // raw commits). Resolving to an immutable SHA up front, rather than
    // handing the raw ref to `addWorktree`, mirrors the review flow's
    // own rationale: an exact, pinned point before any persistent
    // resource is created. Read-only -- resolveCommit is a plain
    // `git rev-parse`, and `addWorktree` below only ever creates a new
    // branch pointing at this commit, so `from` itself is never moved.
    const resolvedFrom = await resolveCommit(repoRoot, from);
    worktreeSeed = resolvedFrom;
    baseBranchName = from;
    baseBranchCommit = resolvedFrom;
    baseRefExplicit = true;
  } else {
    // Repository-agnostic by design: never assumes "main". Prefers a
    // live query of the remote's actual default branch, falls back to
    // the locally-cached remote default, and only falls back to the
    // "main"/"master" convention names as a last resort with zero
    // repository-provided signal (e.g. a local-only repository).
    const detected = await detectBaseBranch(repoRoot);
    if (!detected) {
      throw new CeError(
        `Neither "main" nor "master" branch exists in "${repoRoot}", and no remote default branch could be determined.`,
        'Create a "main" or "master" branch in the target repository, or configure a remote with a default branch, before running `ce start`.',
      );
    }
    worktreeSeed = detected.ref;
    baseBranchName = detected.name;
    baseBranchCommit = await resolveCommit(repoRoot, detected.ref);
  }

  // Configurable per repository (or per user, machine-wide) via Git's
  // own config resolution -- see branchNaming.ts. Existing behavior
  // ("ce-harness/{issue}") remains the default for every repository
  // that hasn't opted into a different pattern.
  const branchPattern = await resolveBranchPattern(repoRoot);
  const internalBranch = renderBranchName(branchPattern, sanitizedIssue);
  const worktreePath = buildWorktreePath(project, sanitizedIssue);
  const workspacePath = buildWorkspacePath(project, sanitizedIssue);
  // Project Identity: resolves a stable, ce-harness-minted project id
  // for this repository, using its Git signals (origin URL, root
  // commit) purely as *evidence* to recognize an id already minted --
  // never to derive or regenerate the id itself. See
  // core/projectIdentity.ts for the full model. This is what lets every
  // workspace for the same project resolve to the exact same durable
  // OpenSpec store id/root regardless of the project's current name or
  // the repository's current checkout path (see
  // expectedDurableOpenSpecRoot in core/openspecId.ts for why that
  // durable path is structurally outside the workspace/worktree trees
  // `ce cleanup` ever touches).
  const originUrl = await readOriginOrSolitaryRemoteUrl(repoRoot);
  const rootCommit = await resolveRootCommit(repoRoot);
  const identityResolution = await resolveProjectIdentity({
    project,
    originUrl,
    rootCommit,
    explicitProjectId: projectIdOption,
    mintNew: newProject,
  });
  const projectId = identityResolution.projectId;
  const openSpecStoreId = generateProjectStoreId(projectId);
  const openSpecRoot = expectedDurableOpenSpecRoot(projectId);

  // Fail before creating any persistent resource (worktree, branch,
  // workspace) whenever possible.
  if (!(await isOpenSpecAvailable(repoRoot))) {
    throw new CeError(
      `The "openspec" executable is not installed or could not be run.`,
      "Install OpenSpec (e.g. `npm install -g @fission-ai/openspec`) and ensure it is on your PATH, then try again.",
    );
  }

  // The previously active (default) workspace, if any, is never a
  // blocker: every workspace is already fully isolated and addressable
  // by its own (project, sanitizedIssue) pair (see core/workspace.ts's
  // `ActivePointer` doc comment), independent of which one happens to
  // be the default. Read here only so the summary below can tell the
  // user their previous default is untouched and how to get back to it
  // -- never compared against this start's own target: starting the
  // exact same, already-existing project/issue is caught by the
  // worktree/workspace/branch existence checks immediately below,
  // regardless of what's currently default.
  const previousActive = await readActivePointer();
  // Each of these three targets `ce cleanup <project>/<issue>`
  // explicitly, never a bare `ce cleanup` -- since that now acts on
  // whichever workspace is the current *default*, which may well be a
  // different one than this exact, already-existing project/issue (see
  // core/workspace.ts's `ActivePointer` doc comment). A bare suggestion
  // here would risk cleaning up the wrong workspace.
  const selectorSuffix = `${project}/${sanitizedIssue}`;
  if (existsSync(worktreePath)) {
    throw new CeError(
      `Worktree already exists at "${worktreePath}".`,
      `Run \`ce cleanup ${selectorSuffix}\` to remove the existing worktree before starting again.`,
    );
  }
  if (workspaceExistsOnDisk(project, sanitizedIssue)) {
    throw new CeError(
      `Workspace already exists at "${workspacePath}".`,
      `Run \`ce resume ${selectorSuffix}\` to continue it, or \`ce cleanup ${selectorSuffix}\` to remove it before starting again.`,
    );
  }
  if (await branchExists(repoRoot, internalBranch)) {
    throw new CeError(
      `Branch "${internalBranch}" already exists in "${repoRoot}".`,
      `Delete the branch (git -C "${repoRoot}" branch -D ${internalBranch}) or run \`ce cleanup ${selectorSuffix}\`, then try again.`,
    );
  }
  // The project's durable store may already be registered -- from an
  // earlier workspace for this same project, or from a previous `ce
  // start` that got this far before failing later. Reuse it (never
  // re-`setup`, which is not idempotent) only when it's registered at
  // exactly this project's expected durable path; anything else is a
  // genuine conflict ce-harness cannot safely resolve on its own.
  let reuseExistingOpenSpecStore = false;
  if (await isStoreRegistered(repoRoot, openSpecStoreId)) {
    const preflightDoctor = await storeDoctor(repoRoot, openSpecStoreId);
    if (preflightDoctor.found && preflightDoctor.root === openSpecRoot) {
      reuseExistingOpenSpecStore = true;
    } else {
      throw new CeError(
        `OpenSpec store "${openSpecStoreId}" is already registered, but not at this project's durable path ("${openSpecRoot}")` +
          (preflightDoctor.root ? ` -- found at "${preflightDoctor.root}" instead.` : "."),
        `Run \`openspec store unregister ${openSpecStoreId}\` first if this is stale, then try again.`,
      );
    }
  } else if (existsSync(openSpecRoot)) {
    // Project Identity resolved this repository to a project id whose
    // durable store directory already has content on disk, but isn't
    // registered with OpenSpec on this machine -- e.g. ~/.ce-harness was
    // restored or synced from another machine. Never call setupStore
    // against unknown pre-existing content (see setupStore's own
    // contract -- it is not a reconciling operation); refuse with a
    // manual-recovery hint instead of guessing.
    throw new CeError(
      `Project Identity resolved this repository to project "${projectId}", whose durable OpenSpec ` +
        `store directory already exists at "${openSpecRoot}", but it is not registered with OpenSpec ` +
        "on this machine.",
      `This can happen after restoring or syncing ~/.ce-harness from another machine. Register it ` +
        `manually (\`openspec store setup ${openSpecStoreId} --path ${openSpecRoot}\`), verify it ` +
        `(\`openspec store doctor ${openSpecStoreId}\`), then retry \`ce start\`.`,
    );
  }

  let worktreeCreated = false;
  let workspaceDirCreated = false;
  // True only when THIS session created and registered the store fresh
  // (setupStore succeeded here) -- never true when reusing an
  // already-registered durable store from an earlier workspace, so a
  // later failure in *this* session's own setup (e.g. runner config,
  // CodeGraph) never causes rollback to unregister a durable store this
  // session didn't create and doesn't own. See rollback() below.
  let storeCreatedThisSession = false;
  let activePointerWritten = false;
  let codeGraphResult: CodeGraphResult = {
    available: false,
    managedByHarness: false,
    reason: "CodeGraph setup was not attempted.",
  };
  let bootstrapResult: BootstrapCheckResult = { required: false, findings: [] };
  // Populated unconditionally from the two writeConfig/writeCodeGraphConfig
  // calls below, regardless of which runner is selected -- never gated on
  // a runner id check here, so this command stays runner-agnostic. See
  // RunnerSpec.managedWorktreeRelativePaths for how each runner turns
  // this value into the paths `ce cleanup`/`ce status` treat as
  // harness-owned. `commandsManaged` is the individual, per-item paths
  // `writeConfig` actually wrote -- never an all-or-nothing flag.
  let runnerWorktreeArtifacts: { commandsManaged: string[]; mcpManaged?: boolean } = {
    commandsManaged: [],
  };
  let workspace: Workspace;

  try {
    await mkdir(dirname(worktreePath), { recursive: true });
    await addWorktree(repoRoot, worktreePath, internalBranch, worktreeSeed);
    worktreeCreated = true;

    // Repository bootstrap detection, immediately after worktree
    // creation: a successful worktree does not imply a development-
    // ready workspace (declared dependencies are never installed yet --
    // node_modules/vendor/etc. are untracked and worktree-local). Purely
    // read-only and defensive, matching the CodeGraph pattern below:
    // never allowed to fail `ce start` itself, and never executes
    // anything in the worktree.
    try {
      bootstrapResult = detectBootstrapNeeds(worktreePath);
    } catch (error) {
      bootstrapResult = { required: false, findings: [] };
      console.error(
        `Warning: repository bootstrap detection failed unexpectedly: ${(error as Error).message}`,
      );
    }

    await mkdir(workspacePath, { recursive: true });
    workspaceDirCreated = true;

    runnerWorktreeArtifacts.commandsManaged = await selectedRunner.writeConfig({
      workspacePath,
      worktreePath,
    });
    await createLensesDir(workspacePath);
    // Both directories are nested under workspacePath, so workspace rollback
    // and cleanup cover them.

    // Optional CodeGraph (semantic code navigation) provisioning, scoped
    // entirely to this isolated worktree -- never the target repository.
    // Never allowed to fail `ce start` itself: initializeCodeGraph never
    // throws by contract, and this call site adds a second, defensive
    // layer around both it and the config-write step.
    try {
      codeGraphResult = await initializeCodeGraph(worktreePath);
      if (codeGraphResult.available) {
        runnerWorktreeArtifacts.mcpManaged = await selectedRunner.writeCodeGraphConfig(
          { workspacePath, worktreePath },
          codeGraphBinary(),
        );

        // Purely cosmetic (keeps `.codegraph/` out of `git status`) --
        // never lets a failure here affect codeGraphResult or fail
        // `ce start` itself, matching ignoreCodeGraphIndex's own
        // never-throw contract.
        const ignoreResult = await ignoreCodeGraphIndex(worktreePath);
        if (!ignoreResult.ignored) {
          console.error(
            `Warning: could not add ".codegraph" to Git's local exclude file: ${ignoreResult.reason}`,
          );
        }
      }
    } catch (error) {
      codeGraphResult = {
        available: false,
        managedByHarness: false,
        reason: `CodeGraph setup encountered an unexpected error: ${(error as Error).message}`,
      };
    }

    if (reuseExistingOpenSpecStore) {
      const doctorResult = await storeDoctor(workspacePath, openSpecStoreId);
      if (!doctorResult.found || !doctorResult.healthy) {
        throw new CeError(
          `This project's durable OpenSpec store "${openSpecStoreId}" failed its health check: ${describeOpenSpecStatus(doctorResult)}`,
          `Inspect "${openSpecRoot}" directly, or run \`openspec store unregister ${openSpecStoreId}\` and retry \`ce start\` to recreate it.`,
        );
      }
    } else {
      await mkdir(dirname(openSpecRoot), { recursive: true });
      const setupResult = await setupStore(workspacePath, openSpecStoreId, openSpecRoot);
      if (!setupResult.success) {
        throw new CeError(
          `Failed to create and register OpenSpec store "${openSpecStoreId}": ${describeOpenSpecStatus(setupResult)}`,
        );
      }
      storeCreatedThisSession = true;

      const doctorResult = await storeDoctor(workspacePath, openSpecStoreId);
      if (!doctorResult.found || !doctorResult.healthy) {
        throw new CeError(
          `OpenSpec store "${openSpecStoreId}" failed its health check: ${describeOpenSpecStatus(doctorResult)}`,
        );
      }
    }

    // Persist (or extend) this project's identity record only now that
    // its durable store is confirmed present and healthy -- never
    // before, so a failure earlier in this block never leaves evidence
    // on file for a store that doesn't actually exist. `recordToPersist`
    // is null for a plain "match" (see resolveProjectIdentity):
    // evidence for exactly these signals is already on file, so there is
    // nothing new to write.
    if (identityResolution.recordToPersist) {
      await writeIdentityRecord(openSpecRoot, identityResolution.recordToPersist);
    }

    workspace = {
      project,
      repositoryPath: repoRoot,
      issue,
      sanitizedIssue,
      baseBranch: baseBranchName,
      internalBranch,
      worktreePath,
      workspacePath,
      createdAt: new Date().toISOString(),
      openSpec: {
        storeId: openSpecStoreId,
        root: openSpecRoot,
        durable: true,
        projectId,
      },
      ...(baseBranchCommit ? { baseBranchCommit } : {}),
      ...(baseRefExplicit ? { baseRefExplicit } : {}),
      ...(diffBase && diffHead ? { diffBase, diffHead, diffMergeBase } : {}),
      ...(diffBase && diffHead && prReview ? { prReview } : {}),
      codeGraph: codeGraphResult,
      bootstrap: bootstrapResult,
      runner: selectedRunner.id,
      runnerWorktreeArtifacts,
    };
    await writeWorkspace(workspace);

    await writeActivePointer({ project, sanitizedIssue });
    activePointerWritten = true;
  } catch (error) {
    await rollback({
      repoRoot,
      worktreePath,
      internalBranch,
      project,
      sanitizedIssue,
      workspacePath,
      openSpecStoreId,
      worktreeCreated,
      workspaceDirCreated,
      storeCreatedThisSession,
      activePointerWritten,
    });
    throw error;
  }

  // A concise, extensible summary: an ordered list of independent
  // sections (see startupSummary.ts) so a future addition never
  // requires redesigning how this command formats or prints output.
  console.log(
    formatStartupSummary(
      buildStartupSummary({
        worktreePath,
        workspaceType: workspaceType(workspace),
        bootstrap: bootstrapResult,
      }),
    ),
  );
  // Non-alarming: the previous default workspace was never at risk --
  // this just tells the user where it went and how to get back, since
  // `ce resume`/`ce open`/`ce status`/`ce cleanup` with no argument now
  // resolve to *this* workspace instead.
  if (
    previousActive &&
    (previousActive.project !== project || previousActive.sanitizedIssue !== sanitizedIssue)
  ) {
    console.log(
      `Note: ${previousActive.project}/${previousActive.sanitizedIssue} was the previous default workspace and is untouched. Resume it any time: ce resume ${previousActive.project}/${previousActive.sanitizedIssue}`,
    );
  }
  console.log("");

  // Everything the workspace needs (worktree, workspace dir, OpenSpec
  // store, workspace.yml, active pointer) is fully created and committed
  // at this point. Nothing from here on -- presenting the workspace, or a
  // failure to launch the runner -- must ever roll any of that back.
  //
  // The launch environment itself is built by the same shared helper
  // `ce resume` uses, from the just-written `workspace` object -- so the
  // two commands can never define two different launch environments.
  const launchEnv = buildLaunchEnv(workspace);
  await presentAndLaunch({
    repoPath: repoRoot,
    worktreePath,
    runner: selectedRunner,
    launchEnv,
    launchFailureRecoveryIntro: "The workspace was created successfully; enter it manually with:",
    project: workspace.project,
    issue: workspace.issue,
  });
}

interface RollbackContext {
  repoRoot: string;
  worktreePath: string;
  internalBranch: string;
  project: string;
  sanitizedIssue: string;
  workspacePath: string;
  openSpecStoreId: string;
  worktreeCreated: boolean;
  workspaceDirCreated: boolean;
  storeCreatedThisSession: boolean;
  activePointerWritten: boolean;
}

async function rollback(ctx: RollbackContext): Promise<void> {
  const rollbackErrors: string[] = [];
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      rollbackErrors.push(`${label}: ${(error as Error).message}`);
    }
  };

  if (ctx.activePointerWritten) {
    await attempt("clear active pointer", () => clearActivePointer());
  }
  if (ctx.storeCreatedThisSession) {
    await attempt("unregister OpenSpec store", async () => {
      const result = await unregisterStore(ctx.workspacePath, ctx.openSpecStoreId);
      if (!result.success && !result.notFound) {
        throw new Error(describeOpenSpecStatus(result));
      }
    });
  }
  if (ctx.workspaceDirCreated) {
    await attempt("remove workspace directory", () =>
      removeWorkspaceDir(ctx.project, ctx.sanitizedIssue),
    );
  }
  if (ctx.worktreeCreated) {
    await attempt("remove Git worktree", () => removeWorktree(ctx.repoRoot, ctx.worktreePath, true));
    await attempt("delete internal branch", () => deleteBranch(ctx.repoRoot, ctx.internalBranch));
    await attempt("prune worktree metadata", () => pruneWorktrees(ctx.repoRoot));
  }

  if (rollbackErrors.length > 0) {
    console.error("Warning: cleanup after the failed `ce start` was incomplete:");
    for (const message of rollbackErrors) {
      console.error(`  - ${message}`);
    }
    console.error("Run `ce cleanup --force` to finish removing any leftover resources.");
  }
}
