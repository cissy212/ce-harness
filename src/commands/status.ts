import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { branchExists, isRegisteredWorktree, statusPorcelain } from "../core/git.js";
import { CeError } from "../core/errors.js";
import { parseWorkspaceSelector } from "../core/sanitize.js";
import {
  describeAvailableWorkspaces,
  inferPrNumberFromIssue,
  listWorkspaces,
  readActivePointer,
  readWorkspace,
  resolveTrustedOpenSpec,
  workspaceExistsOnDisk,
  workspaceType,
  type Workspace,
  type ActivePointer,
} from "../core/workspace.js";
import { resolveLivePrHead } from "../core/github.js";
import { isOpenSpecAvailable, storeDoctor } from "../core/openspec.js";
import { readIdentityRecord } from "../core/projectIdentity.js";
import {
  activeChangeRoot,
  formatArtifactChecklist,
  readTaskProgress,
  resolveActiveChangesForWorkspace,
  summarizeChangeArtifacts,
} from "../core/activeChange.js";
import { checkStaleness, formatProvenanceSummary, type ProvenanceStage, type StalenessResult } from "../core/provenance.js";
import {
  deriveImplementationWorkflowStatus,
  deriveReviewWorkflowStatus,
  extractVerdict,
  formatProgressLine,
  latestReportFile,
  type ReportVerdict,
} from "../core/workflowStatus.js";
import { latestReviewForPr, latestReviewVerdict } from "../core/reviewReports.js";
import { expectedOpenCodeConfigDir, openCodeConfigExists } from "../core/opencodeConfig.js";
import { expectedLensesDir, lensesDirExists } from "../core/lenses.js";
import { filterHarnessManagedChanges } from "../core/worktreeArtifacts.js";
import { buildAllOverview } from "../core/allOverview.js";

export interface StatusOptions {
  /**
   * `<project>/<issue>` selector (see the "Other workspaces" section
   * this command prints) to inspect a specific workspace instead of the
   * current default. Purely a read: never changes which workspace is
   * the default, even when given explicitly. Mutually exclusive with
   * `all`.
   */
  workspace?: string;
  /**
   * Show the full, low-level detail this command showed unconditionally
   * before the concise default was introduced: internal paths, OpenSpec
   * store id/root, Project Identity evidence, config/lens directories,
   * etc. `false`/omitted gives the concise, human-oriented default.
   */
  verbose?: boolean;
  /**
   * Show a compact, cross-project overview of everything ce-harness has
   * durably retained -- every known project (from its OpenSpec store's
   * identity record, not just workspaces currently on disk), its
   * preserved workspaces, active changes, and archived/reviewed history.
   * Mutually exclusive with `workspace`.
   */
  all?: boolean;
}

export async function statusCommand(options: StatusOptions = {}): Promise<void> {
  if (options.all) {
    if (options.workspace) {
      throw new CeError(
        "`--all` cannot be combined with a specific workspace selector.",
        "Run `ce status --all` on its own for the cross-project overview, or `ce status [workspace]` to inspect one workspace.",
      );
    }
    await renderAllOverview();
    return;
  }

  const pointer: ActivePointer | null = options.workspace
    ? parseWorkspaceSelector(options.workspace)
    : await readActivePointer();

  if (!pointer) {
    console.log("No active workspace.");
    console.log(await describeAvailableWorkspaces());
    return;
  }

  if (options.workspace && !workspaceExistsOnDisk(pointer.project, pointer.sanitizedIssue)) {
    throw new CeError(
      `No workspace found for "${pointer.project}/${pointer.sanitizedIssue}".`,
      await describeAvailableWorkspaces(),
    );
  }

  const workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);

  if (options.verbose) {
    await renderVerbose(workspace);
  } else {
    await renderConcise(workspace);
  }
}

interface WorktreeSummary {
  worktreeExists: boolean;
  worktreeRegistered: boolean;
  branchStillExists: boolean;
  changesSummary: string;
}

