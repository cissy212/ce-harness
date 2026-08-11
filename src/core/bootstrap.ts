import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Repository bootstrap detection: a freshly created Git worktree is not
 * necessarily a development-ready workspace. Some repositories require
 * local setup steps before normal use -- most commonly, declared
 * dependencies that must be installed once per worktree (`node_modules`,
 * `vendor/`, etc. are never shared across worktrees, since they're
 * untracked). Left undetected, this surfaces much later as a confusing
 * failure (e.g. the first commit failing because a Git hook manager's
 * binary doesn't exist yet).
 *
 * This module only ever reads files and directory-existence, entirely
 * inside the isolated worktree -- it never executes a repository's
 * scripts, installs anything, or otherwise causes any side effect.
 * Every finding pairs a plain-language explanation with the exact
 * command the user would run themselves; running it is always their own
 * explicit decision, never something `ce start` does automatically.
 *
 * Bootstrap always prefers the minimum necessary action over defaulting
 * to a full dependency install: a full install can rewrite a lockfile
 * (an undesirable repository modification if nothing actually needed
 * it), whereas a repository whose dependencies are already installed
 * but whose local lifecycle-script side effects (e.g. Git hooks) never
 * ran needs only that narrower step re-run -- see
 * `checkNodeLifecycleScript` below, which exists specifically to prefer
 * `npm run prepare` over `npm install` whenever that's sufficient.
 * When a finding's suggested command cannot avoid a side effect (a full
 * install always can rewrite a lockfile), that risk is named explicitly
 * in `sideEffectWarning` so the user is warned before they decide to run
 * it themselves -- never left to discover it afterward.
 *
 * Deliberately repository-agnostic: detection is scoped to ecosystems
 * and tools where "is local setup needed in this exact worktree" has a
 * single, unambiguous, always-local answer (a manifest/usage marker
 * paired with a standard, always-project-local artifact). Ecosystems
 * where that isn't reliably true (e.g. Python's virtualenvs, which
 * commonly live outside the project entirely -- Poetry's default cache
 * location, a Conda environment, etc. -- or Ruby's Bundler, whose
 * default install location is the system gem path unless explicitly
 * reconfigured) are intentionally not covered here: guessing would risk
 * exactly the kind of project-specific, false-positive assumption this
 * feature must avoid. Extending coverage to a new ecosystem or tool
 * later only ever means adding one more entry to `PROBES` (or to
 * `NODE_LIFECYCLE_ARTIFACTS`, for another Git-hook-manager-style tool),
 * with no other change needed.
 */

export interface BootstrapFinding {
  /** The ecosystem/tool this finding is about (e.g. "npm", "Composer"). */
  ecosystem: string;
  /** The manifest file whose presence triggered this finding. */
  manifest: string;
  /** Plain-language explanation of what's missing and why it matters. */
  message: string;
  /** The exact command the user should run themselves. Never executed by ce-harness. */
  suggestedCommand: string;
  /**
   * Set only when `suggestedCommand` cannot avoid a side effect beyond
   * the minimum necessary action (e.g. a full install potentially
   * rewriting a lockfile) -- absent entirely for a targeted, minimal
   * command (e.g. re-running just a "prepare" script) that doesn't
   * carry that risk.
   */
  sideEffectWarning?: string;
}

export interface BootstrapCheckResult {
  /** True when one or more findings indicate local setup is needed before normal use. */
  required: boolean;
  findings: BootstrapFinding[];
}

interface Probe {
  (worktreePath: string): BootstrapFinding | null;
}

const LOCKFILE_SIDE_EFFECT_WARNING =
  "This can modify the lockfile (e.g. package-lock.json, yarn.lock, or pnpm-lock.yaml) if dependency resolution has drifted since it was last generated.";

/**
 * Node.js (npm/yarn/pnpm), full install: `package.json` declares
 * dependencies, but `node_modules/` -- always worktree-local, never
 * shared or tracked -- doesn't exist yet. Nothing narrower can
 * substitute here (a "prepare" script, if any, typically depends on
 * packages a full install alone fetches), so this is the one case where
 * the broader command really is the minimum necessary action -- its
 * lockfile side effect is named explicitly rather than left implicit.
 * The suggested command follows whichever lockfile is present,
 * defaulting to npm (bundled with Node) when none is.
 */
