import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { reviewCommand } from "./commands/review.js";
import { statusCommand } from "./commands/status.js";
import { cleanupCommand } from "./commands/cleanup.js";
import { resumeCommand } from "./commands/resume.js";
import { refreshCommand } from "./commands/refresh.js";
import { openCommand } from "./commands/open.js";
import { migrateOpenSpecCommand } from "./commands/migrateOpenSpec.js";
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
        "under ~/.ce-harness, and provisions a durable, project-scoped OpenSpec store",
        "at ~/.ce-harness/openspec/<project>/<repo-hash>, registered globally with",
        'OpenSpec by a deterministic "ce-<project>-<hash>" id. Durable means the store',
        "lives outside every workspace/worktree ce-harness ever deletes: it survives",
        "`ce cleanup`, and every later workspace for the same project reuses the same",
        "store (its synced main specs and archived changes included) instead of",
        "starting from empty. The target repository and the temporary code worktree",
        "are never modified with OpenSpec files. A workspace created before durable",
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
        "exist locally; ce-harness never fetches automatically.",
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
      'coding-agent runner to launch: "opencode" (default) or "claude"',
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
      'coding-agent runner to launch: "opencode" (default) or "claude"',
    )
    .action(async (repo: string, prNumber: string, options: { runner?: string }) => {
      await run(() => reviewCommand({ repo, prNumber, runner: options.runner }));
    });

  program
    .command("resume")
    .description(
      "Re-enter the active workspace by relaunching the same runner (opencode or claude) " +
        "`ce start` used, with the same environment -- creates nothing, registers nothing, " +
        "and never modifies workspace.yml. Use this instead of reconstructing the launch " +
        "command by hand after the runner exits.",
    )
    .action(async () => {
      await run(() => resumeCommand());
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
      "Open the active workspace's worktree directly in an editor (VS Code today) -- " +
        "no need to remember or copy the path `ce start`/`ce status` printed. Creates " +
        "nothing, registers nothing, and never modifies workspace.yml.",
    )
    .action(async () => {
      await run(() => openCommand());
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
      "Show details about the currently active ce-harness workspace, if any, " +
        "including the OpenSpec store id, root path, and health (read-only).",
    )
    .action(async () => {
      await run(() => statusCommand());
    });

  program
    .command("cleanup")
    .description(
      "Remove the active workspace's worktree, branch, and workspace directory. " +
        "If the workspace's OpenSpec store is a legacy, workspace-scoped one, this " +
        "unregisters it first (never deletes its files directly -- removing the " +
        "workspace directory does that) and it is lost, exactly like before. This " +
        "project's durable OpenSpec store (the default since `ce migrate-openspec` " +
        "was introduced) is left registered and untouched: it lives outside the " +
        "workspace directory entirely, so cleanup cannot reach it.",
    )
    .option(
      "--force",
      "discard tracked or untracked changes in the worktree, and proceed with " +
        "filesystem cleanup even if unregistering the OpenSpec store failed",
      false,
    )
    .action(async (options: { force: boolean }) => {
      await run(() => cleanupCommand({ force: options.force }));
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
