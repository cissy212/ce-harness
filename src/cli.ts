#!/usr/bin/env node
import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { cleanupCommand } from "./commands/cleanup.js";
import { formatError } from "./core/errors.js";

const program = new Command();

program
  .name("ce")
  .description("Personal, local-only developer harness for working on Git repositories.")
  .version("1.0.0");

program
  .command("start")
  .description(
    "Create an isolated Git worktree and workspace for an issue, without touching the target repository.",
  )
  .argument("<repo>", "path to the target Git repository")
  .argument("<issue>", "issue identifier (e.g. an issue number or short slug)")
  .action(async (repo: string, issue: string) => {
    await run(() => startCommand({ repo, issue }));
  });

program
  .command("status")
  .description("Show details about the currently active ce-harness workspace, if any.")
  .action(async () => {
    await run(() => statusCommand());
  });

program
  .command("cleanup")
  .description("Remove the active workspace's worktree, branch, and workspace directory.")
  .option("--force", "discard tracked or untracked changes in the worktree", false)
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

program.parseAsync(process.argv);