const checkNodeEcosystem: Probe = (worktreePath) => {
  const manifest = join(worktreePath, "package.json");
  if (!existsSync(manifest)) return null;
  if (existsSync(join(worktreePath, "node_modules"))) return null;

  let suggestedCommand = "npm install";
  if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) {
    suggestedCommand = "pnpm install";
  } else if (existsSync(join(worktreePath, "yarn.lock"))) {
    suggestedCommand = "yarn install";
  } else if (existsSync(join(worktreePath, "package-lock.json"))) {
    suggestedCommand = "npm install";
  }

  let message =
    "package.json found, but node_modules/ does not exist -- dependencies have never been installed in this worktree.";
  if (hasPrepareScript(manifest)) {
    message +=
      ' This package also declares a "prepare" script -- installing will run it automatically, as usual.';
  }

  return {
    ecosystem: "npm",
    manifest: "package.json",
    message,
    suggestedCommand,
    sideEffectWarning: LOCKFILE_SIDE_EFFECT_WARNING,
  };
};

/** A well-known local artifact a package's "prepare" script is expected to produce, once it has actually run. */
interface LifecycleArtifact {
  /** The tool this artifact belongs to (for the finding's message only -- never used to decide anything). */
  tool: string;
  /** A path whose presence proves this repository actually uses `tool` (so absence of the artifact below isn't mistaken for "tool unused"). */
  usageMarker: string;
  /** The path `tool`'s own local setup step is expected to create. */
  expectedArtifact: string;
}

const NODE_LIFECYCLE_ARTIFACTS: LifecycleArtifact[] = [
  { tool: "Husky", usageMarker: ".husky", expectedArtifact: ".husky/_/husky.sh" },
];

/**
 * Node.js, targeted setup: dependencies are already installed
 * (`node_modules/` exists -- see `checkNodeEcosystem` above for the
 * case where they aren't), the package declares a "prepare" script, and
 * a well-known artifact that script is expected to produce is missing.
 * This is exactly the case a full reinstall would over-solve: re-running
 * only the "prepare" script is sufficient, and -- unlike an install --
 * never touches a lockfile, so this finding carries no
 * `sideEffectWarning`.
 */
const checkNodeLifecycleScript: Probe = (worktreePath) => {
  const manifest = join(worktreePath, "package.json");
  if (!existsSync(manifest)) return null;
  if (!existsSync(join(worktreePath, "node_modules"))) return null; // handled by checkNodeEcosystem instead
  if (!hasPrepareScript(manifest)) return null;

  const missing = NODE_LIFECYCLE_ARTIFACTS.find(
    (artifact) =>
      existsSync(join(worktreePath, artifact.usageMarker)) &&
      !existsSync(join(worktreePath, artifact.expectedArtifact)),
  );
  if (!missing) return null;

  return {
    ecosystem: "npm",
    manifest: "package.json",
    message:
      `Dependencies are installed, but ${missing.expectedArtifact} does not exist -- ` +
      `this package's "prepare" script (used by ${missing.tool}) has not run in this worktree yet.`,
    suggestedCommand: "npm run prepare",
  };
};

function hasPrepareScript(packageJsonPath: string): boolean {
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return typeof parsed.scripts?.prepare === "string" && parsed.scripts.prepare.length > 0;
  } catch {
    // An unreadable or malformed package.json is not this function's
    // concern to diagnose -- just skip the extra context, never throw.
    return false;
  }
}

/** PHP (Composer): `composer.json` declares dependencies, but `vendor/` -- always project-local -- doesn't exist yet. */
const checkComposerEcosystem: Probe = (worktreePath) => {
  const manifest = join(worktreePath, "composer.json");
  if (!existsSync(manifest)) return null;
  if (existsSync(join(worktreePath, "vendor"))) return null;

  return {
    ecosystem: "Composer",
    manifest: "composer.json",
    message:
      "composer.json found, but vendor/ does not exist -- dependencies have never been installed in this worktree.",
    suggestedCommand: "composer install",
    sideEffectWarning:
      "This can modify composer.lock if dependency resolution has drifted since it was last generated.",
  };
};

const PROBES: Probe[] = [checkNodeEcosystem, checkNodeLifecycleScript, checkComposerEcosystem];

/**
 * Inspects `worktreePath` for common, repository-agnostic bootstrap
 * conventions. Purely read-only and synchronous in effect (no network,
 * no process execution) -- callers should still treat it defensively
 * (never let a failure here fail `ce start` itself), matching the
 * convention already established for CodeGraph provisioning.
 */
export function detectBootstrapNeeds(worktreePath: string): BootstrapCheckResult {
  const findings = PROBES.map((probe) => probe(worktreePath)).filter(
    (finding): finding is BootstrapFinding => finding !== null,
  );
  return { required: findings.length > 0, findings };
}
