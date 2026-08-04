import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the fake `openspec` executable used by tests. */
export const FAKE_OPENSPEC_BIN = fileURLToPath(
  new URL("../fixtures/fake-openspec.mjs", import.meta.url),
);

/** Path to a binary that is guaranteed not to exist, for "unavailable" tests. */
export function nonExistentOpenSpecBin(dir: string): string {
  return join(dir, "openspec-does-not-exist");
}

export interface FakeOpenSpecEnv {
  dir: string;
  registryFile: string;
}

/**
 * Points ce-harness at the fake `openspec` executable with a fresh,
 * isolated registry file. Never touches the real `openspec` executable
 * or the user's real store registry.
 */
export async function setupFakeOpenSpec(): Promise<FakeOpenSpecEnv> {
  const dir = await mkdtemp(join(tmpdir(), "ce-harness-fake-openspec-"));
  const registryFile = join(dir, "registry.json");
  process.env.CE_OPENSPEC_BIN = FAKE_OPENSPEC_BIN;
  process.env.FAKE_OPENSPEC_REGISTRY = registryFile;
  return { dir, registryFile };
}

export async function teardownFakeOpenSpec(env: FakeOpenSpecEnv): Promise<void> {
  delete process.env.CE_OPENSPEC_BIN;
  delete process.env.FAKE_OPENSPEC_REGISTRY;
  delete process.env.FAKE_OPENSPEC_FAIL_SETUP;
  delete process.env.FAKE_OPENSPEC_FAIL_DOCTOR;
  delete process.env.FAKE_OPENSPEC_FAIL_UNREGISTER;
  await rm(env.dir, { recursive: true, force: true });
}
