import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CeError } from "../core/errors.js";
import { parseWorkspaceSelector } from "../core/sanitize.js";
import {
  describeAvailableWorkspaces,
  readActivePointer,
  readWorkspace,
  resolveTrustedOpenSpec,
  workspaceExistsOnDisk,
  workspaceType,
  type ActivePointer,
  type Workspace,
} from "../core/workspace.js";
import {
  activeChangeRoot,
  archivedChangeRoot,
  listArchivedChanges,
  readChangeOwnership,
  resolveActiveChangesForWorkspace,
  summarizeChangeArtifacts,
} from "../core/activeChange.js";
import { listReviewReports } from "../core/reviewReports.js";
import { extractVerdict, type ReportVerdict } from "../core/workflowStatus.js";
import {
  summarizeClaudeCodeUsage,
  type ClaudeCodeUsageSummary,
  type TokenTotals,
} from "../core/claudeCodeUsage.js";

/**
 * `ce usage [workspace]`: a best-effort baseline of what a workspace's
 * work actually cost, combining two genuinely different kinds of data
 * and labeling them as such rather than blending them into one number:
 *
 * - Real, measured Claude Code token usage and session cost (see
 *   core/claudeCodeUsage.ts) -- present only when the runner was Claude
 *   Code and its local session data is still on disk.
 * - Deterministic facts ce-harness itself already wrote durably to this
 *   workspace's reports (verdicts, applied lenses, recorded warnings) --
 *   always available regardless of runner, but not a token/cost number.
 *
 * Deliberately read-only and additive: never changes workspace.yml, the
 * OpenSpec store, or any report. See the module-level doc comment in
 * core/claudeCodeUsage.ts for what's out of scope by design.
 */
export interface UsageOptions {
  workspace?: string;
}

interface ReportSummary {
  file: string;
  kind: "verify" | "adversarial-review";
  verdict: ReportVerdict | null;
  lensesApplied: string | null;
  warningsRecorded: number;
}

interface ArtifactGroup {
  label: string;
  reports: ReportSummary[];
}

const LENSES_APPLIED_PATTERN = /\*\*Lenses applied:\*\*\s*(.+)/;
const WARNINGS_LINE_PATTERN = /^\s*-\s*Warnings:/gm;

function reportKind(filename: string): "verify" | "adversarial-review" | null {
  if (filename.endsWith("-verify.md")) return "verify";
  if (filename.endsWith("-adversarial-review.md")) return "adversarial-review";
  return null;
}

async function summarizeReport(dir: string, filename: string): Promise<ReportSummary | null> {
  const kind = reportKind(filename);
  if (!kind) return null;
  try {
    const content = await readFile(join(dir, filename), "utf8");
    const lensesMatch = LENSES_APPLIED_PATTERN.exec(content);
    return {
      file: filename,
      kind,
      verdict: extractVerdict(content),
      lensesApplied: lensesMatch ? lensesMatch[1].trim() : null,
      warningsRecorded: (content.match(WARNINGS_LINE_PATTERN) ?? []).length,
    };
  } catch {
    return null;
  }
}

