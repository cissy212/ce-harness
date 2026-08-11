import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { addLocalExcludePattern } from "./git.js";
import { expectedOpenCodeConfigDir } from "./opencodeConfig.js";
import type { Workspace } from "./workspace.js";

/**
 * Optional CodeGraph (semantic code navigation) integration: ce-harness
 * never installs CodeGraph, and only ever provisions an index scoped to
 * the isolated `$CE_WORKTREE` -- never the target repository, never the
 * user's persistent checkout. See docs/design notes for the full
 * rationale; the short version:
 *
 * - An explicit --base/--head review worktree can sit at a different
 *   commit than the user's own checkout, so reusing an index from their
 *   persistent clone could describe the wrong code entirely.
 * - `codegraph init` has no supported way to place its index outside the
 *   directory it indexes, so the index necessarily lands inside
 *   `$CE_WORKTREE` (`$CE_WORKTREE/.codegraph/`) -- never inside the
 *   original repository.
 * - ce-harness only ever claims ownership of that directory when it
 *   verifiably created it itself in this exact session. If a
 *   `.codegraph/` directory already exists in the freshly created
 *   worktree (almost certainly because the repository itself tracks
 *   one), ce-harness never touches, claims, or deletes it -- CodeGraph
 *   is simply reported as unavailable for this workspace.
 * - Whenever ce-harness does create and own that index, it also adds it
 *   to the repository's local, never-committed exclude file (see
 *   `ignoreCodeGraphIndex`) so `.codegraph/` never shows up as an
 *   untracked directory in `git status` -- no manual `.gitignore` entry
 *   ever required.
 *
 * This module is the only place CodeGraph-specific knowledge lives.
 * Everything exposed to workflow templates is generic ("semantic code
 * navigation", `CE_CODE_NAV_AVAILABLE`/`CE_CODE_NAV_PROVIDER`) so a
 * future adapter for a different provider could be substituted without
 * changing any template.
 */

/** Resolves the CodeGraph executable to invoke. Overridable for tests. */
export function codeGraphBinary(): string {
  return process.env.CE_CODEGRAPH_BIN && process.env.CE_CODEGRAPH_BIN.length > 0
    ? process.env.CE_CODEGRAPH_BIN
    : "codegraph";
}

/** The only path a workspace's CodeGraph index may live at: inside the isolated worktree. */
export function expectedCodeGraphIndexPath(worktreePath: string): string {
  return join(worktreePath, ".codegraph");
}

/** The only path the workspace-owned OpenCode MCP config for CodeGraph may live at. */
export function expectedCodeGraphOpenCodeConfigPath(workspacePath: string): string {
  return join(expectedOpenCodeConfigDir(workspacePath), "opencode.json");
}

export interface CodeGraphResult {
  available: boolean;
  /**
   * True only when ce-harness itself created this exact index in this
   * exact session. A pre-existing `.codegraph/` directory is never
   * claimed, so it is always reported with `managedByHarness: false`
   * (and, in this implementation, `available: false` alongside it --
   * ce-harness never wires up MCP for an index it did not create and
   * cannot vouch for).
   */
  managedByHarness: boolean;
  indexPath?: string;
  initializedAt?: string;
  reason?: string;
}

async function runCodeGraph(args: string[], cwd?: string) {
  return execa(codeGraphBinary(), args, { cwd, reject: false });
}

