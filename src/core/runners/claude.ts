import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { execa } from "execa";
import { addLocalExcludePattern } from "../git.js";
import {
  copyTemplatesSkippingCollisions,
  existsAsNonDirectory,
  refreshTemplateFiles,
  sha256File,
} from "../templates.js";
import type { Workspace } from "../workspace.js";
import type {
  RefreshConfigResult,
  RunnerLaunchResult,
  RunnerSpec,
  RunnerWorkspacePaths,
} from "./types.js";

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
 * refuse to touch a pre-existing destination path (whether tracked,
 * untracked, or gitignored -- the check is a plain filesystem existence
 * check, not a Git-tracking query, so it holds regardless of how the
 * path got there) rather than overwriting, merging into, or otherwise
 * taking ownership of it.
 *
 * `writeConfig` makes that check per individual command file and per
 * skill directory, not once against the whole `.claude/` directory: a
 * repository that already tracks its own, unrelated `.claude/skills/`
 * entry still gets every ce-harness command and every other skill
 * installed alongside it, with only the colliding entry left alone (and
 * a warning naming it). `writeCodeGraphConfig`'s `.mcp.json` has no
 * such internal structure, so it stays a single all-or-nothing file.
 * Each returns exactly which worktree-relative paths it actually wrote
 * (never more, never fewer), which `ce start` persists on the workspace
 * so `managedWorktreeRelativePaths` can tell `ce cleanup`/`ce status`
 * exactly which worktree-local paths are harness-owned and disposable --
 * never more than that, and never by guessing.
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

/** Strips a command template's `.md` extension to get its slash-command name. */
function commandNameFrom(templateFileName: string): string {
  return templateFileName.endsWith(".md") ? templateFileName.slice(0, -3) : templateFileName;
}

/** Warns that one specific command or skill was left alone because the repository already owns that path. */
function warnAboutCollision(category: "commands" | "skills", entryName: string): void {
  const claudeRelativePath = join(".claude", category, entryName);
  const whatItWouldHaveBeen =
    category === "commands" ? `the "/${commandNameFrom(entryName)}" command` : `the "${entryName}" skill`;
  console.error(
    `Warning: "${claudeRelativePath}" already exists in this worktree (tracked by the repository, ` +
      "or otherwise already present) -- ce-harness will not overwrite, merge into, or take " +
      `ownership of it, so ${whatItWouldHaveBeen} will not be available to Claude Code in this ` +
      "workspace. Remove or rename that path yourself and re-run `ce start` if you want ce-harness " +
      "to provision it.",
  );
}

/**
 * Warns that an entire category (or `.claude` itself) is blocked because
 * something other than a directory already sits at that exact path --
 * distinct from `warnAboutCollision`, which is about one specific,
 * already-named command or skill. Nothing under `claudeRelativePath`
 * could even be attempted, so nothing under it is named individually.
 */
function warnBlockedByNonDirectory(claudeRelativePath: string): void {
  console.error(
    `Warning: "${claudeRelativePath}" already exists in this worktree as a file, not a directory ` +
      "(tracked by the repository, or otherwise already present) -- ce-harness cannot install " +
      "anything under it. Commands and/or skills that would live there will not be available to " +
      "Claude Code in this workspace. Remove or rename that path yourself and re-run `ce start` if " +
      "you want ce-harness to provision it.",
  );
}

/**
 * Materializes `<worktree>/.claude/{commands,skills}` from the harness's
 * canonical template library -- the exact same source templates
 * OpenCode's config is built from (see runners/opencode.ts), so the
 * workflow itself is never duplicated or forked per runner.
 *
 * Collision-safe per individual command file and per skill directory
 * (see `copyTemplatesSkippingCollisions`): a path the repository already
 * owns at that exact location is left completely untouched, with a
 * warning naming it, while every other template is still installed.
 * Returns the `.claude`-relative paths (e.g.
 * `"commands/adversarial-review.md"`, `"skills/openspec-sync-specs"`)
 * actually written, each added individually to the local exclude file --
 * never a single blanket `/.claude` pattern, which would also hide any
 * unrelated, non-harness-owned content the repository keeps alongside
 * them (tracked or not).
 *
 * The same collision-safety extends to `.claude`, `.claude/commands`,
 * and `.claude/skills` themselves existing as a plain file rather than a
 * directory: each is checked with `existsAsNonDirectory` before any
 * `mkdir` is attempted, so that case degrades to a warning (naming
 * whichever of the three is blocked) instead of an unhandled `EEXIST`/
 * `ENOTDIR` crashing `ce start`. `.claude` being blocked skips both
 * commands and skills at once, since neither can be placed under it
 * either; `.claude/commands` or `.claude/skills` alone being blocked
 * only costs that one category.
 */
async function writeConfig(paths: RunnerWorkspacePaths): Promise<string[]> {
  const configDir = claudeConfigDir(paths.worktreePath);

  if (existsAsNonDirectory(configDir)) {
    warnBlockedByNonDirectory(".claude");
    return [];
  }

  await mkdir(configDir, { recursive: true });

  const written: string[] = [];

  const commands = await copyTemplatesSkippingCollisions("commands", join(configDir, "commands"));
  if (commands.blockedByNonDirectory) {
    warnBlockedByNonDirectory(join(".claude", "commands"));
  } else {
    for (const name of commands.written) written.push(join("commands", name));
    for (const name of commands.skipped) warnAboutCollision("commands", name);
  }

  const skills = await copyTemplatesSkippingCollisions("skills", join(configDir, "skills"));
  if (skills.blockedByNonDirectory) {
    warnBlockedByNonDirectory(join(".claude", "skills"));
  } else {
    for (const name of skills.written) written.push(join("skills", name));
    for (const name of skills.skipped) warnAboutCollision("skills", name);
  }

  for (const relativePath of written) {
    await addLocalExcludePattern(paths.worktreePath, `/${join(".claude", relativePath)}`);
  }

  return written;
}