async function computeWorktreeSummary(workspace: Workspace): Promise<WorktreeSummary> {
  const worktreeExists = existsSync(workspace.worktreePath);
  // `existsSync` alone is never proof this is still a valid, usable Git
  // worktree: a previous `ce cleanup`/`git worktree remove` can fail
  // partway through in a way that removes Git's own registration while
  // the physical directory survives (see core/git.ts's
  // `isRegisteredWorktree` doc comment). Running a plain `git status`
  // against that orphaned directory would fail outright (it is no
  // longer a Git repository at all) -- checked explicitly here instead
  // of assumed, so that failure mode is reported clearly rather than
  // crashing this command.
  const worktreeRegistered =
    worktreeExists && (await isRegisteredWorktree(workspace.repositoryPath, workspace.worktreePath));
  const branchStillExists = await branchExists(workspace.repositoryPath, workspace.internalBranch);

  let changesSummary: string;
  if (!worktreeExists) {
    changesSummary = "worktree does not exist";
  } else if (!worktreeRegistered) {
    changesSummary =
      "orphaned -- directory exists, but Git no longer registers it as a worktree (a previous " +
      "`ce cleanup` likely failed partway through; re-run `ce cleanup` to finish removing it)";
  } else {
    const changes = await statusPorcelain(workspace.worktreePath);
    // Excludes only entries proven, via cross-checked workspace metadata,
    // to be a harness-managed ephemeral artifact (e.g. a CodeGraph index
    // ce-harness itself provisioned) -- never a by-name exclusion, and
    // never anything that could hide a real tracked-file change.
    const significantChanges = filterHarnessManagedChanges(changes, workspace);
    changesSummary =
      significantChanges.length === 0 ? "clean" : `${significantChanges.length} changed file(s)`;
  }

  return { worktreeExists, worktreeRegistered, branchStillExists, changesSummary };
}

async function printOtherWorkspaces(workspace: Workspace): Promise<void> {
  // Discoverability for the "many workspaces, one default" model (see
  // core/workspace.ts's `ActivePointer` doc comment): every other
  // preserved workspace, so a user is never left wondering whether one
  // still exists just because it isn't the default shown above.
  const others = (await listWorkspaces()).filter(
    (w) => !(w.project === workspace.project && w.sanitizedIssue === workspace.sanitizedIssue),
  );
  if (others.length > 0) {
    console.log(`Other workspaces: ${others.map((o) => `${o.project}/${o.sanitizedIssue}`).join(", ")}`);
  }
}

/** Reads a change's most recent report (by suffix) and extracts its verdict, if any. Never throws. */
async function readLatestVerdict(changeRoot: string, reports: string[], suffix: string): Promise<ReportVerdict | null> {
  const filename = latestReportFile(reports, suffix);
  if (!filename) return null;
  try {
    const content = await readFile(join(changeRoot, "reports", filename), "utf8");
    return extractVerdict(content);
  } catch {
    return null;
  }
}

/**
 * Resolves an Existing PR review workspace's verdict plus, best-effort,
 * whether that review is now stale (the pull request has new commits
 * since it ran). Never throws, and never makes a network call at all
 * unless a PR number can actually be identified for this workspace
 * (structured `workspace.prReview`, or -- for a workspace created before
 * that field existed -- `inferPrNumberFromIssue`'s legacy bridge): a
 * plain `ce start --base --head` workspace (never went through `ce
 * review`) always resolves with `staleness: undefined`, exactly as
 * before this feature existed.
 */
interface PrReviewStatusResult {
  verdict: ReportVerdict | null;
  staleness?: { reviewedHead: string | null; currentHead: string; reviewedHeadInferred: boolean };
  /** See `deriveReviewWorkflowStatus`'s field of the same name -- a legacy report exists somewhere in this project's shared `reviews/` directory, but could not be confirmed to belong to this exact PR. */
  unattributableLegacyReport?: boolean;
}

