import { describe, expect, it } from "vitest";
import {
  buildStartupSummary,
  formatStartupSummary,
  type SummarySection,
} from "../../src/core/startupSummary.js";
import type { BootstrapCheckResult } from "../../src/core/bootstrap.js";

const NO_BOOTSTRAP: BootstrapCheckResult = { required: false, findings: [] };

describe("startupSummary (ce start's success output)", () => {
  describe("buildStartupSummary", () => {
    it("includes the four always-present sections, in order, for an Implementation workspace with no bootstrap needed", () => {
      const sections = buildStartupSummary({
        worktreePath: "/home/user/.ce-harness/worktrees/Oz/blog-domain-entities",
        workspaceType: "Implementation",
        bootstrap: NO_BOOTSTRAP,
      });

      expect(sections).toEqual([
        { lines: ["Workspace ready."] },
        { title: "Worktree", lines: ["/home/user/.ce-harness/worktrees/Oz/blog-domain-entities"] },
        {
          title: "Open in VS Code",
          lines: ["code /home/user/.ce-harness/worktrees/Oz/blog-domain-entities"],
        },
        { title: "Next suggested step", lines: ["/explore"] },
      ]);
    });

    it('suggests "/explore" for an Implementation workspace', () => {
      const sections = buildStartupSummary({
        worktreePath: "/wt",
        workspaceType: "Implementation",
        bootstrap: NO_BOOTSTRAP,
      });
      const nextStep = sections.find((s) => s.title === "Next suggested step");
      expect(nextStep?.lines).toEqual(["/explore"]);
    });

    it('suggests "/adversarial-review" for an Existing PR review workspace, never /explore', () => {
      const sections = buildStartupSummary({
        worktreePath: "/wt",
        workspaceType: "Existing PR review",
        bootstrap: NO_BOOTSTRAP,
      });
      const nextStep = sections.find((s) => s.title === "Next suggested step");
      expect(nextStep?.lines).toEqual(["/adversarial-review"]);
    });

    it("omits the Bootstrap section entirely when nothing is required", () => {
      const sections = buildStartupSummary({
        worktreePath: "/wt",
        workspaceType: "Implementation",
        bootstrap: NO_BOOTSTRAP,
      });
      expect(sections.some((s) => s.title === "Bootstrap needed")).toBe(false);
    });

    it("includes a Bootstrap section with each finding's message, command, and warning when required", () => {
      const sections = buildStartupSummary({
        worktreePath: "/wt",
        workspaceType: "Implementation",
        bootstrap: {
          required: true,
          findings: [
            {
              ecosystem: "npm",
              manifest: "package.json",
              message: "package.json found, but node_modules/ does not exist.",
              suggestedCommand: "npm install",
              sideEffectWarning: "This can modify the lockfile.",
            },
          ],
        },
      });

      const bootstrapSection = sections.find((s) => s.title === "Bootstrap needed");
      expect(bootstrapSection).toBeDefined();
      expect(bootstrapSection!.lines.join("\n")).toContain(
        "package.json found, but node_modules/ does not exist.",
      );
      expect(bootstrapSection!.lines.join("\n")).toContain("Run: npm install");
      expect(bootstrapSection!.lines.join("\n")).toContain("Warning: This can modify the lockfile.");
      expect(bootstrapSection!.lines.join("\n")).toMatch(
        /ce-harness never runs these automatically/,
      );
    });

    it("omits the Warning line for a finding with no sideEffectWarning", () => {
      const sections = buildStartupSummary({
        worktreePath: "/wt",
        workspaceType: "Implementation",
        bootstrap: {
          required: true,
          findings: [
            {
              ecosystem: "npm",
              manifest: "package.json",
              message: "Dependencies are installed, but .husky/_/husky.sh does not exist.",
              suggestedCommand: "npm run prepare",
            },
          ],
        },
      });

      const bootstrapSection = sections.find((s) => s.title === "Bootstrap needed")!;
      expect(bootstrapSection.lines.join("\n")).not.toMatch(/Warning:/);
    });

    it("includes every finding when multiple ecosystems need bootstrapping", () => {
      const sections = buildStartupSummary({
        worktreePath: "/wt",
        workspaceType: "Implementation",
        bootstrap: {
          required: true,
          findings: [
            {
              ecosystem: "npm",
              manifest: "package.json",
              message: "npm finding",
              suggestedCommand: "npm install",
            },
            {
              ecosystem: "Composer",
              manifest: "composer.json",
              message: "composer finding",
              suggestedCommand: "composer install",
            },
          ],
        },
      });

      const bootstrapSection = sections.find((s) => s.title === "Bootstrap needed")!;
      expect(bootstrapSection.lines.join("\n")).toContain("npm finding");
      expect(bootstrapSection.lines.join("\n")).toContain("composer finding");
    });

    it("places the Bootstrap section between the always-present sections and Next suggested step, keeping that last", () => {
      const sections = buildStartupSummary({
        worktreePath: "/wt",
        workspaceType: "Implementation",
        bootstrap: {
          required: true,
          findings: [
            {
              ecosystem: "npm",
              manifest: "package.json",
              message: "x",
              suggestedCommand: "npm install",
            },
          ],
        },
      });

      expect(sections.at(-1)!.title).toBe("Next suggested step");
      const bootstrapIdx = sections.findIndex((s) => s.title === "Bootstrap needed");
      expect(bootstrapIdx).toBeGreaterThan(0);
      expect(bootstrapIdx).toBeLessThan(sections.length - 1);
    });
  });

  describe("formatStartupSummary", () => {
    it("renders a title directly above its body, with one blank line between sections", () => {
      const sections: SummarySection[] = [
        { lines: ["Workspace ready."] },
        { title: "Worktree", lines: ["/wt"] },
      ];

      expect(formatStartupSummary(sections)).toBe("Workspace ready.\n\nWorktree\n/wt");
    });

    it("joins multi-line section bodies without an extra blank line inside the section", () => {
      const sections: SummarySection[] = [{ title: "Bootstrap needed", lines: ["a", "b", "c"] }];

      expect(formatStartupSummary(sections)).toBe("Bootstrap needed\na\nb\nc");
    });

    it("renders the full example from the task (Implementation workspace, no bootstrap needed)", () => {
      const sections = buildStartupSummary({
        worktreePath: "/home/user/.ce-harness/worktrees/Oz/blog-domain-entities",
        workspaceType: "Implementation",
        bootstrap: NO_BOOTSTRAP,
      });

      expect(formatStartupSummary(sections)).toBe(
        [
          "Workspace ready.",
          "",
          "Worktree",
          "/home/user/.ce-harness/worktrees/Oz/blog-domain-entities",
          "",
          "Open in VS Code",
          "code /home/user/.ce-harness/worktrees/Oz/blog-domain-entities",
          "",
          "Next suggested step",
          "/explore",
        ].join("\n"),
      );
    });
  });
});
