import type { BootstrapCheckResult } from "./bootstrap.js";
import type { WorkspaceType } from "./workspace.js";

/**
 * The `ce start` success summary, printed once the workspace is fully
 * created and just before OpenCode launches. Structured as an ordered
 * list of independent sections -- each an optional title plus body
 * lines -- specifically so a future addition (e.g. a new diagnostic)
 * is always just one more entry appended to `buildStartupSummary`'s
 * list, never a redesign of how the command formats or prints output.
 */

export interface SummarySection {
  /** Omitted entirely for a section with no heading (e.g. the opening line). */
  title?: string;
  lines: string[];
}

export interface StartupSummaryInput {
  worktreePath: string;
  workspaceType: WorkspaceType;
  bootstrap: BootstrapCheckResult;
}

/** The next slash command suggested inside the OpenCode session, based on this workspace's type. */
function nextSuggestedStep(workspaceType: WorkspaceType): string {
  // An Existing PR review workspace has no OpenSpec change to explore or
  // propose -- /adversarial-review is the whole workflow there (see
  // README's "Reviewing a GitHub pull request" / "...pull request or
  // commit range" sections). Every other (Implementation) workspace
  // starts from investigating or planning the change.
  return workspaceType === "Existing PR review" ? "/adversarial-review" : "/explore";
}

/**
 * Builds the ordered list of summary sections for a freshly created
 * workspace. Pure and synchronous -- callers own printing it.
 */
export function buildStartupSummary({
  worktreePath,
  workspaceType,
  bootstrap,
}: StartupSummaryInput): SummarySection[] {
  const sections: SummarySection[] = [
    { lines: ["Workspace ready."] },
    { title: "Worktree", lines: [worktreePath] },
    { title: "Open in VS Code", lines: [`code ${worktreePath}`] },
  ];

  if (bootstrap.required) {
    sections.push({
      title: "Bootstrap needed",
      lines: [
        "This repository needs local setup before normal use:",
        ...bootstrap.findings.flatMap((finding) => {
          const findingLines = [`- ${finding.message}`, `  Run: ${finding.suggestedCommand}`];
          if (finding.sideEffectWarning) {
            findingLines.push(`  Warning: ${finding.sideEffectWarning}`);
          }
          return findingLines;
        }),
        "ce-harness never runs these automatically -- run them yourself inside the worktree above.",
      ],
    });
  }

  sections.push({ title: "Next suggested step", lines: [nextSuggestedStep(workspaceType)] });

  return sections;
}

/** Renders `sections` into the exact printable block: title directly above its body, one blank line between sections. */
export function formatStartupSummary(sections: SummarySection[]): string {
  return sections
    .map((section) =>
      section.title ? `${section.title}\n${section.lines.join("\n")}` : section.lines.join("\n"),
    )
    .join("\n\n");
}
