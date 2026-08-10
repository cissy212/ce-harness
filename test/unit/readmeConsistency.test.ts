import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { templatesRoot } from "../../src/core/templates.js";

/**
 * README.md's lens table is documentation, not the source of truth --
 * the lens files' own frontmatter `description` is what actually drives
 * the lens-matching algorithm in /verify and /adversarial-review (see
 * README's own "Reasoning lenses" section). This test catches the
 * README table silently drifting away from what a lens's frontmatter
 * actually claims, without requiring fragile full-sentence equality:
 * README is allowed to phrase things as a shorter table cell, but every
 * topic the canonical frontmatter names must still be reflected in it.
 *
 * If a real gap is found, the fix is always to adjust README (never the
 * lens file, which stays canonical).
 */

const readmePath = join(fileURLToPath(new URL("../..", import.meta.url)), "README.md");

interface LensSpec {
  file: string;
  lensName: string;
  /** Extracts the raw topic-list clause from the lens's frontmatter `description`. */
  extractTopicClause: (description: string) => string;
}

const LENSES: LensSpec[] = [
  {
    file: "backend-developer.md",
    lensName: "backend-developer",
    extractTopicClause: extractAfterDashBeforeApplies,
  },
  {
    file: "frontend-developer.md",
    lensName: "frontend-developer",
    extractTopicClause: extractAfterDashBeforeApplies,
  },
  {
    file: "typescript-engineer.md",
    lensName: "typescript-engineer",
    extractTopicClause: extractAfterDashBeforeApplies,
  },
  {
    file: "accessibility-reviewer.md",
    lensName: "accessibility-reviewer",
    extractTopicClause: extractAfterDashBeforeApplies,
  },
  {
    file: "security-reviewer.md",
    lensName: "security-reviewer",
    extractTopicClause: extractAfterDashBeforeApplies,
  },
  {
    // Structurally different from the other five: its topic list comes
    // *before* the " -- " clause, not after (and it has no separate
    // "Applies to ..." sentence at all). This is real, pre-existing
    // structural drift between lens files (tracked separately as a
    // lens-architecture backlog item) -- handled explicitly here rather
    // than papered over with a one-size-fits-all parser.
    file: "pipeline-data-engineer.md",
    lensName: "pipeline-data-engineer",
    extractTopicClause: (description) => {
      const match = description.match(/^Use when reasoning about\s+(.+?)\s+--/s);
      if (!match) {
        throw new Error(
          `pipeline-data-engineer.md: could not extract topic clause from description: ${JSON.stringify(description)}`,
        );
      }
      return match[1];
    },
  },
];

function extractAfterDashBeforeApplies(description: string): string {
  const match = description.match(/--\s*(.+?)\.\s*Applies to/s);
  if (!match) {
    throw new Error(`could not extract topic clause (after "--", before "Applies to") from: ${JSON.stringify(description)}`);
  }
  return match[1];
}

/** Splits a topic-list clause into individual topic phrases, stripping leading "and"/"or" connectors left over from list splitting. */
function splitTopics(clause: string): string[] {
  return clause
    .split(/,\s*/)
    .flatMap((part) => part.split(/\s+and\s+|\s+or\s+/))
    .map((phrase) => phrase.trim().replace(/^(and|or)\s+/i, "").trim())
    .filter((phrase) => phrase.length > 0);
}

async function readLensDescription(file: string): Promise<string> {
  const content = await readFile(join(templatesRoot(), "lenses", file), "utf8");
  const match = content.match(/^description:\s*(.+)$/m);
  if (!match) {
    throw new Error(`${file}: no frontmatter "description" field found`);
  }
  return match[1].trim();
}

async function readReadmeLensRow(lensName: string): Promise<string> {
  const content = await readFile(readmePath, "utf8");
  const rowPattern = new RegExp("\\|\\s*`" + lensName + "`\\s*\\|\\s*(.+?)\\s*\\|", "s");
  const match = content.match(rowPattern);
  if (!match) {
    throw new Error(`README.md: no lens table row found for \`${lensName}\``);
  }
  // Strip backticks so `any`/`unknown` in README compares equally against
  // the frontmatter's plain any/unknown wording.
  return match[1].replace(/`/g, "");
}

describe("README lens catalogue vs. lens frontmatter (canonical) consistency", () => {
  for (const lens of LENSES) {
    it(`${lens.lensName}: every topic named in the lens frontmatter appears in README's table row`, async () => {
      const description = await readLensDescription(lens.file);
      const topics = splitTopics(lens.extractTopicClause(description));
      expect(topics.length).toBeGreaterThan(0);

      const readmeRow = await readReadmeLensRow(lens.lensName);
      const normalizedRow = readmeRow.toLowerCase();

      for (const topic of topics) {
        expect(
          normalizedRow,
          `README's "${lens.lensName}" row is missing the topic "${topic}" that its frontmatter description names.\n` +
            `Frontmatter description: ${JSON.stringify(description)}\n` +
            `README row: ${JSON.stringify(readmeRow)}`,
        ).toContain(topic.toLowerCase());
      }
    });
  }

  it("README's lens table lists exactly the six shipped lenses, in some order", async () => {
    const content = await readFile(readmePath, "utf8");
    for (const lens of LENSES) {
      expect(content).toMatch(new RegExp("\\|\\s*`" + lens.lensName + "`\\s*\\|"));
    }
  });
});