async function gatherArtifacts(workspace: Workspace): Promise<ArtifactGroup[]> {
  const trusted = resolveTrustedOpenSpec(workspace);
  if (!trusted) return [];

  if (workspaceType(workspace) === "Existing PR review") {
    const filenames = await listReviewReports(trusted.root);
    const reports = (
      await Promise.all(filenames.map((filename) => summarizeReport(join(trusted.root, "reviews"), filename)))
    ).filter((r): r is ReportSummary => r !== null);
    return reports.length > 0 ? [{ label: "PR review", reports }] : [];
  }

  const activeChanges = await resolveActiveChangesForWorkspace(trusted.root, workspace.project, workspace.issue);

  // A completed change's reports live under its *archived* directory, not
  // its (by then nonexistent) active one -- a workspace that finished its
  // whole workflow has none of the latter, so archived changes are just
  // as important a source here, not a fallback for when active is empty.
  const archived = await listArchivedChanges(trusted.root);
  const ownedArchived: { label: string; changeRoot: string }[] = [];
  for (const entry of archived) {
    const changeRoot = archivedChangeRoot(trusted.root, entry.archiveDirName);
    const ownership = await readChangeOwnership(changeRoot);
    if (ownership && ownership.project === workspace.project && ownership.issue === workspace.issue) {
      ownedArchived.push({ label: entry.name, changeRoot });
    }
  }

  const changeRoots: { label: string; changeRoot: string }[] = [
    ...activeChanges.map((name) => ({ label: name, changeRoot: activeChangeRoot(trusted.root, name) })),
    ...ownedArchived,
  ];

  const groups: ArtifactGroup[] = [];
  for (const { label, changeRoot } of changeRoots) {
    const summary = await summarizeChangeArtifacts(changeRoot);
    const reports = (
      await Promise.all(
        summary.reports.map((filename) => summarizeReport(join(changeRoot, "reports"), filename)),
      )
    ).filter((r): r is ReportSummary => r !== null);
    if (reports.length > 0) {
      groups.push({ label, reports });
    }
  }
  return groups;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function renderTokenTable(byStage: Record<string, TokenTotals>): string[] {
  const stages = Object.keys(byStage);
  if (stages.length === 0) return ["  (no messages found)"];

  // Deterministic, readable order: named stages first (insertion order,
  // which follows first-seen order in the transcripts), "(unattributed)" last.
  const ordered = [...stages.filter((s) => s !== "(unattributed)"), ...stages.filter((s) => s === "(unattributed)")];
  const nameWidth = Math.max(...ordered.map((s) => s.length));

  return ordered.map((stage) => {
    const t = byStage[stage];
    return (
      `  ${stage.padEnd(nameWidth)}  ` +
      `input ${formatTokens(t.inputTokens).padStart(8)}   ` +
      `output ${formatTokens(t.outputTokens).padStart(9)}   ` +
      `cache-read ${formatTokens(t.cacheReadInputTokens).padStart(11)}   ` +
      `cache-write ${formatTokens(t.cacheCreationInputTokens).padStart(9)}`
    );
  });
}

function renderUsageSummary(
  workspace: Workspace,
  usage: ClaudeCodeUsageSummary,
  artifacts: ArtifactGroup[],
): string {
  const lines: string[] = [];
  lines.push(`Usage summary: ${workspace.project}/${workspace.issue}`);
  lines.push("");

  if (!usage.projectDirFound) {
    lines.push("Local Claude Code session data: none found for this workspace.");
    lines.push(`  (checked ${usage.projectDir} -- this is expected if the runner was OpenCode,`);
    lines.push(`  no session has run yet, or Claude Code stores it somewhere else on this machine.)`);
  } else {
    lines.push(
      `Local Claude Code session data: ${usage.sessionsScanned} session(s), ` +
        `${usage.subagentTranscriptsScanned} subagent transcript(s)`,
    );
    lines.push(`  (from ${usage.projectDir} -- Claude Code's own local storage;`);
    lines.push(`  this format is internal/undocumented, not a stable API.)`);
    lines.push("");

    if (!usage.attributionSupported) {
      lines.push("Per-stage attribution: not available (no message in this workspace's sessions carried it --");
      lines.push("this needs a Claude Code version that tags messages by active command).");
      lines.push("");
    }

    lines.push("Token usage by workflow stage (real, measured):");
    lines.push(...renderTokenTable(usage.byStage));
    lines.push("");

    if (usage.sessionCosts.length > 0) {
      const total = usage.sessionCosts.reduce((sum, s) => sum + s.totalCostUSD, 0);
      lines.push(
        `Session cost (whole session, not per-stage -- real, provider-computed): ` +
          `$${total.toFixed(2)} across ${usage.sessionCosts.length} session(s)`,
      );
    } else {
      lines.push("Session cost: not available (no cost-state record found for a session in scope).");
    }
  }

  lines.push("");
  lines.push("ce-harness artifacts for this workspace (deterministic, from written reports):");
  if (artifacts.length === 0) {
    lines.push("  (no /verify or /adversarial-review reports written yet)");
  } else {
    for (const group of artifacts) {
      lines.push(`  ${group.label}:`);
      for (const report of group.reports) {
        const verdict = report.verdict ?? "(no verdict found)";
        const lenses = report.lensesApplied ?? "(none recorded)";
        const warnings = report.warningsRecorded > 0 ? `, warnings recorded: ${report.warningsRecorded}` : "";
        lines.push(`    ${report.file}  verdict ${verdict}  lenses: ${lenses}${warnings}`);
      }
    }
  }

  lines.push("");
  lines.push("Not covered by this summary:");
  lines.push("  - Only Claude Code sessions are read; an OpenCode-runner workspace shows no token data here.");
  lines.push("  - Per-stage dollar cost isn't directly available -- only whole-session totals above.");
  lines.push("  - Files read, tools called, and reasoning that left no attributed message aren't visible here.");
  lines.push("  - This reads Claude Code's internal, undocumented local storage; it may change without notice.");

  return lines.join("\n");
}

export async function usageCommand(options: UsageOptions = {}): Promise<void> {
  const pointer: ActivePointer | null = options.workspace
    ? parseWorkspaceSelector(options.workspace)
    : await readActivePointer();

  if (!pointer) {
    console.log("No active workspace.");
    console.log(await describeAvailableWorkspaces());
    return;
  }

  if (options.workspace && !workspaceExistsOnDisk(pointer.project, pointer.sanitizedIssue)) {
    throw new CeError(
      `No workspace found for "${pointer.project}/${pointer.sanitizedIssue}".`,
      await describeAvailableWorkspaces(),
    );
  }

  const workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);
  const [usage, artifacts] = await Promise.all([
    summarizeClaudeCodeUsage(workspace.worktreePath, workspace.createdAt),
    gatherArtifacts(workspace),
  ]);

  console.log(renderUsageSummary(workspace, usage, artifacts));
}
