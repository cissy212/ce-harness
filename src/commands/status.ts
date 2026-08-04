import { existsSync } from "node:fs";
import { branchExists, statusPorcelain } from "../core/git.js";
import { readActivePointer, readWorkspace } from "../core/workspace.js";

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
  console.log(`Worktree path:    ${workspace.worktreePath}`);
  console.log(`Workspace path:   ${workspace.workspacePath}`);
  console.log(`Created at:       ${workspace.createdAt}`);
  console.log(`Worktree exists:  ${worktreeExists ? "yes" : "no"}`);
  console.log(`Branch exists:    ${branchStillExists ? "yes" : "no"}`);
  console.log(`Worktree changes: ${changesSummary}`);
}
