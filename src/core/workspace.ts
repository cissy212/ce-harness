import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { CeError } from "./errors.js";
import { activePointerFile, workspaceFile, workspacePath, workspacesRoot } from "./paths.js";
import {
  expectedDurableOpenSpecRoot,
  expectedLegacyDurableOpenSpecRoot,
  expectedOpenSpecRoot,
  generateLegacyProjectStoreId,
  generateProjectStoreId,
  generateStoreId,
  isValidProjectId,
  isValidStoreId,
} from "./openspecId.js";

export const OpenSpecMetadataSchema = z.object({
  storeId: z.string().min(1),
  root: z.string().min(1),
  // Optional: true only for a project-scoped, durable store -- one that
  // lives outside every ephemeral workspace/worktree (see
  // expectedDurableOpenSpecRoot) and survives `ce cleanup`. Absent/false
  // for a legacy, per-workspace store created before durable storage
  // existed, which remains exactly as ephemeral as it always was: `ce
  // cleanup` still unregisters and deletes those, unchanged, so an
  // already-active legacy workspace never silently changes behavior
  // just because the CLI was upgraded underneath it. See
  // resolveTrustedOpenSpec for how each shape is recomputed and
  // cross-checked, and `ce migrate-openspec` for the explicit, opt-in
  // way to move a legacy workspace onto a durable store.
  durable: z.boolean().optional(),
  // Present only for a durable store keyed by the current, Project-
  // Identity scheme (core/projectIdentity.ts) -- absent for a durable
  // store created before Project Identity existed (the legacy,
  // path-hash-keyed shape; see generateLegacyProjectStoreId). Never
  // present when `durable` is falsy: an issue-scoped, ephemeral store
  // has no project identity of its own. See resolveTrustedOpenSpec for
  // exactly how this field changes which id/root are recomputed and
  // cross-checked.
  projectId: z.string().min(1).optional(),
});

export type OpenSpecMetadata = z.infer<typeof OpenSpecMetadataSchema>;

/**
 * Optional semantic-code-navigation adapter state (CodeGraph today).
 * `available`/`managedByHarness` are independent flags: this
 * implementation only ever sets `available: true` when
 * `managedByHarness` is also true (ce-harness never wires up navigation
 * for an index it did not create and cannot vouch for), but the schema
 * does not hard-couple them, in case a future adapter safely verifies a
 * pre-existing index without claiming ownership of it.
 */
