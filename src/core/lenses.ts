import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { copyTemplates } from "./templates.js";

/**
 * Canonical, runner-agnostic directory of reasoning lenses for a workspace.
 *
 * Canonical reasoning lenses are stored independently of runner-specific
 * configuration: this directory lives at <workspacePath>/lenses, as a
 * sibling of (never nested inside) the OpenCode-specific opencode/
 * config directory managed by ./opencodeConfig.ts.
 *
 * `/verify` and `/adversarial-review` discover and read lenses only
 * through the injected CE_LENSES_DIR environment variable, which always
 * points here. Workflow templates and lens files must never hardcode
 * `opencode/agents` or any other runner-specific path.
 *
 * The OpenCode adapter (see opencodeConfig.ts's `agents/` subdirectory)
 * may additionally mirror the same template files under
 * <workspacePath>/opencode/agents/ for OpenCode's own discovery or UI.
 * That mirror is populated from the same source templates
 * (templates/lenses/*.md) as this canonical directory, so the two stay
 * byte-identical, but it is never the source of truth and other runner
 * adapters are never required to produce it.
 */

/** Template category lenses are sourced from: templates/lenses/*.md. */
const LENSES_TEMPLATE_CATEGORY = "lenses";

/** The only path the canonical lens directory may live at for a workspace. */
export function expectedLensesDir(workspacePath: string): string {
  return join(workspacePath, "lenses");
}

/**
 * Creates <workspacePath>/lenses and populates it from the harness's
 * template library (templates/lenses/*.md), the same source used by
 * opencodeConfig.ts's OpenCode-specific mirror. Returns the directory
 * path.
 */
export async function createLensesDir(workspacePath: string): Promise<string> {
  const destination = expectedLensesDir(workspacePath);
  await mkdir(destination, { recursive: true });
  await copyTemplates(LENSES_TEMPLATE_CATEGORY, destination);
  return destination;
}

/** True if the workspace's canonical lens directory exists on disk. */
export function lensesDirExists(workspacePath: string): boolean {
  return existsSync(expectedLensesDir(workspacePath));
}