/** `.claude`-relative prefix every command entry's path in `commandsManaged` carries. */
const COMMANDS_PREFIX = `commands${sep}`;

/**
 * Refreshes `<worktree>/.claude/commands/` against the harness's current
 * template library -- see `RunnerSpec.refreshConfig`. Scoped to commands
 * only for now: skills use the same underlying `refreshTemplateFiles`
 * primitive but are a whole directory per entry, and directory-content
 * hashing is a deliberate non-goal of this pass (nothing in `skills/`
 * changes as a result of a refresh).
 *
 * Bootstraps hash history for a workspace that has never been refreshed
 * before (every workspace `commandsManaged` already lists as harness-
 * owned, but with no recorded hash yet -- true for every workspace
 * created before this feature existed): the current on-disk content of
 * each such path is trusted once, as the baseline, since `commandsManaged`
 * is itself already ce-harness's own record that it wrote that exact
 * path. From the very next refresh onward that path is fully
 * hash-verified like every other entry. A path never recorded in
 * `commandsManaged` at all -- including every entry when the legacy
 * all-or-nothing `commandsManaged: true` boolean is all a workspace has,
 * since there are no individual paths to trust-bootstrap from in that
 * shape -- is never bootstrapped, and so is always left alone until a
 * proper per-path hash exists.
 */
async function refreshConfig(
  paths: RunnerWorkspacePaths,
  workspace: Workspace,
): Promise<RefreshConfigResult> {
  const commandsDir = join(claudeConfigDir(paths.worktreePath), "commands");
  const artifacts = workspace.runnerWorktreeArtifacts;
  const recordedHashes = artifacts?.commandsManagedHashes ?? {};
  const managedPaths = Array.isArray(artifacts?.commandsManaged) ? artifacts.commandsManaged : [];

  const knownHashes: Record<string, string> = {};
  for (const [relativePath, hash] of Object.entries(recordedHashes)) {
    if (relativePath.startsWith(COMMANDS_PREFIX)) {
      knownHashes[relativePath.slice(COMMANDS_PREFIX.length)] = hash;
    }
  }
  for (const relativePath of managedPaths) {
    if (!relativePath.startsWith(COMMANDS_PREFIX)) continue;
    const entryName = relativePath.slice(COMMANDS_PREFIX.length);
    if (entryName in knownHashes) continue; // already has a real recorded hash -- no bootstrap needed
    const onDiskPath = join(commandsDir, entryName);
    if (existsSync(onDiskPath)) {
      knownHashes[entryName] = await sha256File(onDiskPath); // trust current content, once
    }
  }

  const copyResult = await refreshTemplateFiles("commands", commandsDir, knownHashes);

  const newManagedSet = new Set(managedPaths);
  const newHashes: Record<string, string> = { ...recordedHashes };
  for (const entryName of [...copyResult.updated, ...copyResult.unchanged]) {
    const relativePath = join("commands", entryName);
    newManagedSet.add(relativePath);
    newHashes[relativePath] = copyResult.hashes[entryName]!;
  }

  return {
    result: {
      updated: copyResult.updated.map((name) => join("commands", name)),
      unchanged: copyResult.unchanged.map((name) => join("commands", name)),
      skipped: copyResult.skipped.map((name) => join("commands", name)),
    },
    commandsManaged: [...newManagedSet],
    commandsManagedHashes: newHashes,
  };
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
 * `ce cleanup`/`ce status` (see core/worktreeArtifacts.ts) treat each
 * harness-written command file, skill directory, or `.mcp.json` as a
 * harmless, disposable artifact -- exactly like CodeGraph's index --
 * without ever extending that same treatment to a same-named sibling
 * path the repository itself owns.
 *
 * `commandsManaged` is normally the array `writeConfig` now returns:
 * each entry is a path relative to `.claude/` (e.g.
 * `"commands/adversarial-review.md"`, `"skills/openspec-sync-specs"`),
 * reported here as `.claude/<entry>`. A plain `boolean` is also accepted
 * -- a workspace.yml persisted before per-item tracking existed, where
 * `true` meant the whole `.claude/` directory was harness-written.
 */
function managedWorktreeRelativePaths(workspace: Workspace): string[] {
  const artifacts = workspace.runnerWorktreeArtifacts;
  if (!artifacts) return [];

  const paths: string[] = [];
  const commandsManaged = artifacts.commandsManaged;
  if (typeof commandsManaged === "boolean") {
    if (commandsManaged) paths.push(".claude");
  } else {
    for (const relativePath of commandsManaged) {
      paths.push(join(".claude", relativePath));
    }
  }
  if (artifacts.mcpManaged) paths.push(".mcp.json");
  return paths;
}

export const CLAUDE_RUNNER: RunnerSpec = {
  id: "claude",
  label: "Claude Code",
  binary: claudeBinary,
  writeConfig,
  refreshConfig,
  writeCodeGraphConfig,
  buildEnv,
  managedWorktreeRelativePaths,
  launch,
  formatLaunchCommand,
};
