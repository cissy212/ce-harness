import { fileURLToPath } from "node:url";

/** Absolute path to the fake `docker` executable used by tests. */
export const FAKE_DOCKER_BIN = fileURLToPath(new URL("../fixtures/fake-docker.mjs", import.meta.url));

/** Path to a binary that is guaranteed not to exist, for "Docker not installed" tests. */
export function nonExistentDockerBin(): string {
  return "/nonexistent/path/docker-does-not-exist";
}

export interface FakeDockerContainer {
  /** Container id, as `docker ps -q` would print it. Any unique string works. */
  id: string;
  /** Container name, without Docker's leading "/". */
  name: string;
  mounts: Array<{ source: string; type: "bind" | "volume" }>;
}

/**
 * Points ce-harness at the fake `docker` executable and configures it to
 * report exactly `containers` as the currently running containers (each
 * with its mounts) -- or none at all if omitted. Never touches a real
 * Docker installation.
 */
export function setupFakeDocker(containers: FakeDockerContainer[] = []): void {
  process.env.CE_DOCKER_BIN = FAKE_DOCKER_BIN;
  process.env.FAKE_DOCKER_PS_IDS = containers.map((c) => c.id).join("\n");
  process.env.FAKE_DOCKER_INSPECT_OUTPUT = containers
    .map((c) => {
      const mounts = c.mounts.map((m) => ({ Source: m.source, Type: m.type }));
      return `/${c.name}\t${JSON.stringify(mounts)}`;
    })
    .join("\n");
}

/** Points ce-harness at the fake `docker` executable, configured to fail every invocation (simulating a daemon that isn't running). */
export function setupFakeDockerUnavailable(): void {
  process.env.CE_DOCKER_BIN = FAKE_DOCKER_BIN;
  process.env.FAKE_DOCKER_EXIT_CODE = "1";
}

/** Points ce-harness at a guaranteed-nonexistent `docker` binary (simulating Docker not being installed at all). */
export function setupFakeDockerNotInstalled(): void {
  process.env.CE_DOCKER_BIN = nonExistentDockerBin();
}

export function teardownFakeDocker(): void {
  delete process.env.CE_DOCKER_BIN;
  delete process.env.FAKE_DOCKER_PS_IDS;
  delete process.env.FAKE_DOCKER_INSPECT_OUTPUT;
  delete process.env.FAKE_DOCKER_EXIT_CODE;
}
