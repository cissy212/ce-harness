import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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
import {
  activeChangeRoot,
  archivedChangeRoot,
  listArchivedChanges,
  readChangeOwnership,
  resolveActiveChangesForWorkspace,
} from "../core/activeChange.js";
import { expectedDurableOpenSpecRoot } from "../core/openspecId.js";
import { scanProjectIdentities } from "../core/projectIdentity.js";

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
  /**
   * Open an exact file or directory inside this workspace's trusted
   * OpenSpec store directly -- e.g. the exact report `/verify` or
   * `/adversarial-review` just wrote -- so the user never has to know or
   * navigate the durable store's internal path themselves. Rejected if
   * it doesn't resolve inside the store root, or if it doesn't exist.
   * Mutually exclusive with `change`: `--change` opens a whole change's
   * artifact directory by name, `--path` opens one exact path.
   */
  path?: string;
  /**
   * Open an *archived* OpenSpec change directly, addressed as
   * `<project>/<issue-or-name>` -- the exact identifiers `ce status
   * --all` shows for retained project history -- without requiring any
   * live/preserved workspace to exist for it (the whole point: a
   * workspace's own worktree/workspace directory is ephemeral and may
   * long since be `ce cleanup`-ed, but the durable OpenSpec store, and
   * what's archived in it, is not). `<project>` matches a known
   * project's id or its most recently recorded label; `<issue-or-name>`
   * matches an archived change's own persisted issue identifier first
   * (see `.ce-workspace.yml`), falling back to an exact match on the
   * change's name. Mutually exclusive with `workspace`, `change`, and
   * `path`.
   */
  archived?: string;
}

/**
 * `ce open`: opens either a workspace's worktree, (with `--change`) its
 * OpenSpec change directory -- `explore.md`, `enrich.md`, `proposal.md`,
 * `design.md`, `tasks.md`, `specs/`, `reports/`, whichever of them exist
 * -- or (with `--path`) one exact file or directory inside the trusted
 * store, directly in an editor, so the user never has to learn the
 * durable store's internal path (Project Identity, the store root, etc.
 * -- see `ce status`) just to see what `/explore`/`/enrich`/`/propose`
 * produced, or to open the exact report `/verify`/`/adversarial-review`
 * just wrote. Which workspace: the one given by `options.workspace`
 * (`<project>/<issue>`), or the current
 * default if omitted. Purely a convenience over information ce-harness
 * already has -- creates nothing, registers nothing, and never modifies
 * `workspace.yml` or the active-default pointer, regardless of whether
 * a workspace was given explicitly.
 *
 * `--archived <project>/<issue-or-name>` is the odd one out: it never
 * touches a workspace at all (not the active pointer, not
 * `workspace.yml`), resolving straight from Project Identity + the
 * durable store's own `archive/` directory instead -- see
 * `openArchivedChange` below. This is what lets `ce status --all`'s
 * retained history actually be opened, not just displayed, even for a
 * project with zero currently preserved workspaces.
 */
