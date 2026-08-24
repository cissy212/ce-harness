#!/usr/bin/env node
// A minimal stand-in for the `docker` CLI, used exclusively by tests so
// they never depend on a real Docker installation or real containers.
//
// - `docker ps -q` prints FAKE_DOCKER_PS_IDS (newline-separated container
//   ids), or nothing at all if unset/empty (no running containers).
// - `docker inspect --format ... <ids...>` prints FAKE_DOCKER_INSPECT_OUTPUT
//   verbatim (already-formatted "name\tjson-mounts" lines).
// - If FAKE_DOCKER_EXIT_CODE is set, every invocation exits with that code
//   and prints nothing, simulating Docker being unreachable (daemon not
//   running, etc.) regardless of which subcommand was requested.

const exitCode = process.env.FAKE_DOCKER_EXIT_CODE
  ? parseInt(process.env.FAKE_DOCKER_EXIT_CODE, 10)
  : 0;

if (exitCode !== 0) {
  process.exit(exitCode);
}

const args = process.argv.slice(2);

if (args[0] === "ps") {
  const ids = process.env.FAKE_DOCKER_PS_IDS ?? "";
  process.stdout.write(ids.length > 0 ? `${ids}\n` : "");
} else if (args[0] === "inspect") {
  process.stdout.write(process.env.FAKE_DOCKER_INSPECT_OUTPUT ?? "");
}

process.exit(0);
