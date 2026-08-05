import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { copyTemplates } from "./templates.js";

/**
 * External OpenCode configuration for a workspace, lives at
 * <workspacePath>/opencode and is pointed to via OPENCODE_CONFIG_DIR when
 * launching OpenCode. Never created inside the target repository or its
 * Git worktree.
 *
 * The path is fully deterministic from the workspace path, so it is
 * never persisted in workspace.yml: `status`/`cleanup` simply recompute
 * it. This also means older workspace files with no config-path field
 * remain fully compatible without any schema change.
 */

/**
 * OpenCode's own subdirectory names, each populated from a harness
 * template category. `agents` is OpenCode's folder convention; its
 * source of truth is templates/lenses/ (see ./lenses.ts), not a
 * templates/agents/ directory.
 */
const CONFIG_SUBDIRECTORIES: Array<{ destination: string; templateCategory: string }> = [
  { destination: "commands", templateCategory: "commands" },
  { destination: "skills", templateCategory: "skills" },
  { destination: "agents", templateCategory: "lenses" },
  { destination: "prompts", templateCategory: "prompts" },
];

/** The only path OpenCode's external config directory may live at for a workspace. */
export function expectedOpenCodeConfigDir(workspacePath: string): string {
  return join(workspacePath, "opencode");
}

/**
 * Creates the minimal OpenCode config directory structure for a
 * workspace: <workspacePath>/opencode/{commands,skills,agents,prompts},
 * then populates each from the harness's template library (see
 * ./templates.ts), e.g. templates/commands/*.md into opencode/commands/.
 * Every subdirectory is created unconditionally, whether or not its
 * category has any templates. Returns the config directory path.
 */
export async function createOpenCodeConfig(workspacePath: string): Promise<string> {
  const configDir = expectedOpenCodeConfigDir(workspacePath);
  for (const { destination, templateCategory } of CONFIG_SUBDIRECTORIES) {
    const destinationDir = join(configDir, destination);
    await mkdir(destinationDir, { recursive: true });
    await copyTemplates(templateCategory, destinationDir);
  }
  return configDir;
}

/** True if the workspace's OpenCode config directory exists on disk. */
export function openCodeConfigExists(workspacePath: string): boolean {
  return existsSync(expectedOpenCodeConfigDir(workspacePath));
}
