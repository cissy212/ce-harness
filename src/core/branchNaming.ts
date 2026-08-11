import { CeError } from "./errors.js";
import { readGitConfig } from "./git.js";

/**
 * Configurable branch-naming for the internal ce-harness working
 * branch created for every workspace. Different repositories use
 * different conventions (`feature/{issue}`, `bugfix/{issue}`,
 * `review/{issue}`, or no prefix at all) -- this module lets a
 * repository (or a user, machine-wide) override the pattern via Git's
 * own config resolution, with no ce-harness-specific config file or
 * format, and no repository-specific logic hardcoded anywhere in
 * ce-harness itself. Existing behavior (`ce-harness/{issue}`) remains
 * the default for every repository that hasn't opted into anything
 * else.
 *
 * To use a different pattern, set the `ce-harness.branch-pattern` Git
 * config key -- locally, for just one repository:
 *
 *   git config ce-harness.branch-pattern "feature/{issue}"
 *
 * or globally, as a personal default across every repository:
 *
 *   git config --global ce-harness.branch-pattern "feature/{issue}"
 *
 * Git's own local-overrides-global-overrides-system resolution applies
 * as usual -- ce-harness never re-implements or duplicates that logic.
 */

export const DEFAULT_BRANCH_PATTERN = "ce-harness/{issue}";
export const BRANCH_PATTERN_CONFIG_KEY = "ce-harness.branch-pattern";
const ISSUE_PLACEHOLDER = "{issue}";

/**
 * Resolves the branch-naming pattern configured for `repoPath` (via
 * `ce-harness.branch-pattern`), falling back to `DEFAULT_BRANCH_PATTERN`
 * when nothing is configured.
 */
export async function resolveBranchPattern(repoPath: string): Promise<string> {
  const configured = await readGitConfig(repoPath, BRANCH_PATTERN_CONFIG_KEY);
  return configured ?? DEFAULT_BRANCH_PATTERN;
}

/**
 * Renders `pattern` into the exact branch name for `sanitizedIssue`.
 * Throws if `pattern` doesn't contain the `{issue}` placeholder at all
 * -- every workspace for that repository would otherwise render to the
 * exact same branch name, a configuration mistake worth catching with
 * a clear, specific message rather than surfacing later as a confusing
 * "branch already exists" collision on the second workspace.
 */
export function renderBranchName(pattern: string, sanitizedIssue: string): string {
  if (!pattern.includes(ISSUE_PLACEHOLDER)) {
    throw new CeError(
      `The configured branch-naming pattern "${pattern}" does not include the "${ISSUE_PLACEHOLDER}" placeholder.`,
      `Set a pattern that includes "${ISSUE_PLACEHOLDER}" (e.g. \`git config ${BRANCH_PATTERN_CONFIG_KEY} "feature/${ISSUE_PLACEHOLDER}"\`), or remove the override (\`git config --unset ${BRANCH_PATTERN_CONFIG_KEY}\`) to use the default ("${DEFAULT_BRANCH_PATTERN}").`,
    );
  }
  return pattern.split(ISSUE_PLACEHOLDER).join(sanitizedIssue);
}