async function resolvePrReviewStatus(workspace: Workspace, durableRoot: string): Promise<PrReviewStatusResult> {
  const prNumber = workspace.prReview?.number ?? inferPrNumberFromIssue(workspace.issue);
  if (prNumber === null) {
    return { verdict: await latestReviewVerdict(durableRoot) };
  }

  const lookup = await latestReviewForPr(durableRoot, prNumber);

  if (lookup.kind === "none") {
    return { verdict: null };
  }
  if (lookup.kind === "unattributable") {
    // A legacy report exists in this project's shared `reviews/`
    // directory, but its own **Pull request:**/title fields didn't
    // confirm it as this PR's -- never guess; report this PR as not yet
    // reviewed, with an explicit caveat, rather than risking someone
    // else's findings.
    return { verdict: null, unattributableLegacyReport: true };
  }

  const verdict = lookup.verdict;
  if (verdict === null) {
    // Nothing has been reviewed yet -- "stale" is meaningless until a
    // first review exists, so never attempt (or need) the live check.
    return { verdict: null };
  }

  // Three tiers, most authoritative first:
  // 1. The report's own `**Reviewed PR head:**` field (every report
  //    written by this feature's version of the template).
  // 2. `prReview.initialDiffHead` -- present whenever this workspace has
  //    ever been touched by `ce review`'s PR-tracking machinery (created
  //    or backfilled). Stable across every refresh, unlike `diffHead`
  //    itself -- see `PrReviewMetadataSchema`'s doc comment for exactly
  //    why `diffHead` alone would be wrong here once a refresh has moved
  //    it past what a legacy report actually reviewed.
  // 3. `workspace.diffHead` -- only when `prReview` is entirely absent,
  //    which itself proves this workspace has *never* been refreshed
  //    (refreshing always sets `prReview`), so `diffHead` still equals
  //    whatever a pre-existing legacy report reviewed.
  const reviewedHead = lookup.reviewedHead ?? workspace.prReview?.initialDiffHead ?? workspace.diffHead ?? null;
  const reviewedHeadInferred = lookup.reviewedHead === null;

  const currentHead = await resolveLivePrHead(workspace.repositoryPath, prNumber);
  if (!currentHead) {
    // `gh` unavailable/unauthenticated, offline, or the PR couldn't be
    // resolved live -- degrade to exactly today's behavior (verdict
    // shown, no staleness claim made either way).
    return { verdict };
  }

  return { verdict, staleness: { reviewedHead, currentHead, reviewedHeadInferred } };
}

// ---------------------------------------------------------------------
// Concise (default) rendering
// ---------------------------------------------------------------------

