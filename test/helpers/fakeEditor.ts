import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the fake editor (`code`) executable used by tests. */
export const FAKE_EDITOR_BIN = fileURLToPath(new URL("../fixtures/fake-editor.mjs", import.meta.url));

/** Path to a binary that is guaranteed not to exist, for "cannot launch" tests. */
export function nonExistentEditorBin(dir: string): string {
  return join(dir, "code-does-not-exist");
}

export interface FakeEditorEnv {
  dir: string;
  outputFile: string;
}

/**
 * Points ce-harness at the fake editor executable, with a fresh output
 * file it records its argv to. Never launches a real editor.
 */
export async function setupFakeEditor(): Promise<FakeEditorEnv> {
  const dir = await mkdtemp(join(tmpdir(), "ce-harness-fake-editor-"));
  const outputFile = join(dir, "open.json");
  process.env.CE_EDITOR_BIN = FAKE_EDITOR_BIN;
  process.env.FAKE_EDITOR_OUTPUT = outputFile;
  return { dir, outputFile };
}

export async function teardownFakeEditor(env: FakeEditorEnv): Promise<void> {
  delete process.env.CE_EDITOR_BIN;
  delete process.env.FAKE_EDITOR_OUTPUT;
  delete process.env.FAKE_EDITOR_EXIT_CODE;
  delete process.env.FAKE_EDITOR_STDERR;
  await rm(env.dir, { recursive: true, force: true });
}
