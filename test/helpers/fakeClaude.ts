import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the fake `claude` executable used by tests. */
export const FAKE_CLAUDE_BIN = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));

/** Path to a binary that is guaranteed not to exist, for "cannot launch" tests. */
export function nonExistentClaudeBin(dir: string): string {
  return join(dir, "claude-does-not-exist");
}

export interface FakeClaudeEnv {
  dir: string;
  outputFile: string;
}

/**
 * Points ce-harness at the fake `claude` executable, with a fresh
 * output file it records its cwd/argv/env to. Never launches the real
 * Claude Code CLI.
 */
export async function setupFakeClaude(): Promise<FakeClaudeEnv> {
  const dir = await mkdtemp(join(tmpdir(), "ce-harness-fake-claude-"));
  const outputFile = join(dir, "launch.json");
  process.env.CE_CLAUDE_BIN = FAKE_CLAUDE_BIN;
  process.env.FAKE_CLAUDE_OUTPUT = outputFile;
  return { dir, outputFile };
}

export async function teardownFakeClaude(env: FakeClaudeEnv): Promise<void> {
  delete process.env.CE_CLAUDE_BIN;
  delete process.env.FAKE_CLAUDE_OUTPUT;
  delete process.env.FAKE_CLAUDE_EXIT_CODE;
  await rm(env.dir, { recursive: true, force: true });
}
