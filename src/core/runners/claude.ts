import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { addLocalExcludePattern } from "../git.js";
import { copyTemplates } from "../templates.js";
import type { Workspace } from "../workspace.js";
import type { RunnerLaunchResult, RunnerSpec, RunnerWorkspacePaths } from "./types.js";

/**
 * Claude Code as a `RunnerSpec`, using the installed `claude` CLI
 * interactively (the user's own authenticated CLI session / Claude Team
 * seat) -- never the Anthropic API, and no API key is ever read.
 *
 * Unlike OpenCode, Claude Code has no environment-variable override for
 * where it looks for project-scoped commands/skills/MCP config: `.claude/`
 * and `.mcp.json` are discovered only relative to the process's current
 * working directory. Since `ce-harness` never writes into the target
 * repository, and this runner is launched with `cwd` set to the isolated,
 * ce-harness-owned worktree (never the user's persistent checkout), that
 * worktree is the only place this configuration can be materialized.
 * This mirrors the precedent already set by CodeGraph's own `.codegraph`
 * index (see core/codeGraph.ts): worktree-local, added to Git's local
 * (never committed) exclude file, and removed entirely when the worktree
 * itself is removed by `ce cleanup`.
 *
 * Because this places generated files inside the worktree -- unlike
 * OpenCode's config, which lives entirely outside it, under the
 * workspace directory -- both `writeConfig` and `writeCodeGraphConfig`
 * refuse to touch a pre-existing `.claude/` or `.mcp.json` (whether
 * tracked, untracked, or gitignored -- the check is a plain filesystem
 * existence check, not a Git-tracking query, so it holds regardless of
 * how the path got there) rather than overwriting, merging into, or
 * otherwise taking ownership of it. Each returns whether it actually
 * wrote (vs. safely skipped), which `ce start` persists on the
 * workspace so `managedWorktreeRelativePaths` can tell `ce cleanup`/
 * `ce status` exactly which worktree-local paths are harness-owned and
 * disposable -- never more than that, and never by guessing.
 */

/** Resolves the Claude Code executable to invoke. Overridable for tests. */
export function claudeBinary(): string {
  return process.env.CE_CLAUDE_BIN && process.env.CE_CLAUDE_BIN.length > 0
    ? process.env.CE_CLAUDE_BIN
    : "claude";
}

function claudeConfigDir(worktreePath: string): string {
  return join(worktreePath, ".claude");
}

function mcpConfigPath(worktreePath: string): string {
  return join(worktreePath, ".mcp.json");
}

async function launch(options: { cwd: string; env: Record<string, string> }): Promise<RunnerLaunchResult> {
  const result = await execa(claudeBinary(), [], {
    cwd: options.cwd,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
    reject: false,
  });

  if (typeof result.exitCode !== "number") {
    return {
      launched: false,
      message: result.shortMessage ?? result.message ?? "Claude Code could not be launched.",
    };
  }

  return { launched: true, exitCode: result.exitCode };
}

function formatLaunchCommand(cwd: string, env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `cd ${shellQuote(cwd)} && ${assignments} ${claudeBinary()}`;
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Materializes `<worktree>/.claude/{commands,skills}` from the harness's
 * canonical template library -- the exact same source templates
 * OpenCode's config is built from (see runners/opencode.ts), so the
 * workflow itself is never duplicated or forked per runner. Skipped
 * entirely (with a console warning) if the repository already tracks
 * its own `.claude/` directory in this worktree, so a repository that
 * happens to have its own Claude Code configuration is never clobbered.
 */
async function writeConfig(paths: RunnerWorkspacePaths): Promise<boolean> {
  const configDir = claudeConfigDir(paths.worktreePath);
  if (existsSync(configDir)) {
    console.error(
      `Warning: "${configDir}" already exists -- ce-harness did not create it (tracked by the ` +
        "repository, or otherwise already present) and will not overwrite, merge into, or take " +
        "ownership of it. The /explore, /propose, /apply, /verify, /adversarial-review, /archive, " +
        "and /workspace commands (and the openspec-sync-specs skill) will not be available to " +
        "Claude Code in this workspace. Remove or rename that directory yourself and re-run " +
        "`ce start` if you want ce-harness to provision it.",
    );
    return false;
  }

  await mkdir(configDir, { recursive: true });
  await copyTemplates("commands", join(configDir, "commands"));
  await copyTemplates("skills", join(configDir, "skills"));
  await addLocalExcludePattern(paths.worktreePath, "/.claude");
  return true;
}

/**
 * Writes `<worktree>/.mcp.json`, Claude Code's project-scoped MCP config
 * file, registering CodeGraph's MCP server. Skipped entirely (with a
 * console warning) if the repository already tracks its own `.mcp.json`
 * in this worktree.
 */
async function writeCodeGraphConfig(
  paths: RunnerWorkspacePaths,
  codeGraphBinary: string,
): Promise<boolean> {
  const configPath = mcpConfigPath(paths.worktreePath);
  if (existsSync(configPath)) {
    console.error(
      `Warning: "${configPath}" already exists -- ce-harness did not create it (tracked by the ` +
        "repository, or otherwise already present) and will not overwrite, merge into, or take " +
        "ownership of it. CodeGraph's MCP server will not be registered for Claude Code in this " +
        "workspace. Remove or rename that file yourself and re-run `ce start` if you want " +
        "ce-harness to provision it.",
    );
    return false;
  }

  const config = {
    mcpServers: {
      codegraph: {
        command: codeGraphBinary,
        args: ["serve", "--mcp", "--path", paths.worktreePath],
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await addLocalExcludePattern(paths.worktreePath, "/.mcp.json");
  return true;
}

/**
 * No runner-specific environment variables: `.claude/` and `.mcp.json`
 * are discovered by Claude Code purely from the launch `cwd`, which is
 * already the worktree they were written into.
 */
function buildEnv(_workspace: Workspace): Record<string, string> {
  return {};
}

/**
 * The worktree-relative paths this runner actually wrote and owns for
 * `workspace` -- read only from `workspace.runnerWorktreeArtifacts`
 * (never re-derived from `existsSync`, and never assumed), so a path
 * `writeConfig`/`writeCodeGraphConfig` safely skipped (pre-existing,
 * not harness-owned) is correctly excluded here too. This is what lets
 * `ce cleanup`/`ce status` (see core/worktreeArtifacts.ts) treat a
 * harness-written `.claude/`/`.mcp.json` as a harmless, disposable
 * artifact -- exactly like CodeGraph's index -- without ever extending
 * that same treatment to a same-named path the repository itself owns.
 */
function managedWorktreeRelativePaths(workspace: Workspace): string[] {
  const artifacts = workspace.runnerWorktreeArtifacts;
  if (!artifacts) return [];

  const paths: string[] = [];
  if (artifacts.commandsManaged) paths.push(".claude");
  if (artifacts.mcpManaged) paths.push(".mcp.json");
  return paths;
}

export const CLAUDE_RUNNER: RunnerSpec = {
  id: "claude",
  label: "Claude Code",
  binary: claudeBinary,
  writeConfig,
  writeCodeGraphConfig,
  buildEnv,
  managedWorktreeRelativePaths,
  launch,
  formatLaunchCommand,
};
