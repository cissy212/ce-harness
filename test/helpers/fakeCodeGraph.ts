import { fileURLToPath } from "node:url";

/** Absolute path to the fake `codegraph` executable used by tests. */
export const FAKE_CODEGRAPH_BIN = fileURLToPath(
  new URL("../fixtures/fake-codegraph.mjs", import.meta.url),
);

/** Path to a binary that is guaranteed not to exist, for "unavailable" tests. */
export function nonExistentCodeGraphBin(): string {
  return "/nonexistent/path/codegraph-does-not-exist";
}

/** Points ce-harness at the fake `codegraph` executable. */
export function setupFakeCodeGraph(): void {
  process.env.CE_CODEGRAPH_BIN = FAKE_CODEGRAPH_BIN;
}

export function teardownFakeCodeGraph(): void {
  delete process.env.CE_CODEGRAPH_BIN;
  delete process.env.FAKE_CODEGRAPH_INIT_EXIT_CODE;
  delete process.env.FAKE_CODEGRAPH_INIT_STDERR;
  delete process.env.FAKE_CODEGRAPH_SKIP_CREATE;
}
