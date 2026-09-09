import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeProjectDirName, summarizeClaudeCodeUsage } from "../../src/core/claudeCodeUsage.js";

function assistantLine(opts: {
  timestamp: string;
  attributionSkill?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.timestamp,
    ...(opts.attributionSkill ? { attributionSkill: opts.attributionSkill } : {}),
    message: {
      role: "assistant",
      usage: {
        input_tokens: opts.inputTokens ?? 0,
        output_tokens: opts.outputTokens ?? 0,
        cache_creation_input_tokens: opts.cacheCreationInputTokens ?? 0,
        cache_read_input_tokens: opts.cacheReadInputTokens ?? 0,
      },
    },
  });
}

function costStateLine(opts: { sessionId: string; totalCostUSD: number; startTime: number }): string {
  return JSON.stringify({
    type: "cost-state",
    sessionId: opts.sessionId,
    totalCostUSD: opts.totalCostUSD,
    startTime: opts.startTime,
  });
}

describe("claudeCodeProjectDirName", () => {
  it("replaces every / and . with -, preserving case and existing hyphens", () => {
    expect(claudeCodeProjectDirName("/Users/ceciliacanteros/.ce-harness/worktrees/market-audit-tool/138")).toBe(
      "-Users-ceciliacanteros--ce-harness-worktrees-market-audit-tool-138",
    );
    expect(claudeCodeProjectDirName("/Users/x/Work/MAT/market-audit-tool")).toBe(
      "-Users-x-Work-MAT-market-audit-tool",
    );
  });
});

describe("summarizeClaudeCodeUsage", () => {
  let claudeHome: string;
  const originalEnv = process.env.CE_CLAUDE_HOME;
  const worktreePath = "/Users/tester/.ce-harness/worktrees/proj/42";

  beforeEach(async () => {
    claudeHome = await mkdtemp(join(tmpdir(), "ce-harness-claude-home-"));
    process.env.CE_CLAUDE_HOME = claudeHome;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CE_CLAUDE_HOME;
    } else {
      process.env.CE_CLAUDE_HOME = originalEnv;
    }
    await rm(claudeHome, { recursive: true, force: true });
  });

  function projectDir(): string {
    return join(claudeHome, "projects", claudeCodeProjectDirName(worktreePath));
  }

  it("reports projectDirFound: false when no Claude Code project directory exists for this worktree", async () => {
    const result = await summarizeClaudeCodeUsage(worktreePath, "2026-01-01T00:00:00.000Z");
    expect(result.projectDirFound).toBe(false);
    expect(result.sessionsScanned).toBe(0);
    expect(result.byStage).toEqual({});
  });

  it("aggregates token usage by attributionSkill across multiple assistant messages", async () => {
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "session-1.jsonl"),
      [
        assistantLine({
          timestamp: "2026-01-02T00:00:00.000Z",
          attributionSkill: "verify",
          inputTokens: 10,
          outputTokens: 100,
          cacheReadInputTokens: 1000,
        }),
        assistantLine({
          timestamp: "2026-01-02T00:01:00.000Z",
          attributionSkill: "verify",
          inputTokens: 5,
          outputTokens: 50,
        }),
        assistantLine({
          timestamp: "2026-01-02T00:02:00.000Z",
          attributionSkill: "explore",
          outputTokens: 20,
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await summarizeClaudeCodeUsage(worktreePath, "2026-01-01T00:00:00.000Z");
    expect(result.projectDirFound).toBe(true);
    expect(result.sessionsScanned).toBe(1);
    expect(result.attributionSupported).toBe(true);
    expect(result.byStage.verify).toEqual({
      inputTokens: 15,
      outputTokens: 150,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1000,
    });
    expect(result.byStage.explore.outputTokens).toBe(20);
  });

  it('buckets untagged messages under "(unattributed)" and reports attributionSupported: false when nothing was tagged', async () => {
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "session-1.jsonl"),
      [assistantLine({ timestamp: "2026-01-02T00:00:00.000Z", outputTokens: 42 })].join("\n"),
      "utf8",
    );

    const result = await summarizeClaudeCodeUsage(worktreePath, "2026-01-01T00:00:00.000Z");
    expect(result.attributionSupported).toBe(false);
    expect(result.byStage["(unattributed)"].outputTokens).toBe(42);
  });

  it("sets attributionSupported: true once at least one tagged message is found, even alongside untagged ones", async () => {
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "session-1.jsonl"),
      [
        assistantLine({ timestamp: "2026-01-02T00:00:00.000Z", outputTokens: 1 }),
        assistantLine({ timestamp: "2026-01-02T00:00:01.000Z", attributionSkill: "apply", outputTokens: 2 }),
      ].join("\n"),
      "utf8",
    );

    const result = await summarizeClaudeCodeUsage(worktreePath, "2026-01-01T00:00:00.000Z");
    expect(result.attributionSupported).toBe(true);
    expect(result.byStage["(unattributed)"].outputTokens).toBe(1);
    expect(result.byStage.apply.outputTokens).toBe(2);
  });

  it("ignores messages timestamped before the since cutoff (a stale session from a reused worktree path)", async () => {
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "old-session.jsonl"),
      [
        assistantLine({
          timestamp: "2025-01-01T00:00:00.000Z",
          attributionSkill: "verify",
          outputTokens: 999,
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await summarizeClaudeCodeUsage(worktreePath, "2026-01-01T00:00:00.000Z");
    expect(result.byStage).toEqual({});
  });

  it("includes a session's cost-state total only when its startTime is at or after the cutoff", async () => {
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    const sinceMs = Date.parse("2026-01-01T00:00:00.000Z");
    await writeFile(
      join(dir, "fresh-session.jsonl"),
      [costStateLine({ sessionId: "fresh", totalCostUSD: 5, startTime: sinceMs + 1000 })].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "stale-session.jsonl"),
      [costStateLine({ sessionId: "stale", totalCostUSD: 999, startTime: sinceMs - 1000 })].join("\n"),
      "utf8",
    );

    const result = await summarizeClaudeCodeUsage(worktreePath, "2026-01-01T00:00:00.000Z");
    expect(result.sessionCosts).toEqual([{ sessionId: "fresh", totalCostUSD: 5 }]);
  });

  it("scans subagent transcripts under <session-id>/subagents/ and attributes them the same way", async () => {
    const dir = projectDir();
    await mkdir(join(dir, "session-1", "subagents"), { recursive: true });
    await writeFile(join(dir, "session-1.jsonl"), "", "utf8");
    await writeFile(
      join(dir, "session-1", "subagents", "agent-abc.jsonl"),
      [
        assistantLine({
          timestamp: "2026-01-02T00:00:00.000Z",
          attributionSkill: "archive",
          outputTokens: 77,
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await summarizeClaudeCodeUsage(worktreePath, "2026-01-01T00:00:00.000Z");
    expect(result.subagentTranscriptsScanned).toBe(1);
    expect(result.byStage.archive.outputTokens).toBe(77);
  });

  it("never throws on a malformed or unparseable line -- skips it and keeps going", async () => {
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "session-1.jsonl"),
      [
        "not valid json at all {{{",
        assistantLine({ timestamp: "2026-01-02T00:00:00.000Z", attributionSkill: "publish", outputTokens: 3 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await summarizeClaudeCodeUsage(worktreePath, "2026-01-01T00:00:00.000Z");
    expect(result.byStage.publish.outputTokens).toBe(3);
  });
});
