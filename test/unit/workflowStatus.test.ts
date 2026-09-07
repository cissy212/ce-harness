import { describe, expect, it } from "vitest";
import {
  deriveImplementationWorkflowStatus,
  deriveReviewWorkflowStatus,
  extractVerdict,
  formatProgressLine,
  latestReportFile,
  parseTaskProgress,
  type ImplementationWorkflowInput,
} from "../../src/core/workflowStatus.js";
import type { ChangeArtifactSummary } from "../../src/core/activeChange.js";

function emptySummary(overrides: Partial<ChangeArtifactSummary> = {}): ChangeArtifactSummary {
  return {
    explore: { present: false },
    enrich: { present: false },
    proposal: { present: false },
    design: { present: false },
    tasks: { present: false },
    specs: [],
    reports: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<ImplementationWorkflowInput> = {}): ImplementationWorkflowInput {
  return {
    summary: emptySummary(),
    provenance: [],
    taskProgress: null,
    verifyVerdict: null,
    adversarialVerdict: null,
    bootstrapRequired: false,
    ...overrides,
  };
}

describe("extractVerdict", () => {
  it("extracts PASS", () => {
    expect(extractVerdict("**Verdict:** PASS\n\nReason: all good")).toBe("PASS");
  });

  it("extracts PASS WITH GAPS, not truncated to PASS", () => {
    expect(extractVerdict("**Verdict:** PASS WITH GAPS\n")).toBe("PASS WITH GAPS");
  });

  it("extracts FAIL", () => {
    expect(extractVerdict("blah blah\n**Verdict:** FAIL\nmore")).toBe("FAIL");
  });

  it("returns null when no verdict line is present", () => {
    expect(extractVerdict("# Report\nNo verdict here.")).toBeNull();
  });
});

describe("parseTaskProgress", () => {
  it("counts checked and unchecked boxes", () => {
    const content = "- [x] Task 1\n- [ ] Task 2\n- [X] Task 3\n";
    expect(parseTaskProgress(content)).toEqual({ completed: 2, total: 3 });
  });

  it("returns null when there are no checkboxes at all", () => {
    expect(parseTaskProgress("# Tasks\nNothing here yet.\n")).toBeNull();
  });

  it("ignores indentation and surrounding prose", () => {
    const content = "## Section\n  - [x] indented done\n  - [ ] indented pending\nSome other line\n";
    expect(parseTaskProgress(content)).toEqual({ completed: 1, total: 2 });
  });
});

describe("latestReportFile", () => {
  it("picks the most recent date-prefixed filename for the given suffix", () => {
    const files = ["2026-08-01-verify.md", "2026-09-05-verify.md", "2026-08-15-adversarial-review.md"];
    expect(latestReportFile(files, "verify")).toBe("2026-09-05-verify.md");
    expect(latestReportFile(files, "adversarial-review")).toBe("2026-08-15-adversarial-review.md");
  });

  it("returns null when no filename matches the suffix", () => {
    expect(latestReportFile(["2026-08-01-verify.md"], "adversarial-review")).toBeNull();
  });
});

describe("formatProgressLine", () => {
  it("shows a numeric task progress when known", () => {
    const summary = emptySummary({
      explore: { present: true },
      enrich: { present: true, status: "ready" },
      proposal: { present: true },
      design: { present: true },
      tasks: { present: true },
    });
    expect(formatProgressLine(summary, { completed: 3, total: 7 })).toBe(
      "explore ✓  enrich ✓ (ready)  proposal ✓  design ✓  tasks 3/7",
    );
  });

  it("falls back to a checkmark for tasks when progress is unknown", () => {
    const summary = emptySummary({ tasks: { present: true } });
    expect(formatProgressLine(summary, null)).toContain("tasks ✓");
  });
});

describe("deriveImplementationWorkflowStatus", () => {
  it("suggests /explore when nothing has been done yet", () => {
    const result = deriveImplementationWorkflowStatus(baseInput());
    expect(result.nextStep).toBe("/explore (or /propose if you already know what to build)");
    expect(result.attention).toEqual([]);
  });

  it("stops at the earliest stale planning stage rather than suggesting a later one", () => {
    const summary = emptySummary({
      explore: { present: true },
      enrich: { present: true },
      proposal: { present: true },
    });
    const result = deriveImplementationWorkflowStatus(
      baseInput({
        summary,
        provenance: [
          { stage: "explore", result: { status: "fresh", stamp: { commit: "a", fingerprint: "f1", recordedAt: "2026-09-01" } } },
          { stage: "enrich", result: { status: "stale", stamp: { commit: "a", fingerprint: "f1", recordedAt: "2026-09-01" }, currentFingerprint: "f2" } },
          { stage: "propose", result: { status: "fresh", stamp: { commit: "a", fingerprint: "f2", recordedAt: "2026-09-02" } } },
        ],
      }),
    );
    expect(result.nextStep).toBe("/enrich");
    expect(result.attention).toEqual([
      "/enrich's findings are stale (the repository changed since it last ran) -- rerun /enrich.",
    ]);
  });

  it("treats unknown provenance as invalid, exactly like stale", () => {
    const summary = emptySummary({ explore: { present: true } });
    const result = deriveImplementationWorkflowStatus(
      baseInput({ summary, provenance: [{ stage: "explore", result: { status: "unknown" } }] }),
    );
    expect(result.nextStep).toBe("/explore");
    expect(result.attention[0]).toMatch(/no recorded provenance/);
  });

  it("suggests /enrich once explore exists but enrich/proposal don't", () => {
    const summary = emptySummary({ explore: { present: true } });
    const result = deriveImplementationWorkflowStatus(baseInput({ summary }));
    expect(result.nextStep).toBe("/enrich");
  });

  it("suggests /propose once explore+enrich exist but proposal doesn't", () => {
    const summary = emptySummary({ explore: { present: true }, enrich: { present: true } });
    const result = deriveImplementationWorkflowStatus(baseInput({ summary }));
    expect(result.nextStep).toBe("/propose");
  });

  it("suggests /apply when a proposal exists and tasks are incomplete", () => {
    const summary = emptySummary({ proposal: { present: true }, design: { present: true }, tasks: { present: true } });
    const result = deriveImplementationWorkflowStatus(
      baseInput({ summary, taskProgress: { completed: 2, total: 5 } }),
    );
    expect(result.nextStep).toBe("/apply");
  });

  it("suggests /verify once all tasks are complete and no verify report exists yet", () => {
    const summary = emptySummary({ proposal: { present: true }, tasks: { present: true } });
    const result = deriveImplementationWorkflowStatus(
      baseInput({ summary, taskProgress: { completed: 5, total: 5 } }),
    );
    expect(result.nextStep).toBe("/verify");
  });

  it("flags a non-PASS verify verdict as attention and suggests fixing then re-verifying", () => {
    const summary = emptySummary({ proposal: { present: true }, tasks: { present: true } });
    const result = deriveImplementationWorkflowStatus(
      baseInput({
        summary,
        taskProgress: { completed: 5, total: 5 },
        verifyVerdict: "FAIL",
      }),
    );
    expect(result.nextStep).toBe("/apply (fix findings), then /verify");
    expect(result.attention[0]).toMatch(/last \/verify was FAIL/);
  });

  it("suggests /adversarial-review after a clean /verify PASS", () => {
    const summary = emptySummary({ proposal: { present: true }, tasks: { present: true } });
    const result = deriveImplementationWorkflowStatus(
      baseInput({ summary, taskProgress: { completed: 5, total: 5 }, verifyVerdict: "PASS" }),
    );
    expect(result.nextStep).toBe("/adversarial-review");
  });

  it("flags a non-PASS adversarial-review verdict and suggests fixing then re-verifying", () => {
    const summary = emptySummary({ proposal: { present: true }, tasks: { present: true } });
    const result = deriveImplementationWorkflowStatus(
      baseInput({
        summary,
        taskProgress: { completed: 5, total: 5 },
        verifyVerdict: "PASS",
        adversarialVerdict: "PASS WITH GAPS",
      }),
    );
    expect(result.nextStep).toBe("/apply (fix findings), then /verify");
    expect(result.attention[0]).toMatch(/last \/adversarial-review was PASS WITH GAPS/);
  });

  it("suggests /archive once both verify and adversarial-review are a clean PASS", () => {
    const summary = emptySummary({ proposal: { present: true }, tasks: { present: true } });
    const result = deriveImplementationWorkflowStatus(
      baseInput({
        summary,
        taskProgress: { completed: 5, total: 5 },
        verifyVerdict: "PASS",
        adversarialVerdict: "PASS",
      }),
    );
    expect(result.nextStep).toBe("/archive");
    expect(result.attention).toEqual([]);
  });

  it("always surfaces bootstrap-required as attention, regardless of stage", () => {
    const result = deriveImplementationWorkflowStatus(baseInput({ bootstrapRequired: true }));
    expect(result.attention).toContain("This repository needs local setup before /apply or /verify (see below).");
  });
});

describe("deriveReviewWorkflowStatus", () => {
  it("suggests /adversarial-review when no report exists yet", () => {
    const result = deriveReviewWorkflowStatus({ reviewVerdict: null });
    expect(result.nextStep).toBe("/adversarial-review");
    expect(result.summaryLine).toBe("not yet done");
    expect(result.attention).toEqual([]);
  });

  it("reports a clean PASS as complete, with nothing further to do", () => {
    const result = deriveReviewWorkflowStatus({ reviewVerdict: "PASS" });
    expect(result.nextStep).toBe("none -- review complete");
    expect(result.summaryLine).toBe("done -- verdict PASS");
    expect(result.attention).toEqual([]);
  });

  it("flags a non-PASS verdict as attention", () => {
    const result = deriveReviewWorkflowStatus({ reviewVerdict: "FAIL" });
    expect(result.summaryLine).toBe("done -- verdict FAIL");
    expect(result.attention[0]).toMatch(/verdict was FAIL/);
    expect(result.nextStep).toMatch(/re-run \/adversarial-review/);
  });
});
