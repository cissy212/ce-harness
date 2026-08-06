import { existsSync } from "node:fs";
import { branchExists, statusPorcelain } from "../core/git.js";
import { readActivePointer, readWorkspace, resolveTrustedOpenSpec } from "../core/workspace.js";
import { isOpenSpecAvailable, storeDoctor } from "../core/openspec.js";
import { expectedOpenCodeConfigDir, openCodeConfigExists } from "../core/opencodeConfig.js";
import { expectedLensesDir, lensesDirExists } from "../core/lenses.js";

export async function statusCommand(): Promise<void> {
  const pointer = await readActivePointer();
  if (!pointer) {
    console.log("No active workspace.");
    return;
  }

  const workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);

  const worktreeExists = existsSync(workspace.worktreePath);
  const branchStillExists = await branchExists(workspace.repositoryPath, workspace.internalBranch);

  let changesSummary = "worktree does not exist";
  if (worktreeExists) {
    const changes = await statusPorcelain(workspace.worktreePath);
    changesSummary = changes.length === 0 ? "clean" : `${changes.length} changed file(s)`;
  }

  console.log(`Project:          ${workspace.project}`);
  console.log(`Issue:            ${workspace.issue}`);
  console.log(`Repository path:  ${workspace.repositoryPath}`);
  console.log(`Base branch:      ${workspace.baseBranch}`);
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

  const available = await isOpenSpecAvailable(workspace.workspacePath);
  if (!available) {
    console.log(`OpenSpec healthy: unavailable`);
    return;
  }

  const doctor = await storeDoctor(workspace.workspacePath, trusted.storeId);
  const healthy = doctor.found && doctor.healthy;
  console.log(`OpenSpec healthy: ${healthy ? "yes" : "no"}`);
}
