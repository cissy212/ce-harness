import { CeError } from "./errors.js";
import { readGitConfig } from "./git.js";

/**
 * Configurable terminal-presentation preferences for `ce start`/`ce
 * review`/`ce resume`: whether to attempt opening a two-pane iTerm2
 * layout at all (see core/terminal/iterm2.ts) instead of launching the
 * runner directly in the current terminal, and which tab color (if any)
 * to apply. Reuses the two configuration mechanisms this repo already
 * has -- no new config file format, no general-purpose terminal-
 * presentation framework:
 *
 *   - the `CE_TERMINAL_LAYOUT` env var, same family as every other
 *     `CE_*` override, for one-off overrides and deterministic tests;
 *   - Git config keys, read exactly like `ce-harness.branch-pattern`
 *     (see branchNaming.ts) via Git's own local-overrides-global-
 *     overrides-system resolution, for a persisted personal default
 *     (e.g. `git config --global ce-harness.terminal-layout none` to
 *     opt out everywhere).
 *
 * `auto` (the default when neither is set) means "attempt it when
 * possible, silently behave exactly as before this feature otherwise" --
 * see core/workspacePresenter.ts for what "possible" and "otherwise"
 * mean in practice.
 */

export type TerminalLayoutPreference = "auto" | "iterm2" | "none";

const VALID_PREFERENCES: TerminalLayoutPreference[] = ["auto", "iterm2", "none"];

export const TERMINAL_LAYOUT_ENV_VAR = "CE_TERMINAL_LAYOUT";
export const TERMINAL_LAYOUT_CONFIG_KEY = "ce-harness.terminal-layout";
export const DEFAULT_TERMINAL_LAYOUT_PREFERENCE: TerminalLayoutPreference = "auto";

function parsePreference(value: string, source: string): TerminalLayoutPreference {
  if ((VALID_PREFERENCES as string[]).includes(value)) {
    return value as TerminalLayoutPreference;
  }
  throw new CeError(
    `Invalid terminal layout preference "${value}" (from ${source}).`,
    `Use one of: ${VALID_PREFERENCES.join(", ")}.`,
  );
}

/**
 * Resolves the effective terminal layout preference for `repoPath`.
 * Precedence: `CE_TERMINAL_LAYOUT` env var, then the
 * `ce-harness.terminal-layout` Git config key, then `"auto"`.
 */
export async function resolveTerminalLayoutPreference(
  repoPath: string,
): Promise<TerminalLayoutPreference> {
  const envValue = process.env[TERMINAL_LAYOUT_ENV_VAR];
  if (envValue && envValue.length > 0) {
    return parsePreference(envValue, `the ${TERMINAL_LAYOUT_ENV_VAR} environment variable`);
  }

  const configured = await readGitConfig(repoPath, TERMINAL_LAYOUT_CONFIG_KEY);
  if (configured) {
    return parsePreference(configured, `the "${TERMINAL_LAYOUT_CONFIG_KEY}" Git config key`);
  }

  return DEFAULT_TERMINAL_LAYOUT_PREFERENCE;
}

export const TAB_COLOR_CONFIG_KEY = "ce-harness.tab-color";

/**
 * Resolves this repository's configured iTerm2 tab color, e.g. to tell
 * projects apart at a glance without hand-maintaining an iTerm2 profile
 * per project:
 *
 *   git config ce-harness.tab-color "blue"
 *
 * Returns the raw configured string (a color name or a hex value) or
 * `undefined` when unset -- parsing it into an actual color is
 * `core/terminal/iterm2.ts`'s job (`parseTabColor`), which is also where
 * the set of recognized names lives. This function only ever reads Git
 * config, exactly like `resolveTerminalLayoutPreference` above.
 */
export async function resolveTabColor(repoPath: string): Promise<string | undefined> {
  const configured = await readGitConfig(repoPath, TAB_COLOR_CONFIG_KEY);
  return configured ?? undefined;
}