async function renderConcise(workspace: Workspace): Promise<void> {
  const { changesSummary } = await computeWorktreeSummary(workspace);

  console.log(`Project:          ${workspace.project}`);
  console.log(`Issue:            ${workspace.issue}`);
  console.log(`Type:             ${workspaceType(workspace)}`);
  console.log(`Worktree:         ${changesSummary}`);

  const attention: string[] = [];

  if (!workspace.openSpec) {
    console.log();
    await printOtherWorkspaces(workspace);
    return;
  }

  const trusted = resolveTrustedOpenSpec(workspace);
  if (!trusted) {
    console.log();
    console.log(`Needs attention:`);
    console.log(`  - OpenSpec metadata for this workspace is invalid or corrupted -- run \`ce cleanup --force\`, then \`ce start\` again.`);
    await printOtherWorkspaces(workspace);
    return;
  }

  if (workspace.bootstrap?.required) {
    attention.push("This repository needs local setup before /apply or /verify (see below).");
  }

  const activeChanges = await resolveActiveChangesForWorkspace(trusted.root, workspace.project, workspace.issue);

  console.log();

  if (workspaceType(workspace) === "Existing PR review") {
    const { verdict, staleness, unattributableLegacyReport } = await resolvePrReviewStatus(workspace, trusted.root);

    const review = deriveReviewWorkflowStatus({ reviewVerdict: verdict, staleness, unattributableLegacyReport });
    console.log(`Review:           ${review.summaryLine}`);
    if (review.staleness) {
      console.log(`Previous verdict: ${verdict}`);
      console.log(`Reviewed HEAD:    ${review.staleness.reviewedHead ?? "unknown"}`);
      console.log(`Current HEAD:     ${review.staleness.currentHead}`);
    }
    attention.push(...review.attention);
    printAttentionAndNextStep(attention, review.nextStep);
    printBootstrapFindings(workspace);
    await printOtherWorkspaces(workspace);
    return;
  }

  if (activeChanges.length === 0) {
    console.log(`Active change:    (none)`);
    printAttentionAndNextStep(attention, "/explore (or /propose if you already know what to build)");
    printBootstrapFindings(workspace);
    await printOtherWorkspaces(workspace);
    return;
  }

  if (activeChanges.length > 1) {
    console.log(`Active changes:   ${activeChanges.join(", ")}`);
    console.log(`                  (more than one -- see \`ce status --verbose\` or \`ce open --change <name>\` to inspect one)`);
    printAttentionAndNextStep(attention, "inspect one with `ce open --change <name>`");
    printBootstrapFindings(workspace);
    await printOtherWorkspaces(workspace);
    return;
  }

  const changeName = activeChanges[0];
  const changeRoot = activeChangeRoot(trusted.root, changeName);
  const [summary, taskProgress, openSpecHealthy] = await Promise.all([
    summarizeChangeArtifacts(changeRoot),
    readTaskProgress(join(changeRoot, "tasks.md")),
    checkOpenSpecHealthy(workspace, trusted.storeId),
  ]);

  const stagePresence: [ProvenanceStage, boolean][] = [
    ["explore", summary.explore.present],
    ["enrich", summary.enrich.present],
    ["propose", summary.proposal.present],
  ];
  const provenance: { stage: ProvenanceStage; result: StalenessResult }[] = await Promise.all(
    stagePresence
      .filter(([, present]) => present)
      .map(async ([stage]) => ({ stage, result: await checkStaleness(changeRoot, stage, workspace.worktreePath) })),
  );

  const [verifyVerdict, adversarialVerdict] = await Promise.all([
    readLatestVerdict(changeRoot, summary.reports, "verify"),
    readLatestVerdict(changeRoot, summary.reports, "adversarial-review"),
  ]);

  const workflow = deriveImplementationWorkflowStatus({
    summary,
    provenance,
    taskProgress,
    verifyVerdict,
    adversarialVerdict,
    bootstrapRequired: workspace.bootstrap?.required ?? false,
  });

  console.log(`Active change:    ${changeName}`);
  console.log(`Progress:         ${workflow.progressLine}`);

  if (openSpecHealthy === false) {
    attention.push("The OpenSpec store reports an unhealthy state -- see `ce status --verbose` for detail.");
  }
  attention.push(...workflow.attention);

  printAttentionAndNextStep(attention, workflow.nextStep);
  printBootstrapFindings(workspace);

  await printOtherWorkspaces(workspace);
}

function printAttentionAndNextStep(attention: string[], nextStep: string): void {
  if (attention.length > 0) {
    console.log();
    console.log(`Needs attention:`);
    for (const item of attention) {
      console.log(`  - ${item}`);
    }
  }
  console.log();
  console.log(`Next step:        ${nextStep}`);
}

/** The exact commands to fix each repository-bootstrap finding, printed once regardless of which active-change branch (none/one/many) is otherwise showing. No-op when bootstrap isn't required, or predates this workspace's bootstrap detection. */
function printBootstrapFindings(workspace: Workspace): void {
  if (!workspace.bootstrap?.required) return;
  console.log();
  console.log(`Local setup needed:`);
  for (const finding of workspace.bootstrap.findings) {
    console.log(`  - ${finding.message}`);
    console.log(`    Run: ${finding.suggestedCommand}`);
    if (finding.sideEffectWarning) {
      console.log(`    Warning: ${finding.sideEffectWarning}`);
    }
  }
}

