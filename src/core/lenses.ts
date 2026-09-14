import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { copyTemplates, copyTemplatesSkippingCollisions, type CollisionAwareCopyResult } from "./templates.js";

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

/**
 * Additively syncs `<workspacePath>/lenses` against the harness's
 * *current* template library -- the `ce refresh` counterpart to
 * `createLensesDir`, for a workspace that already exists.
 *
 * Unlike `RunnerSpec.refreshConfig`'s command-file refresh, this never
 * overwrites an existing entry, harness-written or not: `createLensesDir`
 * never recorded which lens files it wrote (there is no hash-tracking
 * scheme for lenses, unlike `commandsManagedHashes`), so there is no way
 * to prove an existing lens file is still exactly what ce-harness itself
 * last wrote there -- and no need to, since the only thing this needs to
 * fix is a lens the harness's template library has gained *since* this
 * workspace was created (see `copyTemplatesSkippingCollisions`'s own
 * collision-safe, add-only semantics). A lens file the user hand-edited,
 * or dropped in themselves, is therefore always left completely alone,
 * exactly like an already-existing entry from the harness's own library.
 *
 * A brand-new workspace already gets every current lens at `ce start`
 * time (`createLensesDir`); this only ever has something to add for a
 * workspace that predates a lens added to `templates/lenses/` later --
 * which matters most for a long-lived or repeatedly-refreshed review
 * workspace (see `ce review`'s follow-up refresh and
 * `templates/commands/adversarial-review.md`'s Step 7).
 */
export async function refreshLensesDir(workspacePath: string): Promise<CollisionAwareCopyResult> {
  return copyTemplatesSkippingCollisions(LENSES_TEMPLATE_CATEGORY, expectedLensesDir(workspacePath));
}
