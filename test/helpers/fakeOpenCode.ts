import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the fake `opencode` executable used by tests. */
export const FAKE_OPENCODE_BIN = fileURLToPath(
  new URL("../fixtures/fake-opencode.mjs", import.meta.url),
);

/** Path to a binary that is guaranteed not to exist, for "cannot launch" tests. */
export function nonExistentOpenCodeBin(dir: string): string {
  return join(dir, "opencode-does-not-exist");
}

export interface FakeOpenCodeEnv {
  dir: string;
  outputFile: string;
}

/**
 * Points ce-harness at the fake `opencode` executable, with a fresh
 * output file it records its cwd/argv/env to. Never launches the real
 * OpenCode.
 */
export async function setupFakeOpenCode(): Promise<FakeOpenCodeEnv> {
  const dir = await mkdtemp(join(tmpdir(), "ce-harness-fake-opencode-"));
  const outputFile = join(dir, "launch.json");
  process.env.CE_OPENCODE_BIN = FAKE_OPENCODE_BIN;
  process.env.FAKE_OPENCODE_OUTPUT = outputFile;
  return { dir, outputFile };
}

export async function teardownFakeOpenCode(env: FakeOpenCodeEnv): Promise<void> {
  delete process.env.CE_OPENCODE_BIN;
  delete process.env.FAKE_OPENCODE_OUTPUT;
  delete process.env.FAKE_OPENCODE_EXIT_CODE;
  await rm(env.dir, { recursive: true, force: true });
}
