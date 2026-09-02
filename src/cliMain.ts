import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { reviewCommand } from "./commands/review.js";
import { statusCommand } from "./commands/status.js";
import { cleanupCommand } from "./commands/cleanup.js";
import { resumeCommand } from "./commands/resume.js";
import { refreshCommand } from "./commands/refresh.js";
import { openCommand } from "./commands/open.js";
import { migrateOpenSpecCommand } from "./commands/migrateOpenSpec.js";
import { retrieveCommand } from "./commands/retrieve.js";
import { publishCommand } from "./commands/publish.js";
import type { RetrievalSource } from "./core/retrieval.js";
import { formatError } from "./core/errors.js";

/**
 * The actual CLI, loaded only after cli.ts has confirmed the running
 * Node version is supported. Kept in its own module (rather than
 * cli.ts itself) so that nothing here -- including commander and its
 * transitive dependencies -- is ever imported, parsed, or evaluated on
 * an unsupported Node version.
 */
export async function runCli(): Promise<void> {
  const program = new Command();

  program
    .name("ce")
    .description(
      [
        "Personal, local-only developer harness for working on Git repositories.",
        "",
        "Each `ce start` creates an isolated Git worktree plus a workspace directory",
        "under ~/.ce-harness, and provisions a durable OpenSpec store for this",
        "project, keyed by a stable, ce-harness-minted Project Identity rather than",
        "a hash of the repository's current path -- so a rename, a fresh clone, or a",
        "different local path for the same repository all still recognize the same",
        "project. Durable means the store lives outside every workspace/worktree",
        "ce-harness ever deletes: it survives `ce cleanup`, and every later",
        "workspace for the same project reuses the same store (its synced main",
        "specs and archived changes included) instead of starting from empty. Run",
        "`ce status` to see the active OpenSpec change and which of its artifacts",
        "(explore/enrich/proposal/design/tasks/specs/reports) exist, and `ce open",
        "--change` to open them directly -- neither requires knowing this store's",
        "internal path. The target repository and the temporary code worktree are",
        "never modified with OpenSpec files. A workspace created before durable",
        "storage existed keeps its old, workspace-scoped store unless explicitly",
        "moved with `ce migrate-openspec`.",
        "",
        "Prerequisite: the `openspec` executable must be installed and on PATH",
        "(e.g. `npm install -g @fission-ai/openspec`).",
      ].join("\n"),
    )
    .version("1.0.0");

  program
    .command("start")
    .description(
      [
        "Create an isolated Git worktree and workspace for an issue, without",
        "touching the target repository, and provision this project's durable",
        "OpenSpec store for it (registered globally by id, stored outside every",
        "workspace/worktree so it survives `ce cleanup`, and reused unchanged if",
        "an earlier workspace for this project already created it -- never inside",
        "the target repository or worktree). By",
        "default, the worktree starts from the repository's detected base",
        "branch tip (see `detectBaseBranch`; never assumes \"main\"). Pass",
        "--from to instead start this same kind of Implementation workspace",
        "from any other resolvable ref (a local branch, an origin/<branch>",
        "remote-tracking ref, a tag, or a raw commit) -- e.g. a completed",
        "dependency branch that hasn't merged to the default branch yet.",
        "Pass --base and --head together to instead review an exact commit",
        "range (e.g. an existing pull request), which creates an Existing PR",
        "review workspace, not an Implementation one -- --from and --base/--head",
        "are mutually exclusive. Every ref this command accepts must already",
        "exist locally; ce-harness never fetches automatically. Multiple",
        "workspaces can be preserved at once, including more than one for the",
        "same project -- this never requires `ce cleanup` first. The new",
        "workspace becomes the default for `ce resume`/`ce open`/`ce",
        "status`/`ce cleanup` when run with no argument; any previously",
        "default workspace is left completely untouched and stays reachable",
        "with `ce resume <project>/<issue>` (see `ce status`).",
      ].join(" "),
    )
    .argument("<repo>", "path to the target Git repository")
    .argument("<issue>", "issue identifier (e.g. an issue number or short slug)")
    .option("--base <ref>", "exact base ref/commit to review from (requires --head)")
    .option("--head <ref>", "exact head ref/commit to review to (requires --base)")
    .option(
      "--from <ref>",
      "start this Implementation workspace from an explicit ref instead of the detected base " +
        "branch (a local branch, origin/<branch>, a tag, or a commit; mutually exclusive with " +
        "--base/--head)",
    )
    .option(
      "--runner <runner>",
      'coding-agent runner to launch: "claude" or "opencode"',
      "claude",
    )
    .option(
      "--project-id <id>",
      "attach this workspace's durable OpenSpec store to an already-known project id " +
        "(see `ce status`), resolving an ambiguous (CANDIDATE) or conflicting Project Identity " +
        "match instead of refusing; the id must already exist -- this never invents one",
    )
    .option(
      "--new-project",
      "mint a brand-new Project Identity for this repository even if ce-harness recognizes " +
        "(or partially recognizes) it as an existing project; mutually exclusive with --project-id",
    )
    .action(
      async (
        repo: string,
        issue: string,
        options: {
          base?: string;
          head?: string;
          from?: string;
          runner?: string;
          projectId?: string;
          newProject?: boolean;
        },
      ) => {
        await run(() =>
          startCommand({
            repo,
            issue,
            base: options.base,
            head: options.head,
            from: options.from,
            runner: options.runner,
            projectId: options.projectId,
            newProject: options.newProject,
          }),
        );
      },
    );

  program
    .command("review")
    .description(
      [
        "Start an Existing PR review workspace directly from a GitHub PR",
        "number: resolves the PR's exact base/head commits via the `gh`",
        "CLI, fetches only what's needed to make them available locally",
        "(never switching branches, never touching the original repository's",
        "working tree), and reuses the same review-workspace flow `ce start",
        "--base --head` uses. Defaults the issue identifier to",
        "`review-pr-<number>`. Requires the `gh` CLI installed and",
        "authenticated; `ce start` itself remains entirely GitHub-independent.",
      ].join(" "),
    )
    .argument("<repo>", "path to the target Git repository")
    .argument("<pr-number>", "GitHub pull request number")
    .option(
      "--runner <runner>",
      'coding-agent runner to launch: "claude" or "opencode"',
      "claude",
    )
    .action(async (repo: string, prNumber: string, options: { runner?: string }) => {
      await run(() => reviewCommand({ repo, prNumber, runner: options.runner }));
    });

  program
    .command("resume")
    .description(
      "Re-enter a workspace by relaunching the same runner (opencode or claude) `ce start` " +
        "used, with the same environment -- creates nothing, registers nothing, and never " +
        "modifies workspace.yml. With no argument, re-enters the current default workspace; " +
        "with [workspace] (as <project>/<issue>, e.g. market-audit-tool/130 -- see `ce " +
        "status`), re-enters that one instead and makes it the new default, since resuming " +
        "means \"work on this now\". Many workspaces can be preserved at once; this never " +
        "deletes or otherwise touches any of the others. Use this instead of reconstructing " +
        "the launch command by hand after the runner exits.",
    )
    .argument("[workspace]", "target a specific workspace as <project>/<issue> instead of the current default")
    .action(async (workspace: string | undefined) => {
      await run(() => resumeCommand({ workspace }));
    });

  program
    .command("refresh")
    .description(
      "Refresh the active workspace's harness-managed runner configuration " +
        "(e.g. Claude Code's .claude/commands/*.md) against the harness's current " +
        "template library -- the supported way to bring an already-existing " +
        "workspace's generated files up to date, without deleting or recreating " +
        "the workspace, worktree, or branch. A file whose on-disk content cannot " +
        "be proven to still be ce-harness's own (e.g. hand-edited) is always left " +
        "untouched. Idempotent -- safe to run any number of times.",
    )
    .action(async () => {
      await run(() => refreshCommand());
    });

  program
    .command("open")
    .description(
      "Open a workspace's worktree directly in an editor (VS Code today) -- no need to " +
        "remember or copy the path `ce start`/`ce status` printed. With no argument, opens " +
        "the current default workspace; with [workspace] (as <project>/<issue> -- see `ce " +
        "status`), opens that one instead, without changing which workspace is the default " +
        "-- purely a read, like `ce status`. With --change, opens the resolved workspace's " +
        "active OpenSpec change's artifacts (explore.md, enrich.md, proposal.md, design.md, " +
        "tasks.md, specs/, reports/ -- whichever exist) instead of the worktree, without " +
        "needing to know the durable store's internal path. Creates nothing, registers " +
        "nothing, and never modifies workspace.yml or which workspace is the default.",
    )
    .argument("[workspace]", "target a specific workspace as <project>/<issue> instead of the current default")
    .option(
      "--change [name]",
      "open the OpenSpec change's artifacts instead of the worktree -- the sole active " +
        "change if no name is given (see `ce status`), or a specific one by name when " +
        "more than one is active",
    )
    .action(async (workspace: string | undefined, options: { change?: string | true }) => {
      await run(() => openCommand({ workspace, change: options.change }));
    });

  program
    .command("migrate-openspec")
    .description(
      [
        "Explicitly, safely move the active workspace's OpenSpec store onto the",
        "current, durable, Project-Identity-keyed store (see `ce start`'s",
        "description) so it survives `ce cleanup` and is recognized again across",
        "future clones/renames of this repository. Covers both a legacy,",
        "per-workspace store and a durable store still on the older,",
        "path-hash-keyed shape. Never runs automatically -- an existing workspace",
        "never changes storage behavior just because the CLI was upgraded. The old",
        "store's files are never deleted; remove them yourself once you've",
        "confirmed the migrated data looks correct. Refuses (rather than",
        "overwriting or merging) if the durable destination already has",
        "conflicting content, or if Project Identity resolution is ambiguous (see",
        "--project-id/--new-project). Idempotent: a workspace already on the",
        "current scheme is reported as a no-op.",
      ].join(" "),
    )
    .option(
      "--project-id <id>",
      "attach to an already-known project id instead of letting ce-harness detect or mint one " +
        "automatically; the id must already exist -- this never invents one",
    )
    .option(
      "--new-project",
      "mint a brand-new Project Identity even if ce-harness recognizes (or partially recognizes) " +
        "this repository as an existing project; mutually exclusive with --project-id",
    )
    .action(async (options: { projectId?: string; newProject?: boolean }) => {
      await run(() =>
        migrateOpenSpecCommand({ projectId: options.projectId, newProject: options.newProject }),
      );
    });

  program
    .command("status")
    .description(
      "Show details about a ce-harness workspace, including the OpenSpec store id, root " +
        "path, health, and the active OpenSpec change's artifacts (explore/enrich/proposal/" +
        "design/tasks/specs/reports -- see `ce open --change` to open them). With no " +
        "argument, shows the current default workspace, plus an \"Other workspaces\" list " +
        "of every other one preserved on disk; with [workspace] (as <project>/<issue>), " +
        "shows that one instead, without changing the default (read-only).",
    )
    .argument("[workspace]", "target a specific workspace as <project>/<issue> instead of the current default")
    .action(async (workspace: string | undefined) => {
      await run(() => statusCommand({ workspace }));
    });

  program
    .command("publish")
    .description(
      [
        "Ship a completed, archived workspace as a normal GitHub pull request --",
        "the deterministic half of `/publish` (see templates/commands/publish.md",
        "for the agent-driven half: reading the archived change's artifacts and",
        "verification evidence to write the PR title/body, and getting explicit",
        "confirmation before any remote mutation). With no --confirm (the",
        "default): read-only plus one `git fetch` of the base branch -- reports",
        "a full JSON plan (repository, base, branch, included commits/files,",
        "update status) and, if the remote base advanced, safely merges it into",
        "the workspace's own branch when that's a clean merge (never on",
        "conflict). Performs no push and creates no PR. With --confirm: commits",
        "any still-uncommitted changes, pushes the branch under a plain,",
        "repository-appropriate name (never `ce-harness/*`), and creates the PR",
        "-- never merges it, never enables auto-merge. Requires the `gh` CLI",
        "installed, authenticated, and a GitHub origin remote.",
      ].join(" "),
    )
    .argument("[workspace]", "target a specific workspace as <project>/<issue> instead of the current default")
    .option("--change <name>", "attribute this publish to a specific OpenSpec change instead of auto-resolving the workspace's most recently archived one")
    .option("--confirm", "perform the remote mutation: commit if needed, push, and create the PR", false)
    .option("--title <text>", "PR title (required with --confirm)")
    .option("--body-file <path>", "path to a file containing the PR body (required with --confirm)")
    .option("--expected-head <sha>", "the workspace branch's commit the plan was generated against (required with --confirm)")
    .option(
      "--expected-fingerprint <hash>",
      "the plan's expectedFingerprint (HEAD plus every uncommitted change) -- required with --confirm; " +
        "--expected-head alone cannot detect a file added or changed without the branch's commit moving",
    )
    .action(
      async (
        workspace: string | undefined,
        options: {
          change?: string;
          confirm: boolean;
          title?: string;
          bodyFile?: string;
          expectedHead?: string;
          expectedFingerprint?: string;
        },
      ) => {
        await run(() =>
          publishCommand({
            workspace,
            change: options.change,
            confirm: options.confirm,
            title: options.title,
            bodyFile: options.bodyFile,
            expectedHead: options.expectedHead,
            expectedFingerprint: options.expectedFingerprint,
          }),
        );
      },
    );

  program
    .command("retrieve")
    .description(
      [
        "Search the active workspace's durable OpenSpec store and repository Git",
        "history for prior project knowledge relevant to a task, via the Retrieval",
        "Contract (core/retrieval.ts) -- deterministic, read-only, and scoped",
        "strictly to this project. Prints a small ranked JSON list of candidates",
        "(never full artifact bodies) to stdout, for a workflow stage such as",
        "`/enrich` to parse. An empty result, or no durable store yet, is reported",
        "as a normal (non-error) outcome.",
      ].join(" "),
    )
    .option("--task <text>", "free-text description of the current task/issue")
    .option("--keywords <list>", "comma-separated keywords/identifiers already known to be relevant")
    .option("--paths <list>", "comma-separated relevant file/directory paths, if known")
    .option("--domain <name>", "OpenSpec domain/capability name, if known")
    .option("--limit <n>", "maximum candidates to return (default 15)")
    .option(
      "--sources <list>",
      'comma-separated sources to search: "specs", "archivedChanges", "gitHistory" (default: all three)',
    )
    .action(
      async (options: {
        task?: string;
        keywords?: string;
        paths?: string;
        domain?: string;
        limit?: string;
        sources?: string;
      }) => {
        const splitList = (value?: string) =>
          value
            ? value
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
            : undefined;

        await run(() =>
          retrieveCommand({
            task: options.task,
            keywords: splitList(options.keywords),
            paths: splitList(options.paths),
            domain: options.domain,
            limit: options.limit !== undefined ? Number(options.limit) : undefined,
            sources: splitList(options.sources) as RetrievalSource[] | undefined,
          }),
        );
      },
    );

  program
    .command("cleanup")
    .description(
      "Remove a workspace's worktree, branch, and workspace directory. With no argument, " +
        "removes the current default workspace; with [workspace] (as <project>/<issue> -- " +
        "see `ce status`), removes that one instead -- the default pointer is only ever " +
        "updated if the workspace removed was the one it pointed at, so cleaning up a " +
        "non-default workspace never disturbs the default. If the workspace's OpenSpec " +
        "store is a legacy, workspace-scoped one, this unregisters it first (never deletes " +
        "its files directly -- removing the workspace directory does that) and it is lost, " +
        "exactly like before. This project's durable OpenSpec store (the default since `ce " +
        "migrate-openspec` was introduced) is left registered and untouched: it lives " +
        "outside the workspace directory entirely, so cleanup cannot reach it.",
    )
    .argument("[workspace]", "target a specific workspace as <project>/<issue> instead of the current default")
    .option(
      "--force",
      "discard tracked or untracked changes in the worktree, and proceed with " +
        "filesystem cleanup even if unregistering the OpenSpec store failed",
      false,
    )
    .action(async (workspace: string | undefined, options: { force: boolean }) => {
      await run(() => cleanupCommand({ force: options.force, workspace }));
    });

  async function run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.error(formatError(error));
      process.exitCode = 1;
    }
  }

  await program.parseAsync(process.argv);
}