export const CodeGraphMetadataSchema = z
  .object({
    available: z.boolean(),
    managedByHarness: z.boolean(),
    indexPath: z.string().min(1).optional(),
    initializedAt: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .refine((c) => !c.available || (c.indexPath !== undefined && c.initializedAt !== undefined), {
    message: "available CodeGraph metadata requires indexPath and initializedAt",
  });

export type CodeGraphMetadata = z.infer<typeof CodeGraphMetadataSchema>;

/**
 * Optional repository-bootstrap detection result, recorded once at `ce
 * start` time so `ce status` can show it again later without
 * re-inspecting the worktree. Purely informational: nothing in
 * ce-harness ever acts on this beyond displaying it -- see
 * src/core/bootstrap.ts for the read-only detection itself.
 */
export const BootstrapMetadataSchema = z.object({
  required: z.boolean(),
  findings: z.array(
    z.object({
      ecosystem: z.string().min(1),
      manifest: z.string().min(1),
      message: z.string().min(1),
      suggestedCommand: z.string().min(1),
      // Optional: set only when suggestedCommand cannot avoid a side
      // effect beyond the minimum necessary action (e.g. a full install
      // potentially rewriting a lockfile). Absent for a targeted,
      // minimal command that doesn't carry that risk. Absent on
      // findings persisted before this field existed.
      sideEffectWarning: z.string().min(1).optional(),
    }),
  ),
});

export type BootstrapMetadata = z.infer<typeof BootstrapMetadataSchema>;

/**
 * Records which worktree-local artifacts the selected runner (see
 * `runner` below and core/runners/index.ts) actually wrote and owns for
 * this workspace, as opposed to safely skipping because a pre-existing
 * path it did not create was already there. Deliberately runner-agnostic
 * in name and shape -- it is written unconditionally by `ce start` from
 * whatever `RunnerSpec.writeConfig`/`writeCodeGraphConfig` already
 * return, never gated on which runner id was selected, so this schema
 * carries no runner-specific knowledge itself (e.g. it says nothing
 * about `.claude` or `.mcp.json` by name -- only each RunnerSpec's own
 * `managedWorktreeRelativePaths` interprets these values into paths).
 *
 * `commandsManaged` is an array of the individual, runner-config-root-
 * relative paths (e.g. `"commands/adversarial-review.md"`,
 * `"skills/openspec-sync-specs"`) actually written this run -- per-item
 * ownership, not an all-or-nothing flag, so a repository that already
 * owns one command or skill doesn't cost every other one. It also
 * accepts a plain `boolean`, for reading a workspace.yml persisted by a
 * version of ce-harness that predates per-item tracking: `true` meant
 * "the whole config directory was freshly written" and `false` meant
 * "safely skipped entirely" -- readers must still treat both legacy
 * shapes as valid.
 *
 * `commandsManaged`/`mcpManaged` being `false`/`[]` (or absent) is the
 * normal, expected value for a runner whose config never lives inside
 * the worktree at all (e.g. OpenCode) -- it is not itself a sign of a
 * conflict.
 */
export const RunnerWorktreeArtifactsSchema = z.object({
  commandsManaged: z.union([z.boolean(), z.array(z.string().min(1))]),
  mcpManaged: z.boolean().optional(),
  // Optional: SHA-256 hex digest of each `commandsManaged`-relative path's
  // content at the moment ce-harness itself last wrote it there. Populated
  // by `ce refresh` (never by `ce start`, which has no need for it yet --
  // see core/runners/claude.ts's refreshConfig). This is what lets refresh
  // prove a harness-managed file is still exactly what ce-harness wrote
  // before safely overwriting it with updated template content, without
  // ever touching a file a human has since hand-edited. Absent entirely on
  // every workspace that has never been refreshed; a `commandsManaged`
  // path with no entry here yet is handled by refresh's own
  // bootstrap-on-first-refresh logic, never treated as an error.
  commandsManagedHashes: z.record(z.string().min(1), z.string().min(1)).optional(),
});

export type RunnerWorktreeArtifacts = z.infer<typeof RunnerWorktreeArtifactsSchema>;

/**
 * Structured GitHub PR identity for an Existing PR review workspace,
 * persisted by `ce review` so a later `ce status`/`ce review` can tell
 * which pull request this workspace reviews without parsing `issue`
 * (see `inferPrNumberFromIssue` below for the legacy bridge that exists
 * only because older workspaces predate this field). Deliberately just
 * the number -- never a repository slug -- since the slug is cheaply and
 * reliably re-derived live from the repository's own `origin` remote
 * (see `core/github.ts`'s `parseGithubSlug`, already used identically by
 * `ce publish`) rather than persisted and risking drifting stale if the
 * remote ever changes.
 */
export const PrReviewMetadataSchema = z.object({
  number: z.number().int().positive(),
});

export type PrReviewMetadata = z.infer<typeof PrReviewMetadataSchema>;

export const WorkspaceSchema = z
  .object({
    project: z.string().min(1),
    repositoryPath: z.string().min(1),
    issue: z.string().min(1),
    sanitizedIssue: z.string().min(1),
    baseBranch: z.string().min(1),
    // Optional: the exact commit `baseBranch` resolved to when `ce
    // start` created this workspace via the default (auto-detected)
    // flow. Absent for an explicit --base/--head workspace, where
    // diffBase/diffHead/diffMergeBase already capture the exact commits
    // -- this field is never set alongside those, to avoid persisting
    // the same fact twice under two names. Absent on workspaces created
    // before this field existed.
    baseBranchCommit: z.string().min(1).optional(),
    internalBranch: z.string().min(1),
    worktreePath: z.string().min(1),
    workspacePath: z.string().min(1),
    createdAt: z.string().min(1),
    // Optional: older workspace files predate OpenSpec integration and
    // have no openSpec block. Readers must treat its absence as valid.
    openSpec: OpenSpecMetadataSchema.optional(),
    // Optional: only present when `ce start` was given an explicit
    // --base/--head review range instead of using the local main/master
    // tip. Resolved, immutable commit SHAs -- never raw refs. Absent on
    // every workspace created with the default flow, and on all
    // workspaces that predate this field.
    diffBase: z.string().min(1).optional(),
    diffHead: z.string().min(1).optional(),
    // Optional: the merge base of diffBase/diffHead at the time `ce
    // start` resolved them, persisted so `status` can show the exact
    // effective comparison point without recomputing it. Only ever set
    // together with diffBase/diffHead.
    diffMergeBase: z.string().min(1).optional(),
    // Optional: older workspace files predate the semantic-code-navigation
    // integration and have no codeGraph block. Readers must treat its
    // absence as valid, exactly like the openSpec block above.
    codeGraph: CodeGraphMetadataSchema.optional(),
    // Optional: older workspace files predate repository-bootstrap
    // detection and have no bootstrap block. Readers must treat its
    // absence as valid, exactly like the codeGraph block above.
    bootstrap: BootstrapMetadataSchema.optional(),
    // Optional: the coding-agent runner id (e.g. "opencode", "claude")
    // `ce start` launched for this workspace, so `ce resume` launches
    // the same one. Absent on workspaces created before runner
    // selection existed -- readers must treat its absence as meaning
    // "opencode" (see core/runners/index.ts's resolveRunner), never as
    // an error.
    runner: z.string().min(1).optional(),
    // Optional: see RunnerWorktreeArtifactsSchema above. Absent on
    // workspaces created before this field existed, and on any
    // workspace whose runner never writes anything inside the worktree.
    runnerWorktreeArtifacts: RunnerWorktreeArtifactsSchema.optional(),
    // Optional: true only when `ce start --from <ref>` explicitly chose
    // this workspace's starting point, rather than `detectBaseBranch`
    // auto-detecting it. Pure provenance -- `baseBranch`/`baseBranchCommit`
    // are populated identically either way (a display ref plus its
    // resolved commit), so `CE_BASE_BRANCH` and every other consumer work
    // unchanged for both cases; this field exists only so `ce status` (and
    // any future reader) can tell "the user explicitly picked this" apart
    // from "ce-harness detected this", without overloading `baseBranch`
    // itself with meaning its name doesn't carry. Absent (falsy) for
    // every workspace created before this flag existed, and always absent
    // for an explicit --base/--head review workspace (see the refine
    // below) -- `--from` and `--base`/`--head` are mutually exclusive at
    // the CLI level already, so this is a defensive invariant, never a
    // real code path.
    baseRefExplicit: z.boolean().optional(),
    // Optional: only ever present for an Existing PR review workspace
    // created (or refreshed -- see `ce review`'s follow-up path) by `ce
    // review` itself. Absent for a plain `ce start --base --head`
    // workspace (never went through `ce review`, so there is no GitHub
    // PR to name) and for every review workspace created before this
    // field existed -- see `inferPrNumberFromIssue` for how `ce
    // status`/`ce review` recover a best-effort PR number for those.
    prReview: PrReviewMetadataSchema.optional(),
  })
  .refine((w) => (w.diffBase === undefined) === (w.diffHead === undefined), {
    message: "diffBase and diffHead must both be present or both be absent",
  })
  .refine((w) => w.diffMergeBase === undefined || (w.diffBase !== undefined && w.diffHead !== undefined), {
    message: "diffMergeBase requires diffBase and diffHead to also be present",
  })
  .refine((w) => w.baseRefExplicit === undefined || w.diffBase === undefined, {
    message: "baseRefExplicit and diffBase must not both be present -- --from and --base/--head are mutually exclusive",
  })
  .refine((w) => w.baseBranchCommit === undefined || w.diffBase === undefined, {
    message: "baseBranchCommit and diffBase must not both be present -- diffBase/diffHead already capture the exact commits for an explicit review range",
  })
  .refine((w) => w.prReview === undefined || (w.diffBase !== undefined && w.diffHead !== undefined), {
    message: "prReview requires diffBase and diffHead to also be present -- it only applies to an Existing PR review workspace",
  });

export type Workspace = z.infer<typeof WorkspaceSchema>;

/**
 * The workspace that zero-argument commands (`ce resume`, `ce open`,
 * `ce status`, `ce cleanup`) operate on when no `[project/issue]`
 * selector is given -- a convenience default, never an exclusivity
 * lock. Many workspaces can (and normally do) exist on disk
 * simultaneously, each fully isolated and addressable by its own
 * `(project, sanitizedIssue)` pair (see `workspaceFile` below) -- this
 * pointer only ever tracks which *one* is the current default. `ce
 * start` sets it to the workspace it just created; `ce resume
 * <project/issue>` moves it to whichever workspace was just explicitly
 * resumed (since resuming means "work on this now"); `ce cleanup
 * <project/issue>` clears it only if the workspace removed was the one
 * it pointed at. `ce open`/`ce status` never write it, even when given
 * an explicit selector -- looking at or inspecting a workspace is never
 * itself "switching to" it. Nothing about a workspace's own existence,
 * validity, or resumability ever depends on being pointed at by this
 * file; see `listWorkspaces` below for discovering the others.
 */
const ActivePointerSchema = z.object({
  project: z.string().min(1),
  sanitizedIssue: z.string().min(1),
});

export type ActivePointer = z.infer<typeof ActivePointerSchema>;

export async function writeWorkspace(workspace: Workspace): Promise<void> {
  const file = workspaceFile(workspace.project, workspace.sanitizedIssue);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringify(workspace), "utf8");
}

export async function readWorkspace(project: string, sanitizedIssue: string): Promise<Workspace> {
  const file = workspaceFile(project, sanitizedIssue);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new CeError(
      `Workspace file not found at "${file}".`,
      "The workspace may have been removed manually; run `ce cleanup` to clear the active pointer.",
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new CeError(
      `Workspace file at "${file}" is not valid YAML: ${(error as Error).message}`,
    );
  }

  const result = WorkspaceSchema.safeParse(parsed);
  if (!result.success) {
    throw new CeError(
      `Workspace file at "${file}" is invalid: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      "Run `ce cleanup --force` to discard this workspace, then `ce start` again.",
    );
  }
  return result.data;
}

export function workspaceExistsOnDisk(project: string, sanitizedIssue: string): boolean {
  return existsSync(workspacePath(project, sanitizedIssue));
}

/**
 * Lists every workspace that currently exists on disk -- every
 * `workspaces/<project>/<issue>/workspace.yml` found -- regardless of
 * whether it is the current default (see `ActivePointer` above). Purely
 * a filesystem scan: never reads or depends on `state/active.yml`.
 * Sorted for stable, predictable output. Never throws: an unreadable
 * root, project, or issue directory simply contributes no entries,
 * exactly like `listActiveChanges` in core/activeChange.ts.
 */
export async function listWorkspaces(): Promise<ActivePointer[]> {
  const root = workspacesRoot();
  const result: ActivePointer[] = [];

  let projectEntries: Dirent[];
  try {
    projectEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;

    let issueEntries: Dirent[];
    try {
      issueEntries = await readdir(join(root, projectEntry.name), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const issueEntry of issueEntries) {
      if (!issueEntry.isDirectory()) continue;
      if (existsSync(workspaceFile(projectEntry.name, issueEntry.name))) {
        result.push({ project: projectEntry.name, sanitizedIssue: issueEntry.name });
      }
    }
  }

  result.sort(
    (a, b) => a.project.localeCompare(b.project) || a.sanitizedIssue.localeCompare(b.sanitizedIssue),
  );
  return result;
}

/**
 * Ready-to-use recovery text for "no such workspace"/"no default
 * workspace" errors across `ce resume`/`ce open`/`ce status`/`ce
 * cleanup`: either the full `<project>/<issue>` list from
 * `listWorkspaces`, or a suggestion to `ce start` when none exist yet.
 * Centralized so all four commands describe "what else is available"
 * identically, never drifting into four slightly different phrasings.
 */
export async function describeAvailableWorkspaces(): Promise<string> {
  const available = await listWorkspaces();
  if (available.length === 0) {
    return "No workspaces exist yet. Start one with:\n\n  ce start <repo> <issue>";
  }
  return [
    "Available workspaces:",
    ...available.map((w) => `  ${w.project}/${w.sanitizedIssue}`),
  ].join("\n");
}

export async function removeWorkspaceDir(project: string, sanitizedIssue: string): Promise<void> {
  await rm(workspacePath(project, sanitizedIssue), { recursive: true, force: true });
}

export async function writeActivePointer(pointer: ActivePointer): Promise<void> {
  const file = activePointerFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringify(pointer), "utf8");
}

export async function readActivePointer(): Promise<ActivePointer | null> {
  const file = activePointerFile();
  if (!existsSync(file)) return null;

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new CeError(
      `Active workspace pointer at "${file}" is not valid YAML: ${(error as Error).message}`,
      "Run `ce cleanup --force` to reset harness state.",
    );
  }

  const result = ActivePointerSchema.safeParse(parsed);
  if (!result.success) {
    throw new CeError(
      `Active workspace pointer at "${file}" is invalid.`,
      "Run `ce cleanup --force` to reset harness state.",
    );
  }
  return result.data;
}

export async function clearActivePointer(): Promise<void> {
  await rm(activePointerFile(), { force: true });
}

/**
 * Returns the workspace's OpenSpec metadata only if it can be trusted,
 * or `null` otherwise (legacy workspace with no `openSpec` block, or a
 * workspace file whose `openSpec` block does not match what ce-harness
 * would itself have generated for this project/issue/repository).
 *
 * Treats persisted YAML as untrusted input: the persisted `storeId` and
 * `root` are only ever acted on (unregistered, displayed as healthy,
 * etc.) after being cross-checked against values deterministically
 * recomputed from the workspace's other trusted fields. This is what
 * prevents a corrupted or tampered workspace.yml from causing ce to
 * unregister or otherwise act on an unrelated OpenSpec store.
 */
export function resolveTrustedOpenSpec(workspace: Workspace): OpenSpecMetadata | null {
  const persisted = workspace.openSpec;
  if (!persisted) return null;

  if (!isValidStoreId(persisted.storeId)) return null;

  if (persisted.durable) {
    if (persisted.projectId !== undefined) {
      // Current (Project-Identity) scheme: id/root are keyed by project
      // id alone -- see openspecId.ts's generateProjectStoreId /
      // expectedDurableOpenSpecRoot for why that's deliberately never
      // workspace.project or workspace.repositoryPath.
      if (!isValidProjectId(persisted.projectId)) return null;
      const expectedStoreId = generateProjectStoreId(persisted.projectId);
      const expectedRoot = expectedDurableOpenSpecRoot(persisted.projectId);
      if (persisted.storeId !== expectedStoreId) return null;
      if (persisted.root !== expectedRoot) return null;
      return persisted;
    }

    // Legacy (pre-Project-Identity) durable shape: no projectId was
    // ever persisted for this workspace, so recompute and cross-check
    // the old, path-hash-keyed id/root instead. This keeps an
    // already-active legacy durable workspace trusted exactly as before
    // -- it does not silently stop working just because ce-harness was
    // upgraded underneath it. `ce migrate-openspec` is the explicit,
    // opt-in way to move it onto the current scheme.
    const expectedStoreId = generateLegacyProjectStoreId(workspace.project, workspace.repositoryPath);
    const expectedRoot = expectedLegacyDurableOpenSpecRoot(workspace.project, workspace.repositoryPath);
    if (persisted.storeId !== expectedStoreId) return null;
    if (persisted.root !== expectedRoot) return null;
    return persisted;
  }

  const expectedStoreId = generateStoreId(
    workspace.project,
    workspace.sanitizedIssue,
    workspace.repositoryPath,
  );
  const expectedRoot = expectedOpenSpecRoot(workspace.workspacePath);

  if (persisted.storeId !== expectedStoreId) return null;
  if (persisted.root !== expectedRoot) return null;

  return persisted;
}

export type WorkspaceType = "Implementation" | "Existing PR review";

/**
 * Whether this workspace is implementing an OpenSpec change (the default
 * flow) or reviewing an existing, already-given commit range (`ce start
 * --base --head`). Derived entirely from the existing `diffBase`/`diffHead`
 * fields -- the same ones that gate `CE_DIFF_BASE`/`CE_DIFF_HEAD` at
 * launch and the "Review base/head" fields in `ce status` -- so this
 * never introduces a second, separately-maintained source of truth for
 * the same fact.
 */
export function workspaceType(workspace: Workspace): WorkspaceType {
  return workspace.diffBase && workspace.diffHead ? "Existing PR review" : "Implementation";
}

const REVIEW_ISSUE_PATTERN = /^review-pr-(\d+)$/;

/**
 * The deterministic issue name `ce review` gives a PR review workspace
 * for pull request `prNumber` -- centralized here (rather than inlined
 * in `reviewCommand`) so `inferPrNumberFromIssue` below can never drift
 * out of sync with it.
 */
export function reviewIssueName(prNumber: number): string {
  return `review-pr-${prNumber}`;
}

/**
 * Best-effort recovery of a PR number from an issue name matching `ce
 * review`'s own deterministic naming convention above -- the legacy
 * bridge for a workspace created before `PrReviewMetadataSchema`
 * existed, so `ce status`'s stale-PR-review check and `ce review`'s
 * refresh path can still identify *which* pull request an old workspace
 * reviews. This parses ce-harness's own, self-generated identifier, not
 * external command output -- callers that need an authoritative PR
 * number still always prefer `workspace.prReview.number` first, falling
 * back to this only when that structured field is absent. Returns
 * `null` for any issue name that doesn't match exactly (a plain `ce
 * start --base --head` workspace, or one whose issue was renamed) --
 * never guessed or invented.
 */
export function inferPrNumberFromIssue(issue: string): number | null {
  const match = REVIEW_ISSUE_PATTERN.exec(issue);
  return match ? Number(match[1]) : null;
}
