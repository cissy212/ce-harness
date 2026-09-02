import { existsSync } from "node:fs";
import { CeError } from "../core/errors.js";
import { parseWorkspaceSelector } from "../core/sanitize.js";
import {
  describeAvailableWorkspaces,
  readActivePointer,
  readWorkspace,
  resolveTrustedOpenSpec,
  workspaceExistsOnDisk,
  type ActivePointer,
} from "../core/workspace.js";
import { DEFAULT_EDITOR, formatOpenCommand, openInEditor } from "../core/editor.js";
import { activeChangeRoot, resolveActiveChangesForWorkspace } from "../core/activeChange.js";

export interface OpenCommandOptions {
  /**
   * `<project>/<issue>` selector (see `ce status`) to open a specific
   * workspace instead of the current default. Purely a read: unlike
   * `ce resume`, this never changes which workspace is the default,
   * even when given explicitly -- looking at a workspace is never
   * itself "switching to" it.
   */
  workspace?: string;
  /**
   * `undefined` (the default): open the resolved workspace's worktree,
   * unchanged from before this option existed. `true` (`--change` with
   * no value): open the sole active OpenSpec change's artifacts,
   * refusing if there is zero or more than one. A string (`--change
   * <name>`): open that exact active change's artifacts by name.
   */
  change?: string | true;
}

/**
 * `ce open`: opens either a workspace's worktree, or (with `--change`)
 * its OpenSpec change directory -- `explore.md`, `enrich.md`,
 * `proposal.md`, `design.md`, `tasks.md`, `specs/`, `reports/`,
 * whichever of them exist -- directly in an editor, so the user never
 * has to learn the durable store's internal path (Project Identity, the
 * store root, etc. -- see `ce status`) just to see what
 * `/explore`/`/enrich`/`/propose` produced. Which workspace: the one
 * given by `options.workspace` (`<project>/<issue>`), or the current
 * default if omitted. Purely a convenience over information ce-harness
 * already has -- creates nothing, registers nothing, and never modifies
 * `workspace.yml` or the active-default pointer, regardless of whether
 * a workspace was given explicitly.
 */
export async function openCommand(options: OpenCommandOptions = {}): Promise<void> {
  const pointer: ActivePointer | null = options.workspace
    ? parseWorkspaceSelector(options.workspace)
    : await readActivePointer();

  if (!pointer) {
    throw new CeError(
      "No active workspace.",
      ["Start one with:", "", "  ce start <repo> <issue>"].join("\n"),
    );
  }

  if (options.workspace && !workspaceExistsOnDisk(pointer.project, pointer.sanitizedIssue)) {
    throw new CeError(
      `No workspace found for "${pointer.project}/${pointer.sanitizedIssue}".`,
      await describeAvailableWorkspaces(),
    );
  }

  // Never repairs anything found to be wrong here -- only ever reports
  // it and points at `ce cleanup --force`, exactly like `ce resume`.
  // `readWorkspace` itself already covers a missing/corrupt
  // workspace.yml, re-thrown here with the recorded project/issue for
  // context, since the underlying error can't know those once the file
  // it would read them from is gone.
  let worktreePath: string;
  let workspace: Awaited<ReturnType<typeof readWorkspace>>;
  try {
    workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);
    worktreePath = workspace.worktreePath;
  } catch (error) {
    const detail = error instanceof CeError ? error.message : (error as Error).message;
    throw new CeError(
      `Cannot open workspace for project "${pointer.project}", issue "${pointer.sanitizedIssue}" -- its metadata could not be read: ${detail}`,
      `Run \`ce cleanup --force ${pointer.project}/${pointer.sanitizedIssue}\` to discard this workspace, then \`ce start\` again.`,
    );
  }

  if (options.change === undefined) {
    if (!existsSync(worktreePath)) {
      throw new CeError(
        `Cannot open workspace for project "${pointer.project}", issue "${pointer.sanitizedIssue}" -- its worktree is missing.`,
        `Worktree not found at "${worktreePath}". Run \`ce cleanup --force ${pointer.project}/${pointer.sanitizedIssue}\` to discard this workspace, then \`ce start\` again.`,
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
    return;
  }

  // --change: open an OpenSpec change's artifacts instead of the
  // worktree. Requires a trusted, durable-or-legacy OpenSpec store to
  // resolve which durable root to look under -- exactly the same
  // resolution `ce status` already uses.
  const trusted = resolveTrustedOpenSpec(workspace);
  if (!trusted) {
    throw new CeError(
      "This workspace has no trusted OpenSpec store to open a change from.",
      "Run `ce status` for details, or `ce start`/`ce migrate-openspec` to provision one.",
    );
  }

  // Narrowed to changes `/propose` durably associated with *this*
  // workspace (see core/activeChange.ts) -- the durable store is shared
  // across every workspace for the project, so an un-narrowed list can't
  // tell two workspaces' changes apart once each has its own. Falls back
  // to this workspace's own untagged/legacy candidates when it has no
  // exact match -- never to a change tagged for a different workspace.
  const activeChanges = await resolveActiveChangesForWorkspace(
    trusted.root,
    workspace.project,
    workspace.issue,
  );
  let changeName: string;
  if (typeof options.change === "string") {
    if (!activeChanges.includes(options.change)) {
      throw new CeError(
        `No active OpenSpec change named "${options.change}".`,
        activeChanges.length > 0
          ? `Active changes: ${activeChanges.join(", ")}.`
          : "There are no active OpenSpec changes for this project yet -- run `/explore` inside the workspace first.",
      );
    }
    changeName = options.change;
  } else {
    if (activeChanges.length === 0) {
      throw new CeError(
        "No active OpenSpec change to open.",
        "Run `/explore` inside the workspace first to create one.",
      );
    }
    if (activeChanges.length > 1) {
      throw new CeError(
        "Multiple active OpenSpec changes exist -- pick one.",
        `Active changes: ${activeChanges.join(", ")}.\nOpen one with: ce open --change <name>`,
      );
    }
    changeName = activeChanges[0];
  }

  const changeRoot = activeChangeRoot(trusted.root, changeName);
  if (!existsSync(changeRoot)) {
    throw new CeError(
      `Change "${changeName}"'s directory no longer exists.`,
      `Expected it at "${changeRoot}".`,
    );
  }

  console.log(`Opening change "${changeName}" in ${DEFAULT_EDITOR.label}...`);
  const result = await openInEditor(changeRoot);
  if (!result.opened) {
    throw new CeError(
      `Failed to open the change in ${DEFAULT_EDITOR.label}: ${result.message}`,
      `Open it manually with:\n  ${formatOpenCommand(changeRoot)}`,
    );
  }
}