export async function openCommand(options: OpenCommandOptions = {}): Promise<void> {
  if (options.archived !== undefined) {
    if (options.workspace !== undefined || options.change !== undefined || options.path !== undefined) {
      throw new CeError(
        "--archived cannot be combined with [workspace], --change, or --path.",
        "Run `ce open --archived <project>/<issue-or-name>` on its own.",
      );
    }
    await openArchivedChange(options.archived);
    return;
  }

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

  if (options.path !== undefined) {
    if (options.change !== undefined) {
      throw new CeError(
        "--path and --change cannot be combined.",
        "Use `ce open --path <path>` to open one exact file/directory, or `ce open --change [name]` to open a change's whole artifact directory.",
      );
    }

    const trusted = resolveTrustedOpenSpec(workspace);
    if (!trusted) {
      throw new CeError(
        "This workspace has no trusted OpenSpec store to open a path from.",
        "Run `ce status` for details, or `ce start`/`ce migrate-openspec` to provision one.",
      );
    }

    const resolvedPath = resolve(options.path);
    const rel = relative(trusted.root, resolvedPath);
    const isInsideStore = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (!isInsideStore) {
      throw new CeError(
        `"${resolvedPath}" is not inside this workspace's OpenSpec store.`,
        `The store root is "${trusted.root}" -- --path only opens files/directories inside it.`,
      );
    }

    if (!existsSync(resolvedPath)) {
      throw new CeError(`"${resolvedPath}" does not exist.`, "Check the path and try again.");
    }

    console.log(`Opening "${resolvedPath}" in ${DEFAULT_EDITOR.label}...`);
    const result = await openInEditor(resolvedPath);
    if (!result.opened) {
      throw new CeError(
        `Failed to open "${resolvedPath}" in ${DEFAULT_EDITOR.label}: ${result.message}`,
        `Open it manually with:\n  ${formatOpenCommand(resolvedPath)}`,
      );
    }
    return;
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

/** Splits `--archived`'s `<project>/<issue-or-name>` selector. Deliberately not `parseWorkspaceSelector` -- that sanitizes its second segment as an *issue*, which would be wrong for a plain change-name match, and its error message talks about "workspace selector", not an archived-change one. */
function parseArchivedSelector(selector: string): { project: string; identifier: string } {
  const separatorIndex = selector.indexOf("/");
  const project = separatorIndex === -1 ? "" : selector.slice(0, separatorIndex).trim();
  const identifier = separatorIndex === -1 ? "" : selector.slice(separatorIndex + 1).trim();
  if (project.length === 0 || identifier.length === 0) {
    throw new CeError(
      `Invalid --archived selector "${selector}" -- expected the form <project>/<issue-or-name>.`,
      'e.g. "market-audit-tool/138" or "market-audit-tool/consolidate-drawer-base-component" -- run `ce status --all` to see retained projects and archived changes.',
    );
  }
  return { project, identifier };
}

/**
 * Opens an archived OpenSpec change directly by project + issue/name,
 * with no dependency on any live workspace -- see `OpenCommandOptions.archived`'s
 * doc comment above for the full resolution rules. Never guesses: an
 * ambiguous project or archived-change match refuses rather than picking
 * one, exactly like every other Project-Identity-aware resolution in
 * ce-harness.
 */
async function openArchivedChange(selector: string): Promise<void> {
  const { project, identifier } = parseArchivedSelector(selector);

  const identities = await scanProjectIdentities();
  const projectMatches = identities.filter((identity) => {
    const latestLabel = identity.evidence[identity.evidence.length - 1].project;
    return identity.projectId === project || latestLabel === project;
  });

  if (projectMatches.length === 0) {
    throw new CeError(
      `No known project matches "${project}".`,
      "Run `ce status --all` to see every known project and its identifiers.",
    );
  }
  if (projectMatches.length > 1) {
    throw new CeError(
      `More than one known project matches "${project}" -- ce-harness will not guess.`,
      `Matching project ids: ${projectMatches.map((m) => m.projectId).join(", ")}. ` +
        "Retry with the exact project id instead (see `ce status --all`).",
    );
  }

  const durableRoot = expectedDurableOpenSpecRoot(projectMatches[0].projectId);
  const archived = await listArchivedChanges(durableRoot);
  const withOwnership = await Promise.all(
    archived.map(async (entry) => ({
      entry,
      ownership: await readChangeOwnership(archivedChangeRoot(durableRoot, entry.archiveDirName)),
    })),
  );

  // Prefer the archived change's own persisted issue identifier (never
  // inferred or guessed -- see core/activeChange.ts's
  // readChangeOwnership) over a name match, falling back to matching
  // the change's own name only when no archived change in this project
  // was tagged with this exact issue -- e.g. one archived before the
  // ownership sidecar existed.
  const byIssue = withOwnership.filter(({ ownership }) => ownership?.issue === identifier);
  const candidates = byIssue.length > 0 ? byIssue : withOwnership.filter(({ entry }) => entry.name === identifier);

  if (candidates.length === 0) {
    throw new CeError(
      `No archived change matches "${identifier}" in project "${project}".`,
      "Run `ce status --all` to see this project's archived changes and their identifiers.",
    );
  }
  if (candidates.length > 1) {
    throw new CeError(
      `More than one archived change matches "${identifier}" in project "${project}" -- ce-harness will not guess.`,
      `Matching changes: ${candidates.map((c) => c.entry.name).join(", ")}. Retry with the exact change name instead.`,
    );
  }

  const { entry } = candidates[0];
  const changeRoot = archivedChangeRoot(durableRoot, entry.archiveDirName);
  if (!existsSync(changeRoot)) {
    throw new CeError(
      `Archived change "${entry.name}"'s directory no longer exists.`,
      `Expected it at "${changeRoot}".`,
    );
  }

  console.log(`Opening archived change "${entry.name}" in ${DEFAULT_EDITOR.label}...`);
  const result = await openInEditor(changeRoot);
  if (!result.opened) {
    throw new CeError(
      `Failed to open the archived change in ${DEFAULT_EDITOR.label}: ${result.message}`,
      `Open it manually with:\n  ${formatOpenCommand(changeRoot)}`,
    );
  }
}
