import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THIRD_PARTY_NOTICES.md centralizes provenance for every adapted
 * template, since the executable templates themselves no longer carry
 * leading HTML history comments or trailing provenance essays (removed
 * to reduce token cost on every load).
 */
const noticesPath = join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "THIRD_PARTY_NOTICES.md",
);

describe("THIRD_PARTY_NOTICES.md", () => {
  it("exists at the repository root", async () => {
    await expect(readFile(noticesPath, "utf8")).resolves.toBeTypeOf("string");
  });

  it("has an entry for every adapted template file", async () => {
    const content = await readFile(noticesPath, "utf8");

    const expectedEntries = [
      "templates/commands/propose.md",
      "templates/commands/apply.md",
      "templates/commands/archive.md",
      "templates/skills/openspec-sync-specs/SKILL.md",
      "templates/commands/adversarial-review.md",
    ];

    for (const entry of expectedEntries) {
      expect(content).toContain(entry);
    }
  });

  it("has no entry for files confirmed as the author's own original work (verify.md, backend-developer.md, pipeline-data-engineer.md)", async () => {
    const content = await readFile(noticesPath, "utf8");

    const headings = content.match(/^## .+$/gm) ?? [];
    expect(headings).not.toContain("## templates/commands/verify.md");
    expect(headings).not.toContain("## templates/lenses/backend-developer.md");
    expect(headings).not.toContain("## templates/lenses/pipeline-data-engineer.md");
  });

  it("confirms MIT for the OpenSpec-derived entries", async () => {
    const content = await readFile(noticesPath, "utf8");

    const openSpecSection = content.split("## templates/commands/adversarial-review.md")[0];
    expect(openSpecSection).toMatch(/propose\.md[\s\S]*?License: MIT \(confirmed\)/);
    expect(openSpecSection).toMatch(/apply\.md[\s\S]*?License: MIT \(confirmed\)/);
    expect(openSpecSection).toMatch(/archive\.md[\s\S]*?License: MIT \(confirmed\)/);
    expect(openSpecSection).toMatch(/openspec-sync-specs[\s\S]*?License: MIT \(confirmed\)/);
  });

  it("never claims MAT as a copyright source anywhere, and records the provenance correction", async () => {
    const content = await readFile(noticesPath, "utf8");

    // No per-file entry may list MAT as an upstream project or source.
    const perFileSections = content.split(/^## /m).filter((section) => section.startsWith("templates/"));
    for (const section of perFileSections) {
      expect(section).not.toMatch(/Upstream project.*MAT/i);
      expect(section).not.toMatch(/market-audit-tool/i);
    }

    // The historical correction is recorded, explaining why.
    expect(content).toMatch(/## Provenance correction/);
    const correction = content.split("## Provenance correction")[1]?.split("---")[0] ?? "";
    expect(correction).toMatch(/MAT is not, and never was, a copyright source/i);
    expect(correction).toMatch(/no material from MAT\/SCV was ever copied/i);
    expect(correction).toMatch(
      /No file in this project currently requires permission or a clean-room\s*rewrite before publication\./,
    );
  });

  it("confirms MIT for lidr-specboot's (expanded) contribution to adversarial-review.md", async () => {
    const content = await readFile(noticesPath, "utf8");
    const section = content.split("## templates/commands/adversarial-review.md")[1] ?? "";

    expect(section).toMatch(/Upstream project: lidr-specboot \(public, MIT\)/);
    expect(section).toMatch(/License: MIT \(confirmed, Copyright \(c\) 2026 LIDR\.co\)/);
    // The expanded verbatim/near-verbatim content this entry now documents.
    expect(section).toMatch(/Act as an independent adversarial reviewer/);
    expect(section).toMatch(/PASS \(adversarial\)/);
    expect(section).toMatch(/Adversarial pass \(refute, do not rubber-stamp\)/);
  });
});
