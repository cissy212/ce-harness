/**
 * ce-harness's own minimum Node version, derived from its dependencies'
 * declared `engines.node` requirements (not an assumed value): commander
 * (imported directly by the CLI entrypoint) and execa both require
 * Node >=22 as of this writing, and commander's exact floor is 22.12.0 --
 * the strictest constraint among the full dependency tree. Below that,
 * loading commander/execa throws a raw SyntaxError from deep inside a
 * transitive dependency (a regex feature those Node versions don't
 * support), not an actionable message.
 *
 * This module has no dependencies of its own, so it is always safe to
 * import statically, on any Node version, before deciding whether it's
 * safe to load the rest of the CLI.
 */
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 12;

export const MINIMUM_SUPPORTED_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`;

/** True if `version` (e.g. "22.12.0", typically `process.versions.node`) meets ce-harness's minimum. */
export function isSupportedNodeVersion(version: string): boolean {
  const [majorRaw, minorRaw] = version.split(".");
  const major = Number.parseInt(majorRaw ?? "", 10);
  const minor = Number.parseInt(minorRaw ?? "", 10);

  if (Number.isNaN(major)) return false;
  if (major > MIN_NODE_MAJOR) return true;
  if (major < MIN_NODE_MAJOR) return false;
  return Number.isNaN(minor) ? false : minor >= MIN_NODE_MINOR;
}

/** Clear, actionable message for when the running Node version is too old. */
export function unsupportedNodeVersionMessage(version: string): string {
  return [
    `ce-harness requires Node.js >=${MINIMUM_SUPPORTED_NODE_VERSION}, but this process is running Node.js ${version}.`,
    "",
    "Install a supported Node version and try again:",
    `  - with nvm:      nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`,
    "  - without nvm:   download an LTS release from https://nodejs.org/",
    "",
    "Then confirm it took effect with: node --version",
  ].join("\n");
}
