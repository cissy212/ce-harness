import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the fake `osascript` executable used by tests. */
export const FAKE_OSASCRIPT_BIN = fileURLToPath(new URL("../fixtures/fake-osascript.mjs", import.meta.url));

/** Path to a binary that is guaranteed not to exist, for "unavailable" tests -- never invokes real AppleScript/iTerm2. */
export function nonExistentOsascriptBin(): string {
  return "/nonexistent/path/osascript-does-not-exist";
}

export interface FakeOsascriptEnv {
  dir: string;
  outputFile: string;
}

/**
 * Points ce-harness at the fake `osascript` executable (which reports
 * itself as available), with a fresh output file it records its argv
 * (including the full AppleScript source) to. Never invokes real
 * AppleScript or opens a real terminal window.
 */
export async function setupFakeOsascript(): Promise<FakeOsascriptEnv> {
  const dir = await mkdtemp(join(tmpdir(), "ce-harness-fake-osascript-"));
  const outputFile = join(dir, "osascript.json");
  process.env.CE_OSASCRIPT_BIN = FAKE_OSASCRIPT_BIN;
  process.env.FAKE_OSASCRIPT_OUTPUT = outputFile;
  return { dir, outputFile };
}

export async function teardownFakeOsascript(env: FakeOsascriptEnv): Promise<void> {
  delete process.env.CE_OSASCRIPT_BIN;
  delete process.env.FAKE_OSASCRIPT_OUTPUT;
  delete process.env.FAKE_OSASCRIPT_EXIT_CODE;
  delete process.env.FAKE_OSASCRIPT_PROBE_EXIT_CODE;
  delete process.env.FAKE_OSASCRIPT_STDERR;
  await rm(env.dir, { recursive: true, force: true });
}
