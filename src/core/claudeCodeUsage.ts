import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeCodeHome } from "./paths.js";

/**
 * Best-effort reader of Claude Code's own local session storage
 * (`~/.claude/projects/<sanitized-worktree-path>/*.jsonl` and
 * `<session-id>/subagents/*.jsonl`) for `ce usage`.
 *
 * This is deliberately the ONE place in ce-harness that reads
 * Claude-Code-specific state -- every other module (lenses, runners,
 * templates) stays runner-agnostic, since ce-harness also supports
 * OpenCode, which is not known to expose anything comparable locally.
 * `ce usage` degrades to "no data" for a workspace whose runner isn't
 * Claude Code, or whose Claude Code version predates this data; it never
 * assumes this source exists.
 *
 * Nothing read here is a documented, stable API: the project-directory
 * naming scheme and the `attributionSkill`/`usage`/`cost-state` fields
 * were reverse-engineered from real local files, not from published
 * Claude Code documentation, and may change without notice in a future
 * release. Every reader below treats a missing directory, an unreadable
 * file, an unparseable line, or an absent field as "no data here," never
 * as an error -- this module must never be the reason `ce usage` (or
 * anything calling it) crashes.
 */

/**
 * Claude Code's own project-directory naming: every `/` and `.` in the
 * absolute path becomes `-`. Verified against real local session
 * directories (e.g. `/Users/x/.ce-harness/worktrees/proj/42` ->
 * `-Users-x--ce-harness-worktrees-proj-42`) -- not documented anywhere.
 */
export function claudeCodeProjectDirName(absolutePath: string): string {
  return absolutePath.replace(/[/.]/g, "-");
}

/** The Claude Code project directory this worktree's sessions would live under, if any exist. */
export function claudeCodeProjectDir(worktreePath: string): string {
  return join(claudeCodeHome(), "projects", claudeCodeProjectDirName(worktreePath));
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface SessionCost {
  sessionId: string;
  totalCostUSD: number;
}

export interface ClaudeCodeUsageSummary {
  /** Whether a Claude Code project directory for this worktree exists at all. */
  projectDirFound: boolean;
  /** The path checked, present even when not found, for transparency. */
  projectDir: string;
  /** Number of top-level session transcript files found (after the since-cutoff filter). */
  sessionsScanned: number;
  /** Number of subagent transcript files found. */
  subagentTranscriptsScanned: number;
  /**
   * Whether at least one scanned assistant message carried an
   * `attributionSkill` field -- distinguishes "this Claude Code version
   * doesn't tag messages at all" from "everything scanned happened to be
   * untagged." `byStage` is still populated (under "(unattributed)")
   * either way.
   */
  attributionSupported: boolean;
  /** Token totals grouped by `attributionSkill` (ce-harness command name), or "(unattributed)". */
  byStage: Record<string, TokenTotals>;
  /** Session-level, provider-computed dollar totals -- whole session, never per-stage. */
  sessionCosts: SessionCost[];
}

function emptyTotals(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

function addUsage(target: TokenTotals, usage: Record<string, unknown>): void {
  target.inputTokens += numberField(usage.input_tokens);
  target.outputTokens += numberField(usage.output_tokens);
  target.cacheCreationInputTokens += numberField(usage.cache_creation_input_tokens);
  target.cacheReadInputTokens += numberField(usage.cache_read_input_tokens);
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parses one transcript file's lines into `summary`, ignoring anything before `sinceMs`. Never throws. */
async function scanTranscript(
  filePath: string,
  sinceMs: number,
  summary: ClaudeCodeUsageSummary,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === "assistant") {
      const message = record.message;
      if (!message || typeof message !== "object") continue;
      const usage = (message as Record<string, unknown>).usage;
      if (!usage || typeof usage !== "object") continue;

      const timestampMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      if (!Number.isNaN(timestampMs) && !Number.isNaN(sinceMs) && timestampMs < sinceMs) continue;

      const attribution = record.attributionSkill;
      const stage = typeof attribution === "string" && attribution.length > 0 ? attribution : "(unattributed)";
      if (stage !== "(unattributed)") summary.attributionSupported = true;

      summary.byStage[stage] ??= emptyTotals();
      addUsage(summary.byStage[stage], usage as Record<string, unknown>);
      continue;
    }

    if (record.type === "cost-state" && typeof record.totalCostUSD === "number") {
      // Only attribute a session's whole-session cost to this workspace
      // if we can confirm the session itself started after the
      // workspace was created -- otherwise a worktree path reused after
      // `ce cleanup` could silently attribute a prior incarnation's
      // spend to a fresh workspace.
      const startTimeMs = record.startTime;
      if (typeof startTimeMs === "number" && !Number.isNaN(sinceMs) && startTimeMs >= sinceMs) {
        summary.sessionCosts.push({
          sessionId: typeof record.sessionId === "string" ? record.sessionId : "(unknown)",
          totalCostUSD: record.totalCostUSD,
        });
      }
    }
  }
}

/**
 * Scans every Claude Code session (and subagent transcript) recorded for
 * `worktreePath`, ignoring anything timestamped before `sinceIso` (pass
 * the workspace's own `createdAt`), and aggregates token usage by
 * `attributionSkill`. See the module doc comment: best-effort only,
 * never throws, and every field is honest about what it does and does
 * not cover.
 */
export async function summarizeClaudeCodeUsage(
  worktreePath: string,
  sinceIso: string,
): Promise<ClaudeCodeUsageSummary> {
  const projectDir = claudeCodeProjectDir(worktreePath);
  const summary: ClaudeCodeUsageSummary = {
    projectDirFound: false,
    projectDir,
    sessionsScanned: 0,
    subagentTranscriptsScanned: 0,
    attributionSupported: false,
    byStage: {},
    sessionCosts: [],
  };

  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return summary;
  }
  summary.projectDirFound = true;

  const sinceMs = Date.parse(sinceIso);
  const sessionFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));

  for (const file of sessionFiles) {
    await scanTranscript(join(projectDir, file.name), sinceMs, summary);
    summary.sessionsScanned++;

    const sessionId = file.name.slice(0, -".jsonl".length);
    const subagentsDir = join(projectDir, sessionId, "subagents");
    let subagentFiles: string[];
    try {
      subagentFiles = (await readdir(subagentsDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name);
    } catch {
      subagentFiles = [];
    }
    for (const name of subagentFiles) {
      await scanTranscript(join(subagentsDir, name), sinceMs, summary);
      summary.subagentTranscriptsScanned++;
    }
  }

  return summary;
}
