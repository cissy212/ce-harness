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
 * Deliberately repository-agnostic: detection is scoped to ecosystems
 * where "are dependencies installed in this exact worktree" has a
 * single, unambiguous, always-local answer (a manifest file paired with
 * a standard, always-project-local install directory). Ecosystems where
 * that isn't reliably true (e.g. Python's virtualenvs, which commonly
 * live outside the project entirely -- Poetry's default cache location,
 * a Conda environment, etc. -- or Ruby's Bundler, whose default install
 * location is the system gem path unless explicitly reconfigured) are
 * intentionally not covered here: guessing would risk exactly the kind
 * of project-specific, false-positive assumption this feature must
 * avoid. Extending coverage to a new ecosystem later only ever means
 * adding one more entry to `PROBES` below, with no other change needed.
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
}

export interface BootstrapCheckResult {
  /** True when one or more findings indicate local setup is needed before normal use. */
  required: boolean;
  findings: BootstrapFinding[];
}

interface Probe {
  (worktreePath: string): BootstrapFinding | null;
}

/**
 * Node.js (npm/yarn/pnpm): `package.json` declares dependencies, but
 * `node_modules/` -- always worktree-local, never shared or tracked --
 * doesn't exist yet. The suggested command follows whichever lockfile
 * is present, defaulting to npm (bundled with Node) when none is.
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

  let message = 'package.json found, but node_modules/ does not exist -- dependencies have never been installed in this worktree.';
  if (hasPrepareScript(manifest)) {
    message +=
      ' This package also defines a "prepare" script -- package managers normally run it ' +
      "automatically as part of install, so no separate action is needed for it once dependencies are installed.";
  }

  return { ecosystem: "npm", manifest: "package.json", message, suggestedCommand };
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
    message: "composer.json found, but vendor/ does not exist -- dependencies have never been installed in this worktree.",
    suggestedCommand: "composer install",
  };
};

const PROBES: Probe[] = [checkNodeEcosystem, checkComposerEcosystem];

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
