import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOpenCodeConfig, expectedOpenCodeConfigDir } from "../opencodeConfig.js";
import { formatLaunchCommand, launchOpenCode, openCodeBinary } from "../opencode.js";
import { resolveTrustedCodeGraph } from "../codeGraph.js";
import type { Workspace } from "../workspace.js";
import type { RefreshConfigResult, RunnerSpec, RunnerWorkspacePaths } from "./types.js";

/**
 * OpenCode as a `RunnerSpec`: a thin composition over the existing,
 * unmodified core/opencode.ts (process launch) and core/opencodeConfig.ts
 * (config-directory materialization) modules, plus the OpenCode-specific
 * CodeGraph MCP config this module now owns (moved here from
 * core/codeGraph.ts, which must never import runner-specific code).
 *
 * The only path the workspace-owned OpenCode MCP config for CodeGraph may
 * live at, mirroring expectedOpenCodeConfigDir's own "only path" contract.
 */
function expectedCodeGraphOpenCodeConfigPath(workspacePath: string): string {
  return join(expectedOpenCodeConfigDir(workspacePath), "opencode.json");
}

async function writeConfig(paths: RunnerWorkspacePaths): Promise<string[]> {
  await createOpenCodeConfig(paths.workspacePath);
  // OpenCode's config lives entirely under the workspace directory,
  // never inside the worktree, so it has no worktree-relative paths to
  // report -- there is no pre-existing path it could ever conflict with
  // either.
  return [];
}

/**
 * Refreshes OpenCode's config against the harness's current template
 * library -- see `RunnerSpec.refreshConfig`. Unlike Claude, there is no
 * ownership ambiguity to protect against here: OpenCode's config lives
 * entirely under the workspace directory, which ce-harness exclusively
 * owns (the same reason `writeConfig` above already uses the plain,
 * unconditional-overwrite `createOpenCodeConfig` rather than a
 * collision-safe copy). Refreshing is simply running that same,
 * already-idempotent provisioning again -- no worktree files are
 * involved, so `commandsManaged`/`commandsManagedHashes` never apply to
 * this runner, exactly like `writeConfig`'s `[]` and
 * `managedWorktreeRelativePaths`'s `[]` below.
 */
async function refreshConfig(
  paths: RunnerWorkspacePaths,
  _workspace: Workspace,
): Promise<RefreshConfigResult> {
  await createOpenCodeConfig(paths.workspacePath);
  return {
    result: { updated: [], unchanged: [], skipped: [] },
    commandsManaged: [],
    commandsManagedHashes: {},
  };
}

/**
 * Writes the workspace-owned OpenCode config that registers CodeGraph's
 * MCP server, scoped to this workspace only -- never the user's global
 * OpenCode config. Injected via the `OPENCODE_CONFIG` environment
 * variable (distinct from `OPENCODE_CONFIG_DIR`), so it merges
 * additively with whatever the user already has globally rather than
 * replacing it.
 */
async function writeCodeGraphConfig(
  paths: RunnerWorkspacePaths,
  codeGraphBinary: string,
): Promise<boolean> {
  const configPath = expectedCodeGraphOpenCodeConfigPath(paths.workspacePath);
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      codegraph: {
        type: "local",
        command: [codeGraphBinary, "serve", "--mcp", "--path", paths.worktreePath],
        enabled: true,
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  // Same rationale as writeConfig: this file lives under the workspace
  // directory, never inside the worktree, so it never conflicts with
  // anything the target repository owns.
  return true;
}

function buildEnv(workspace: Workspace): Record<string, string> {
  const env: Record<string, string> = {
    OPENCODE_CONFIG_DIR: expectedOpenCodeConfigDir(workspace.workspacePath),
  };

  const trustedCodeGraph = resolveTrustedCodeGraph(workspace);
  if (trustedCodeGraph?.indexPath && existsSync(trustedCodeGraph.indexPath)) {
    env.OPENCODE_CONFIG = expectedCodeGraphOpenCodeConfigPath(workspace.workspacePath);
  }

  return env;
}

/** OpenCode never writes anything inside the worktree -- nothing to ever exclude from a dirty check. */
function managedWorktreeRelativePaths(_workspace: Workspace): string[] {
  return [];
}

export const OPENCODE_RUNNER: RunnerSpec = {
  id: "opencode",
  label: "OpenCode",
  binary: openCodeBinary,
  writeConfig,
  refreshConfig,
  writeCodeGraphConfig,
  buildEnv,
  managedWorktreeRelativePaths,
  launch: launchOpenCode,
  formatLaunchCommand,
};
