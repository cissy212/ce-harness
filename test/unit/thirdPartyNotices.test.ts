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
      "templates/commands/verify.md",
      "templates/commands/adversarial-review.md",
      "templates/lenses/backend-developer.md",
      "templates/lenses/pipeline-data-engineer.md",
    ];

    for (const entry of expectedEntries) {
      expect(content).toContain(entry);
    }
  });

  it("confirms MIT for the OpenSpec-derived entries", async () => {
    const content = await readFile(noticesPath, "utf8");

    const openSpecSection = content.split("## templates/commands/verify.md")[0];
    expect(openSpecSection).toMatch(/propose\.md[\s\S]*?License: MIT \(confirmed\)/);
    expect(openSpecSection).toMatch(/apply\.md[\s\S]*?License: MIT \(confirmed\)/);
    expect(openSpecSection).toMatch(/archive\.md[\s\S]*?License: MIT \(confirmed\)/);
    expect(openSpecSection).toMatch(/openspec-sync-specs[\s\S]*?License: MIT \(confirmed\)/);
  });

  it("never claims MAT content is redistributable, and marks it for human review", async () => {
    const content = await readFile(noticesPath, "utf8");

    // Every MAT-sourced per-file entry must carry the unresolved-license
    // label (excluding the "Publication review required" section itself,
    // which discusses MAT but is not a per-file entry).
    const matEntries = content
      .split(/^## /m)
      .filter((section) => section.startsWith("templates/") && /market-audit-tool/i.test(section));
    expect(matEntries.length).toBeGreaterThanOrEqual(4);
    for (const section of matEntries) {
      expect(section).toMatch(
        /Internal methodological reference -- redistribution permission not confirmed/,
      );
      expect(section).not.toMatch(/License: MIT/);
    }

    // Must not claim MIT (or any other open license) for MAT itself anywhere.
    expect(content).not.toMatch(/MAT[\s\S]{0,80}License: MIT/);
  });

  it("has a prominent 'Publication review required' section listing the affected files and remediation paths", async () => {
    const content = await readFile(noticesPath, "utf8");

    expect(content).toMatch(/## Publication review required/);
    const section = content.split("## Publication review required")[1]?.split("---")[0] ?? "";

    for (const file of [
      "templates/commands/verify.md",
      "templates/commands/adversarial-review.md",
      "templates/lenses/backend-developer.md",
      "templates/lenses/pipeline-data-engineer.md",
    ]) {
      expect(section).toContain(file);
    }

    expect(section).toMatch(/written permission/i);
    expect(section).toMatch(/clean-room rewrite/i);
    expect(section).toMatch(/not permission for public redistribution/i);
  });

  it("confirms MIT for lidr-specboot's contribution to adversarial-review.md, separately from MAT's", async () => {
    const content = await readFile(noticesPath, "utf8");
    const section = content.split("## templates/commands/adversarial-review.md")[1] ?? "";

    expect(section).toMatch(/lidr-specboot content -- MIT \(confirmed/);
    expect(section).toMatch(
      /MAT content -- \*\*Internal methodological reference -- redistribution permission not confirmed\.\*\*/,
    );
  });
});