async function checkOpenSpecHealthy(workspace: Workspace, storeId: string): Promise<boolean | null> {
  const available = await isOpenSpecAvailable(workspace.workspacePath);
  if (!available) return null;
  const doctor = await storeDoctor(workspace.workspacePath, storeId);
  return doctor.found && doctor.healthy;
}

// ---------------------------------------------------------------------
// Verbose rendering -- the full, low-level detail this command always
// showed before the concise default was introduced. Unchanged from that
// original behavior; nothing here should differ from what a user of an
// older ce-harness version already saw.
// ---------------------------------------------------------------------

async function renderVerbose(workspace: Workspace): Promise<void> {
  const { worktreeExists, worktreeRegistered, branchStillExists, changesSummary } =
    await computeWorktreeSummary(workspace);

  console.log(`Project:          ${workspace.project}`);
  console.log(`Issue:            ${workspace.issue}`);
  console.log(`Workspace type:   ${workspaceType(workspace)}`);
  console.log(`Repository path:  ${workspace.repositoryPath}`);
  console.log(`Base branch:      ${workspace.baseBranch}${workspace.baseRefExplicit ? " (explicit, via --from)" : ""}`);
  // Only present for the default (auto-detected) flow -- an explicit
  // --base/--head workspace already reports its exact commits via the
  // Review base/head/merge-base lines below, so this is never printed
  // alongside those.
  if (workspace.baseBranchCommit) {
    console.log(`Base commit:      ${workspace.baseBranchCommit}`);
  }
  console.log(`Internal branch:  ${workspace.internalBranch}`);
  // Only present for an explicit --base/--head review range; absent
  // entirely (no placeholder lines) for the default flow and for every
  // workspace created before this field existed.
  if (workspace.diffBase && workspace.diffHead) {
    console.log(`Review base:      ${workspace.diffBase}`);
    console.log(`Review head:      ${workspace.diffHead}`);
    if (workspace.diffMergeBase) {
      console.log(`Review merge base: ${workspace.diffMergeBase}`);
    }
  }
  console.log(`Worktree path:    ${workspace.worktreePath}`);
  console.log(`Workspace path:   ${workspace.workspacePath}`);
  console.log(`Created at:       ${workspace.createdAt}`);
  console.log(`Worktree exists:  ${worktreeExists ? "yes" : "no"}`);
  // Only printed when it's actually informative: absent for a worktree
  // that doesn't exist at all (nothing to be registered either way) and
  // for the normal case (exists and is registered), so this line's mere
  // presence itself flags the orphaned state to a human skimming the
  // output.
  if (worktreeExists && !worktreeRegistered) {
    console.log(`Worktree registered: no (orphaned)`);
  }
  console.log(`Branch exists:    ${branchStillExists ? "yes" : "no"}`);
  console.log(`Worktree changes: ${changesSummary}`);

  await printOtherWorkspaces(workspace);

  // The OpenCode config directory path is fully deterministic from
  // workspacePath, so it applies to every workspace regardless of
  // schema, with no persisted field required.
  console.log(`OpenCode config:        ${expectedOpenCodeConfigDir(workspace.workspacePath)}`);
  console.log(`OpenCode config exists: ${openCodeConfigExists(workspace.workspacePath) ? "yes" : "no"}`);

  console.log(`Lenses dir:        ${expectedLensesDir(workspace.workspacePath)}`);
  console.log(
    `Lenses dir exists: ${lensesDirExists(workspace.workspacePath) ? "yes" : "no"}`,
  );

  // Workspaces created before the semantic-code-navigation integration
  // have no codeGraph block; skip this section entirely rather than
  // printing placeholder lines, same convention as the OpenSpec section
  // below.
  if (workspace.codeGraph) {
    if (workspace.codeGraph.available) {
      console.log(
        `CodeGraph:        available (index at ${workspace.codeGraph.indexPath}, initialized ${workspace.codeGraph.initializedAt})`,
      );
    } else {
      console.log(`CodeGraph:        not available (${workspace.codeGraph.reason ?? "unknown reason"})`);
    }
  }

  // Workspaces created before repository-bootstrap detection have no
  // bootstrap block; skip this section entirely, same convention as the
  // CodeGraph section above.
  if (workspace.bootstrap) {
    if (!workspace.bootstrap.required) {
      console.log(`Bootstrap:        not required`);
    } else {
      console.log(
        `Bootstrap:        required before running code (e.g. \`/apply\`, \`/verify\`) -- ` +
          `not before \`/explore\`/\`/enrich\`/\`/propose\` (${workspace.bootstrap.findings.length} item(s))`,
      );
      for (const finding of workspace.bootstrap.findings) {
        console.log(`  - ${finding.message}`);
        console.log(`    Run: ${finding.suggestedCommand}`);
        if (finding.sideEffectWarning) {
          console.log(`    Warning: ${finding.sideEffectWarning}`);
        }
      }
    }
  }

  // Workspaces created without OpenSpec metadata have no openSpec block;
  // skip the OpenSpec section entirely rather than printing placeholder
  // lines.
  if (!workspace.openSpec) return;

  const trusted = resolveTrustedOpenSpec(workspace);
  if (!trusted) {
    console.log(`OpenSpec store:   (invalid or corrupted metadata)`);
    console.log(`OpenSpec root:    (invalid or corrupted metadata)`);
    console.log(`OpenSpec healthy: unavailable`);
    return;
  }

  console.log(`OpenSpec store:   ${trusted.storeId}`);
  console.log(`OpenSpec root:    ${trusted.root}`);
  console.log(
    `OpenSpec durable: ${
      trusted.durable
        ? "yes (survives `ce cleanup`)"
        : "no (removed by `ce cleanup` -- run `ce migrate-openspec` to preserve it in durable, project-scoped storage)"
    }`,
  );

  // Project Identity: only meaningful for a durable store (see
  // core/projectIdentity.ts). A durable store with no projectId is on
  // the pre-Project-Identity, path-hash-keyed shape -- `ce
  // migrate-openspec` assigns one without losing any existing data.
  if (trusted.durable) {
    if (trusted.projectId) {
      console.log(`Project id:       ${trusted.projectId}`);
      try {
        const identity = await readIdentityRecord(trusted.root);
        if (identity) {
          const latest = identity.evidence[identity.evidence.length - 1];
          console.log(
            `Identity evidence: ${identity.evidence.length} recorded snapshot(s), most recently ${latest.recordedAt}`,
          );
        } else {
          console.log(`Identity evidence: (missing -- .identity.yml not found at "${trusted.root}")`);
        }
      } catch (error) {
        console.log(`Identity evidence: unavailable (${(error as Error).message})`);
      }
    } else {
      console.log(
        `Project id:       (legacy durable store -- run \`ce migrate-openspec\` to assign one)`,
      );
    }
  }

  // Active OpenSpec change(s) and their artifacts: the primary
  // discovery mechanism for "where did /explore, /enrich, /propose
  // actually write their output" -- a user should never need to learn
  // Project Identity or the durable store's internal path just to
  // inspect this. Pure filesystem discovery (see core/activeChange.ts),
  // so it works even when the `openspec` binary itself is unavailable.
  // Narrowed to this workspace's own change(s) when `/propose` recorded
  // an association -- see core/activeChange.ts's doc comment -- falling
  // back to this workspace's own untagged/legacy candidates when it has
  // no exact match, never to a change tagged for a different workspace.
  const activeChanges = await resolveActiveChangesForWorkspace(
    trusted.root,
    workspace.project,
    workspace.issue,
  );
  if (activeChanges.length === 0) {
    console.log(`Active change:    (none)`);
  } else {
    for (const name of activeChanges) {
      const changeRoot = activeChangeRoot(trusted.root, name);
      const summary = await summarizeChangeArtifacts(changeRoot);
      console.log(`Active change:    ${name}`);
      console.log(`  Artifacts:      ${formatArtifactChecklist(summary)}`);

      // Provenance: whether each planning artifact still reflects the
      // worktree's current state, for whichever of them are actually
      // present. A stage with no recorded provenance (predates this
      // mechanism) is shown as "unknown" -- exactly as prominently as
      // "stale", never silently omitted -- since /enrich, /propose, and
      // /apply all now hard-gate on that same distinction. The whole
      // line is only omitted when no present stage has any provenance
      // concept to report on at all (impossible today, since presence
      // is exactly what gates whether a stage is checked -- kept as a
      // defensive fallback, not a real code path).
      const stagePresence: [ProvenanceStage, boolean][] = [
        ["explore", summary.explore.present],
        ["enrich", summary.enrich.present],
        ["propose", summary.proposal.present],
      ];
      const provenanceEntries = await Promise.all(
        stagePresence
          .filter(([, present]) => present)
          .map(async ([stage]) => ({
            stage,
            result: await checkStaleness(changeRoot, stage, workspace.worktreePath),
          })),
      );
      const provenanceLine = formatProvenanceSummary(provenanceEntries);
      if (provenanceLine) {
        console.log(`  Provenance:     ${provenanceLine}`);
      }
    }
    console.log(
      `View artifacts:   ce open --change${activeChanges.length > 1 ? " <name>" : ""}`,
    );
  }

  const available = await isOpenSpecAvailable(workspace.workspacePath);
  if (!available) {
    console.log(`OpenSpec healthy: unavailable`);
    return;
  }

  const doctor = await storeDoctor(workspace.workspacePath, trusted.storeId);
  const healthy = doctor.found && doctor.healthy;
  console.log(`OpenSpec healthy: ${healthy ? "yes" : "no"}`);
}

