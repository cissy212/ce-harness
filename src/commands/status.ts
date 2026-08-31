import { existsSync } from "node:fs";
import { branchExists, isRegisteredWorktree, statusPorcelain } from "../core/git.js";
import {
  readActivePointer,
  readWorkspace,
  resolveTrustedOpenSpec,
  workspaceType,
} from "../core/workspace.js";
import { isOpenSpecAvailable, storeDoctor } from "../core/openspec.js";
import { readIdentityRecord } from "../core/projectIdentity.js";
import { expectedOpenCodeConfigDir, openCodeConfigExists } from "../core/opencodeConfig.js";
import { expectedLensesDir, lensesDirExists } from "../core/lenses.js";
import { filterHarnessManagedChanges } from "../core/worktreeArtifacts.js";

export async function statusCommand(): Promise<void> {
  const pointer = await readActivePointer();
  if (!pointer) {
    console.log("No active workspace.");
    return;
  }

  const workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);

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
        `Bootstrap:        required (${workspace.bootstrap.findings.length} item(s))`,
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

  const available = await isOpenSpecAvailable(workspace.workspacePath);
  if (!available) {
    console.log(`OpenSpec healthy: unavailable`);
    return;
  }

  const doctor = await storeDoctor(workspace.workspacePath, trusted.storeId);
  const healthy = doctor.found && doctor.healthy;
  console.log(`OpenSpec healthy: ${healthy ? "yes" : "no"}`);
}
