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

/**
 * `ce publish`'s branch name for the target repository -- deliberately a
 * separate pattern/config key from the one above, never derived from it:
 * `internalBranch` (`ce-harness/{issue}` by default) is ce-harness's own
 * working branch and is never pushed or exposed anywhere -- `ce publish`
 * only ever pushes the *commits* it points at, under this independently
 * computed name. Two defaults: with a resolved OpenSpec change name,
 * `{issue}-{change}` (e.g. `feature/130-addressbook-email-notes`,
 * matching a real repository's normal branch-naming feel); without one
 * (no change could be resolved -- see core/activeChange.ts's
 * `resolveArchivedChangeForWorkspace`), just `{issue}`. Configurable the
 * same way as `ce-harness.branch-pattern`, via a Git config key:
 *
 *   git config ce-harness.publish-branch-pattern "release/{issue}"
 */
export const DEFAULT_PUBLISH_BRANCH_PATTERN_WITH_CHANGE = "feature/{issue}-{change}";
export const DEFAULT_PUBLISH_BRANCH_PATTERN_WITHOUT_CHANGE = "feature/{issue}";
export const PUBLISH_BRANCH_PATTERN_CONFIG_KEY = "ce-harness.publish-branch-pattern";
const CHANGE_PLACEHOLDER = "{change}";
/** Never-publish-under-this-prefix guard -- see renderPublishBranchName. */
const HARNESS_BRANCH_PREFIX = "ce-harness/";

/**
 * Resolves the publish-branch pattern configured for `repoPath` (via
 * `ce-harness.publish-branch-pattern`), falling back to one of the two
 * defaults above depending on whether a *distinct* change name was
 * resolved.
 *
 * "Distinct" deliberately excludes the case where `changeName` is
 * exactly equal to `sanitizedIssue` (e.g. an issue slug of
 * `case-studies-domain-model` whose OpenSpec change is also named
 * `case-studies-domain-model`, a common outcome when a change is
 * proposed straight from the issue slug with no separate naming step).
 * Including `{change}` in that case would render the same text twice
 * back-to-back (`feature/case-studies-domain-model-case-studies-domain-
 * model`) for zero added information -- so this falls back to the
 * without-change default instead, exactly as if no change had been
 * resolved at all.
 *
 * This only affects which *default* is chosen when nothing is
 * configured. An explicitly configured `ce-harness.publish-branch-
 * pattern` is always honored exactly as written, including its own use
 * of `{change}` -- this never second-guesses an explicit configuration.
 */
export async function resolvePublishBranchPattern(
  repoPath: string,
  sanitizedIssue: string,
  changeName: string | null,
): Promise<string> {
  const configured = await readGitConfig(repoPath, PUBLISH_BRANCH_PATTERN_CONFIG_KEY);
  if (configured) return configured;
  const hasDistinctChange = changeName !== null && changeName !== sanitizedIssue;
  return hasDistinctChange ? DEFAULT_PUBLISH_BRANCH_PATTERN_WITH_CHANGE : DEFAULT_PUBLISH_BRANCH_PATTERN_WITHOUT_CHANGE;
}

/**
 * Renders `pattern` into the exact branch name `ce publish` will push
 * to the target repository. Throws if `pattern` uses `{change}` but no
 * `changeName` was resolved (same "catch the misconfiguration early"
 * reasoning as `renderBranchName`'s missing-`{issue}` check), and throws
 * if the *rendered* result would start with `ce-harness/` -- whether
 * from a hand-misconfigured pattern or (structurally impossible today,
 * but checked anyway) any other source -- since a branch exposed to the
 * target repository must never carry ce-harness's own internal naming.
 */
export function renderPublishBranchName(
  pattern: string,
  sanitizedIssue: string,
  changeName: string | null,
): string {
  if (pattern.includes(CHANGE_PLACEHOLDER) && !changeName) {
    throw new CeError(
      `The configured publish-branch pattern "${pattern}" requires "${CHANGE_PLACEHOLDER}", but no OpenSpec change name could be resolved for this workspace.`,
      `Pass an explicit --change <name>, or configure a pattern that doesn't use "${CHANGE_PLACEHOLDER}" (e.g. \`git config ${PUBLISH_BRANCH_PATTERN_CONFIG_KEY} "${DEFAULT_PUBLISH_BRANCH_PATTERN_WITHOUT_CHANGE}"\`).`,
    );
  }
  let rendered = pattern.split(ISSUE_PLACEHOLDER).join(sanitizedIssue);
  if (changeName) rendered = rendered.split(CHANGE_PLACEHOLDER).join(changeName);

  if (rendered.startsWith(HARNESS_BRANCH_PREFIX)) {
    throw new CeError(
      `The configured publish-branch pattern renders to "${rendered}", which starts with "${HARNESS_BRANCH_PREFIX}" -- branches exposed to the target repository must never use ce-harness's own internal branch naming.`,
      `Configure a pattern that doesn't start with "${HARNESS_BRANCH_PREFIX}" (e.g. \`git config ${PUBLISH_BRANCH_PATTERN_CONFIG_KEY} "feature/${ISSUE_PLACEHOLDER}"\`).`,
    );
  }
  return rendered;
}
