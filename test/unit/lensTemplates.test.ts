import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { templatesRoot } from "../../src/core/templates.js";

/**
 * Content checks on the lens template files themselves
 * (templates/lenses/*.md) -- these are ce-harness reasoning lenses
 * (portable reasoning documents), not OpenCode skills, not Claude
 * agents, not Cursor rules. They must carry no runner-specific metadata.
 */
describe("lens templates (templates/lenses/*.md)", () => {
  const lensFiles = [
    "backend-developer.md",
    "pipeline-data-engineer.md",
    "frontend-developer.md",
    "accessibility-reviewer.md",
    "typescript-engineer.md",
    "security-reviewer.md",
  ];

  it("templates/lenses/ contains exactly the six shipped lenses", async () => {
    const entries = await readdir(join(templatesRoot(), "lenses"));
    expect(entries.sort()).toEqual([...lensFiles].sort());
  });

  for (const filename of lensFiles) {
    describe(filename, () => {
      it("has YAML frontmatter with name and description", async () => {
        const content = await readFile(join(templatesRoot(), "lenses", filename), "utf8");
        expect(content.startsWith("---\n")).toBe(true);

        const frontmatterEnd = content.indexOf("\n---", 4);
        expect(frontmatterEnd).toBeGreaterThan(-1);
        const frontmatter = content.slice(0, frontmatterEnd);

        expect(frontmatter).toMatch(/^name:\s*\S+/m);
        expect(frontmatter).toMatch(/^description:\s*.+/m);
      });

      it('description begins with "Use when..." for future automatic matching by any runner', async () => {
        const content = await readFile(join(templatesRoot(), "lenses", filename), "utf8");
        const match = content.match(/^description:\s*(.+)$/m);
        expect(match).not.toBeNull();
        expect(match![1]).toMatch(/^Use when\b/);
      });

      it("carries no runner-specific metadata (tools/model/color/allowed-tools)", async () => {
        const content = await readFile(join(templatesRoot(), "lenses", filename), "utf8");
        const frontmatterEnd = content.indexOf("\n---", 4);
        const frontmatter = content.slice(0, frontmatterEnd);

        expect(frontmatter).not.toMatch(/^tools:/m);
        expect(frontmatter).not.toMatch(/^allowed-tools:/m);
        expect(frontmatter).not.toMatch(/^model:/m);
        expect(frontmatter).not.toMatch(/^color:/m);
      });

      it("does not assume a specific framework, ORM, or architecture as a default", async () => {
        const content = (await readFile(join(templatesRoot(), "lenses", filename), "utf8")).toLowerCase();

        // These may appear only as illustrative "these are tools, not
        // defaults" examples -- never as an assumed/required dependency.
        expect(content).not.toMatch(/\bmust use (express|prisma|ddd|cqrs)\b/);
        expect(content).not.toMatch(/\brequires? (express|prisma)\b/);
      });

      it("ends with a 'Lens checks' summary for report auditability", async () => {
        const content = await readFile(join(templatesRoot(), "lenses", filename), "utf8");
        expect(content).toMatch(/## Lens checks/);
      });

      it("frames itself as a reasoning lens loaded as context, never a subagent", async () => {
        const content = await readFile(join(templatesRoot(), "lenses", filename), "utf8");
        const normalized = content.replace(/\s+/g, " ");
        expect(normalized).toMatch(/reasoning lens loaded into the current review session as/i);
        expect(normalized).toMatch(/not a separate agent/i);
        expect(normalized).toMatch(/never implements, edits, or runs anything/i);
      });

      it('does not use "specialist" for itself', async () => {
        const content = await readFile(join(templatesRoot(), "lenses", filename), "utf8");
        expect(content).not.toMatch(/specialist/i);
      });
    });
  }

  it("backend-developer preserves read-before-reasoning, scope/risk classification, and abstraction discipline", async () => {
    const content = await readFile(join(templatesRoot(), "lenses", "backend-developer.md"), "utf8");

    expect(content).toMatch(/Read before reasoning/i);
    expect(content).toMatch(/### Scope/);
    expect(content).toMatch(/### Risk/);
    expect(content).toMatch(/Incremental/);
    expect(content).toMatch(/Structural/);
    expect(content).toMatch(/Architectural refactor/);
    expect(content).toMatch(/earn it before introducing it/i);
    expect(content).toMatch(/Dependency management at the right seam/i);
    expect(content).toMatch(/Type stability at module boundaries/i);
    expect(content).toMatch(/Testability as a design signal/i);
    expect(content).toMatch(/composite index/i);
    expect(content).toMatch(/[Tt]ransaction boundar/);
  });

  it("pipeline-data-engineer preserves idempotency, concurrency, checkpointing, and observability", async () => {
    const content = await readFile(
      join(templatesRoot(), "lenses", "pipeline-data-engineer.md"),
      "utf8",
    );

    expect(content).toMatch(/[Ii]dempoten/);
    expect(content).toMatch(/[Ww]ork.selection/i);
    expect(content).toMatch(/retr(y|ies)/i);
    expect(content).toMatch(/[Cc]heckpoint/);
    expect(content).toMatch(/[Cc]oncurrency/);
    expect(content).toMatch(/[Pp]artial failure/);
    expect(content).toMatch(/[Rr]esum(e|ability)/);
    expect(content).toMatch(/[Oo]bservability/);
    expect(content).toMatch(/[Pp]rovenance/);
    expect(content).toMatch(/rate limit/i);
  });

  it("frontend-developer preserves state locality, rendering-cost reasoning, and async-boundary completeness", async () => {
    const content = await readFile(join(templatesRoot(), "lenses", "frontend-developer.md"), "utf8");

    expect(content).toMatch(/State locality/i);
    expect(content).toMatch(/Rendering cost is a design signal/i);
    expect(content).toMatch(/Every async boundary needs all three states/i);
    expect(content).toMatch(/[Ss]tale closures/);
    expect(content).toMatch(/[Rr]ace conditions? in data fetching/);
    expect(content).toMatch(/[Ll]ist identity/i);
    expect(content).toMatch(/[Uu]ncancelled subscriptions/);
  });

  it("accessibility-reviewer preserves native-first reasoning, the ARIA behavioral contract, and WCAG-cited findings", async () => {
    const content = await readFile(
      join(templatesRoot(), "lenses", "accessibility-reviewer.md"),
      "utf8",
    );

    expect(content).toMatch(/Native-first/i);
    expect(content).toMatch(/ARIA is a promise/i);
    expect(content).toMatch(/accessibility tree/i);
    expect(content).toMatch(/Operability without a pointer/i);
    expect(content).toMatch(/Focus is state/i);
    expect(content).toMatch(/WCAG \d\.\d\.\d/);
    expect(content).toMatch(/relative-luminance/i);
  });

  it("typescript-engineer preserves soundness, exhaustiveness, variance, and trust-boundary typing", async () => {
    const content = await readFile(join(templatesRoot(), "lenses", "typescript-engineer.md"), "utf8");

    expect(content).toMatch(/Soundness over convenience/i);
    expect(content).toMatch(/[Nn]arrowing must be exhaustive/);
    expect(content).toMatch(/`any` disables checking/i);
    expect(content).toMatch(/[Vv]ariance and mutability/);
    expect(content).toMatch(/[Ss]tructural typing means shape/i);
    expect(content).toMatch(/noUncheckedIndexedAccess/);
    expect(content).toMatch(/exactOptionalPropertyTypes/);
  });

  it("security-reviewer preserves trust-boundary reasoning, injection/IDOR/SSRF patterns, and a no-live-exploitation guardrail", async () => {
    const content = await readFile(join(templatesRoot(), "lenses", "security-reviewer.md"), "utf8");

    expect(content).toMatch(/Trust boundaries are the unit of analysis/i);
    expect(content).toMatch(/Validate at the boundary, not by convention/i);
    expect(content).toMatch(/Authorization is an explicit check/i);
    expect(content).toMatch(/Least privilege/i);
    expect(content).toMatch(/\bIDOR\b/);
    expect(content).toMatch(/\bSSRF\b/);
    expect(content).toMatch(/never (attempt to actually exploit|run(s)? a scanner)/i);
  });

  it("every lens follows the established Phase 0-4 structure", async () => {
    for (const filename of lensFiles) {
      const content = await readFile(join(templatesRoot(), "lenses", filename), "utf8");
      expect(content).toMatch(/## Phase 0 --/);
      expect(content).toMatch(/## Phase 1 --/);
      expect(content).toMatch(/## Phase 2 --/);
      expect(content).toMatch(/## Phase 3 --/);
      expect(content).toMatch(/## Phase 4 --/);
      expect(content).toMatch(/## Lens checks/);
    }
  });

  it("each new lens explicitly names at least one other lens to define an ownership boundary, rather than duplicating its guidance", async () => {
    const newLensFiles = [
      "frontend-developer.md",
      "accessibility-reviewer.md",
      "typescript-engineer.md",
      "security-reviewer.md",
    ];
    const lensNames = [
      "backend-developer",
      "pipeline-data-engineer",
      "frontend-developer",
      "accessibility-reviewer",
      "typescript-engineer",
      "security-reviewer",
    ];

    for (const filename of newLensFiles) {
      const content = await readFile(join(templatesRoot(), "lenses", filename), "utf8");
      const selfName = filename.replace(/\.md$/, "");
      const mentionsAnotherLens = lensNames.some(
        (name) => name !== selfName && content.includes(name),
      );
      expect(mentionsAnotherLens).toBe(true);
    }
  });

  it("has no MAT-specific paths or examples", async () => {
    for (const filename of lensFiles) {
      const content = await readFile(join(templatesRoot(), "lenses", filename), "utf8");
      expect(content).not.toMatch(/market-audit-tool/i);
      expect(content).not.toMatch(/PIPELINE\.md/);
      expect(content).not.toMatch(/PIPELINE_DATA_DEPENDENCIES/);
      expect(content).not.toMatch(/score-company-signals/);
      expect(content).not.toMatch(/Apollo/);
      expect(content).not.toMatch(/enrich-companies/);
    }
  });
});