// ---------------------------------------------------------------------
// `--all`: cross-project, durable-history overview
// ---------------------------------------------------------------------

async function renderAllOverview(): Promise<void> {
  const overview = await buildAllOverview();

  if (overview.projects.length === 0 && overview.unresolved.length === 0) {
    console.log("ce-harness has no projects or workspaces yet.");
    console.log("Start one with:");
    console.log();
    console.log("  ce start <repo> <issue>");
    return;
  }

  console.log(
    `ce-harness knows about ${overview.projects.length} project(s):`,
  );

  for (const project of overview.projects) {
    console.log();
    console.log(`${project.label}  (project id ${project.projectId})`);

    if (project.workspaces.length > 0) {
      console.log(
        `  Workspaces:     ${project.workspaces
          .map((w) => `${w.issue}${w.isDefault ? " (default)" : ""}`)
          .join(", ")}`,
      );
    } else {
      console.log(`  Workspaces:     (none currently preserved)`);
    }

    if (project.activeChanges.length > 0) {
      for (const change of project.activeChanges) {
        console.log(`  Active change:  ${change.name}  (${change.progressLine})`);
      }
    } else {
      console.log(`  Active changes: (none)`);
    }

    if (project.archivedCount > 0) {
      console.log(`  Archived:       ${project.archivedCount} change(s)`);
      for (const entry of project.recentArchived) {
        // The original issue/workspace identifier, when its
        // `.ce-workspace.yml` ownership sidecar survived into the
        // archive -- never guessed or inferred from the change's own
        // name. A pre-ownership-sidecar archived change just shows its
        // name, cleanly, with no fabricated identifier.
        console.log(entry.issue ? `    ${entry.issue}  ${entry.name}` : `    ${entry.name}`);
      }
    } else {
      console.log(`  Archived:       (none)`);
    }

    console.log(
      `  Reviews:        ${project.reviewCount > 0 ? `${project.reviewCount} PR review(s) logged` : "(none)"}`,
    );
  }

  if (overview.unresolved.length > 0) {
    console.log();
    console.log(
      `${overview.unresolved.length} preserved workspace(s) have no durable project history yet (legacy or not yet OpenSpec-enabled):`,
    );
    for (const w of overview.unresolved) {
      console.log(`  ${w.project}/${w.issue}${w.isDefault ? " (default)" : ""}`);
    }
  }
}