/** True if the `codegraph` executable is present and runnable. Never throws. */
export async function isCodeGraphBinaryAvailable(): Promise<boolean> {
  try {
    const result = await runCodeGraph(["--version"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function truncateForReason(text: string, maxLength = 300): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

/**
 * Detects, and if safe, initializes a CodeGraph index scoped to
 * `worktreePath`. Never throws -- every failure mode (binary absent,
 * pre-existing index, init failure, post-init verification failure)
 * resolves to `{ available: false, managedByHarness: false, reason }`
 * instead. Callers (`ce start`) must never let CodeGraph provisioning
 * fail the command itself; this function's never-throw contract is
 * what makes that trivial, but callers should still guard the call site
 * defensively (see start.ts).
 */
export async function initializeCodeGraph(worktreePath: string): Promise<CodeGraphResult> {
  const indexPath = expectedCodeGraphIndexPath(worktreePath);

  try {
    if (existsSync(indexPath)) {
      return {
        available: false,
        managedByHarness: false,
        reason:
          'A ".codegraph" directory already exists in this worktree (most likely tracked in ' +
          "the repository itself). ce-harness never claims, modifies, or deletes a pre-existing " +
          "index it did not create.",
      };
    }

    const binaryAvailable = await isCodeGraphBinaryAvailable();
    if (!binaryAvailable) {
      return {
        available: false,
        managedByHarness: false,
        reason: 'The "codegraph" executable was not found on PATH.',
      };
    }

    const initResult = await runCodeGraph(["init", worktreePath]);
    if (initResult.exitCode !== 0) {
      return {
        available: false,
        managedByHarness: false,
        reason: `"codegraph init" failed: ${truncateForReason(initResult.stderr || initResult.stdout)}`,
      };
    }

    if (!existsSync(indexPath)) {
      return {
        available: false,
        managedByHarness: false,
        reason: '"codegraph init" reported success, but no ".codegraph" directory was found afterward.',
      };
    }

    return {
      available: true,
      managedByHarness: true,
      indexPath,
      initializedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      available: false,
      managedByHarness: false,
      reason: `CodeGraph setup encountered an unexpected error: ${(error as Error).message}`,
    };
  }
}

export interface IgnoreCodeGraphResult {
  ignored: boolean;
  reason?: string;
}

/**
 * Ensures `.codegraph` never appears as an untracked directory in `git
 * status` for this worktree, via Git's own local, never-committed
 * exclude mechanism (see `addLocalExcludePattern`) -- never a tracked
 * `.gitignore` change, and never anything the user has to remember to
 * do themselves. Only ever called once CodeGraph is confirmed
 * `available` and `managedByHarness` for this exact worktree (see
 * `initializeCodeGraph`'s result) -- a pre-existing `.codegraph/`
 * ce-harness doesn't own is never touched, and this function is never
 * even invoked for it.
 *
 * Never throws, mirroring `initializeCodeGraph`'s own contract: failing
 * to add the exclude entry is purely cosmetic (git status would show an
 * extra untracked directory) and must never fail `ce start` itself.
 * Returns a result instead so a caller may still choose to surface a
 * soft warning.
 */
export async function ignoreCodeGraphIndex(worktreePath: string): Promise<IgnoreCodeGraphResult> {
  try {
    await addLocalExcludePattern(worktreePath, "/.codegraph");
    return { ignored: true };
  } catch (error) {
    return { ignored: false, reason: (error as Error).message };
  }
}

/**
 * Writes the workspace-owned OpenCode config that registers CodeGraph's
 * MCP server, scoped to this workspace only -- never the user's global
 * OpenCode config. Injected via the `OPENCODE_CONFIG` environment
 * variable (distinct from `OPENCODE_CONFIG_DIR`), so it merges
 * additively with whatever the user already has globally rather than
 * replacing it.
 */
export async function writeCodeGraphOpenCodeConfig(
  workspacePath: string,
  worktreePath: string,
): Promise<string> {
  const configPath = expectedCodeGraphOpenCodeConfigPath(workspacePath);
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      codegraph: {
        type: "local",
        command: [codeGraphBinary(), "serve", "--mcp", "--path", worktreePath],
        enabled: true,
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * Returns the workspace's CodeGraph metadata only if it can be trusted
 * -- i.e. it is recorded as harness-managed AND its `indexPath` matches
 * exactly what ce-harness would itself compute for this workspace's
 * worktree. Mirrors `resolveTrustedOpenSpec`'s defensive posture: a
 * corrupted or tampered `workspace.yml` must never cause real worktree
 * changes to be silently excluded from dirty detection.
 */
export function resolveTrustedCodeGraph(workspace: Workspace): CodeGraphResult | null {
  const persisted = workspace.codeGraph;
  if (!persisted) return null;
  if (!persisted.available || !persisted.managedByHarness) return null;
  if (!persisted.indexPath) return null;

  const expected = expectedCodeGraphIndexPath(workspace.worktreePath);
  if (persisted.indexPath !== expected) return null;

  return persisted;
}
