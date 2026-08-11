import { existsSync } from "node:fs";
import { CeError } from "../core/errors.js";
import { readActivePointer, readWorkspace } from "../core/workspace.js";
import { DEFAULT_EDITOR, formatOpenCommand, openInEditor } from "../core/editor.js";

/**
 * `ce open`: opens the active workspace's worktree directly in an
 * editor, so the user never has to remember or copy the worktree path
 * printed by `ce start`. Purely a convenience over information
 * ce-harness already has -- creates nothing, registers nothing, and
 * never modifies `workspace.yml`, exactly like `ce resume`.
 */
export async function openCommand(): Promise<void> {
  const pointer = await readActivePointer();
  if (!pointer) {
    throw new CeError(
      "No active workspace.",
      ["Start one with:", "", "  ce start <repo> <issue>"].join("\n"),
    );
  }

  // Never repairs anything found to be wrong here -- only ever reports
  // it and points at `ce cleanup --force`, exactly like `ce resume`.
  // `readWorkspace` itself already covers a missing/corrupt
  // workspace.yml, re-thrown here with the recorded project/issue for
  // context, since the underlying error can't know those once the file
  // it would read them from is gone.
  let worktreePath: string;
  try {
    const workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);
    worktreePath = workspace.worktreePath;
  } catch (error) {
    const detail = error instanceof CeError ? error.message : (error as Error).message;
    throw new CeError(
      `Cannot open workspace for project "${pointer.project}", issue "${pointer.sanitizedIssue}" -- its metadata could not be read: ${detail}`,
      "Run `ce cleanup --force` to discard this workspace, then `ce start` again.",
    );
  }

  if (!existsSync(worktreePath)) {
    throw new CeError(
      `Cannot open workspace for project "${pointer.project}", issue "${pointer.sanitizedIssue}" -- its worktree is missing.`,
      `Worktree not found at "${worktreePath}". Run \`ce cleanup --force\` to discard this workspace, then \`ce start\` again.`,
    );
  }

  console.log(`Opening "${worktreePath}" in ${DEFAULT_EDITOR.label}...`);
  const result = await openInEditor(worktreePath);
  if (!result.opened) {
    throw new CeError(
      `Failed to open the workspace in ${DEFAULT_EDITOR.label}: ${result.message}`,
      `Open it manually with:\n  ${formatOpenCommand(worktreePath)}`,
    );
  }
}
