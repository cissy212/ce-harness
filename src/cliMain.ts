import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { cleanupCommand } from "./commands/cleanup.js";
import { resumeCommand } from "./commands/resume.js";
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
        "under ~/.ce-harness, and provisions an external OpenSpec store at",
        "<workspace>/openspec, registered globally with OpenSpec by a deterministic",
        '"ce-<project>-<issue>-<hash>" id. The target repository and the temporary',
        "code worktree are never modified with OpenSpec files: the store always",
        "lives outside of them, under the harness workspace directory.",
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
        "touching the target repository, and provision an external OpenSpec",
        "store for it (registered globally by id, stored under the workspace",
        "directory, never inside the target repository or worktree). By",
        "default, the worktree starts from the local main/master tip. Pass",
        "--base and --head together to instead review an exact commit range",
        "(e.g. an existing pull request) -- both refs must already exist",
        "locally; ce-harness never fetches automatically.",
      ].join(" "),
    )
    .argument("<repo>", "path to the target Git repository")
    .argument("<issue>", "issue identifier (e.g. an issue number or short slug)")
    .option("--base <ref>", "exact base ref/commit to review from (requires --head)")
    .option("--head <ref>", "exact head ref/commit to review to (requires --base)")
    .action(async (repo: string, issue: string, options: { base?: string; head?: string }) => {
      await run(() => startCommand({ repo, issue, base: options.base, head: options.head }));
    });

  program
    .command("resume")
    .description(
      "Re-enter the active workspace by relaunching OpenCode with the same environment " +
        "`ce start` used -- creates nothing, registers nothing, and never modifies " +
        "workspace.yml. Use this instead of reconstructing the launch command by hand " +
        "after OpenCode exits.",
    )
    .action(async () => {
      await run(() => resumeCommand());
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
        "Unregisters the workspace's OpenSpec store first (never deletes its files " +
        "directly; ce-harness always removes the workspace directory itself).",
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
