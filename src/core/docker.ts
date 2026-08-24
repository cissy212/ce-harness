import { execa } from "execa";
import { isPathInside, resolveCanonical } from "./paths.js";

/**
 * Detects whether a *running* Docker container has a bind mount rooted
 * at or inside a given path -- specifically so `ce cleanup` can refuse
 * to remove a worktree Git can no longer safely delete out from under a
 * live container (macOS/Docker Desktop can leave the host-side mount
 * point protected by a "deny delete" ACL for as long as a container
 * holds it, which makes `git worktree remove`'s recursive delete fail
 * partway through -- see the incident that motivated this module).
 *
 * Deliberately repository/application-agnostic: this never knows about
 * Docker Compose projects, service names, or any application-specific
 * concept -- it only ever asks "does any currently running container's
 * bind-mount source path fall at or under this exact path?"
 *
 * Split into a pure matching function (`findContainersMountingPath`,
 * fully unit-testable with synthetic data) and the side-effecting Docker
 * CLI query (`queryRunningContainerMounts`), so tests never need a real
 * Docker daemon or real containers.
 */

export interface ContainerMountSummary {
  /** Container name, without Docker's leading "/". */
  name: string;
  mounts: Array<{ source: string; type: string }>;
}

export interface BlockingContainer {
  /** Container name, without Docker's leading "/". */
  name: string;
  /** The exact bind-mount source path that falls at or inside the target path. */
  source: string;
}

/** Resolves the Docker CLI executable to invoke. Overridable for tests. */
export function dockerBinary(): string {
  return process.env.CE_DOCKER_BIN && process.env.CE_DOCKER_BIN.length > 0
    ? process.env.CE_DOCKER_BIN
    : "docker";
}

/**
 * Docker Desktop for Mac sometimes reports a bind mount's host source
 * with a `/host_mnt` prefix (an artifact of how its Linux VM represents
 * the Mac filesystem internally) instead of the plain host path -- both
 * refer to the exact same host location. Stripped before any path
 * comparison so this distinction never causes a false negative.
 */
function stripHostMntPrefix(path: string): string {
  return path.startsWith("/host_mnt/") ? path.slice("/host_mnt".length) : path;
}

/**
 * Pure, synchronous, no I/O: given already-fetched container mount
 * data, finds every container with a `bind` mount whose source is
 * exactly `targetPath` or a descendant of it. A prefix comparison alone
 * would wrongly match a sibling path that merely starts with the same
 * characters (e.g. `/foo/bar` matching `/foo/bar2`) -- `isPathInside`
 * (the same helper `ce cleanup`'s cwd-safety check already uses) is a
 * boundary-safe comparison, never a plain string prefix check.
 *
 * Callers comparing against real filesystem paths (see
 * `findRunningContainersMountingPath`) are responsible for resolving
 * symlinks in both `containers` and `targetPath` *before* calling this
 * -- doing that here would require I/O and give up the deterministic,
 * Docker-free unit-testability this function exists for.
 */
export function findContainersMountingPath(
  containers: ContainerMountSummary[],
  canonicalTargetPath: string,
): BlockingContainer[] {
  const blockers: BlockingContainer[] = [];
  for (const container of containers) {
    for (const mount of container.mounts) {
      if (mount.type !== "bind") continue;
      const source = stripHostMntPrefix(mount.source);
      if (isPathInside(source, canonicalTargetPath)) {
        blockers.push({ name: container.name, source: mount.source });
      }
    }
  }
  return blockers;
}

interface RawMount {
  Source?: unknown;
  Type?: unknown;
}

/** Parses `docker inspect --format '{{.Name}}\t{{json .Mounts}}'`'s line-per-container output. Never throws: a malformed line is skipped rather than failing the whole query. */
function parseInspectOutput(output: string): ContainerMountSummary[] {
  const containers: ContainerMountSummary[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex === -1) continue;

    const name = line.slice(0, tabIndex).replace(/^\//, "");
    const rawMountsJson = line.slice(tabIndex + 1);
    let rawMounts: RawMount[];
    try {
      const parsed = JSON.parse(rawMountsJson);
      if (!Array.isArray(parsed)) continue;
      rawMounts = parsed;
    } catch {
      continue;
    }

    const mounts = rawMounts
      .filter((m): m is RawMount & { Source: string; Type: string } => typeof m.Source === "string" && typeof m.Type === "string")
      .map((m) => ({ source: m.Source, type: m.Type }));
    containers.push({ name, mounts });
  }
  return containers;
}

/**
 * Queries every currently running container's mounts via the Docker
 * CLI. Never throws: Docker not installed, the daemon not running, or
 * any other query failure all resolve to `[]` (no signal available),
 * exactly like `isCodeGraphBinaryAvailable`/similar optional-tool
 * detection elsewhere in this codebase -- a missing or unreachable
 * Docker installation must never itself become a cleanup failure.
 */
async function queryRunningContainerMounts(): Promise<ContainerMountSummary[]> {
  const psResult = await execa(dockerBinary(), ["ps", "-q"], { reject: false });
  if (typeof psResult.exitCode !== "number" || psResult.exitCode !== 0) return [];

  const ids = psResult.stdout
    .split("\n")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) return [];

  const inspectResult = await execa(
    dockerBinary(),
    ["inspect", "--format", "{{.Name}}\t{{json .Mounts}}", ...ids],
    { reject: false },
  );
  if (typeof inspectResult.exitCode !== "number" || inspectResult.exitCode !== 0) return [];

  return parseInspectOutput(inspectResult.stdout);
}

/**
 * Finds every currently running Docker container with a bind mount at
 * or inside `targetPath`. Never throws -- see `queryRunningContainerMounts`.
 *
 * Both `targetPath` and every reported bind-mount source are
 * canonicalized (symlinks resolved) before comparison -- e.g. macOS
 * resolves `/tmp` to `/private/tmp`, and a mismatch on just one side of
 * the comparison would silently miss a real match. `findContainersMountingPath`
 * itself stays pure and synchronous (real symlink resolution needs I/O),
 * so that normalization happens here, once, before delegating to it.
 * Volume mounts are skipped before ever attempting to resolve them: a
 * volume's `Source` is a path inside Docker's own storage (invisible
 * from the host in the same way a bind-mount source is), so resolving
 * it would be wasted work that can never match a host worktree path.
 */
export async function findRunningContainersMountingPath(targetPath: string): Promise<BlockingContainer[]> {
  const canonicalTarget = await resolveCanonical(targetPath);
  const rawContainers = await queryRunningContainerMounts();

  const canonicalContainers: ContainerMountSummary[] = [];
  for (const container of rawContainers) {
    const mounts: Array<{ source: string; type: string }> = [];
    for (const mount of container.mounts) {
      if (mount.type !== "bind") continue;
      mounts.push({
        source: await resolveCanonical(stripHostMntPrefix(mount.source)),
        type: mount.type,
      });
    }
    canonicalContainers.push({ name: container.name, mounts });
  }

  return findContainersMountingPath(canonicalContainers, canonicalTarget);
}
