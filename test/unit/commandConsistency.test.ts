import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { templatesRoot } from "../../src/core/templates.js";

/**
 * Cross-file drift detection for methodology that `/verify` and
 * `/adversarial-review` each restate independently rather than sharing
 * through any include/partial mechanism (there is none for prose -- this
 * is a safety net only, not a refactor into shared partials). The
 * diff-scope algorithm itself no longer falls into this category: it was
 * extracted into `src/core/diffScope.ts` (invoked by both templates via
 * `ce diff-scope`), formerly backlog item H2, so that sub-block is a
 * single implementation now rather than duplicated prose -- see the
 * "Diff-scope resolution" describe block below for what's still worth
 * pinning about it. The lens-selection algorithm remains prose restated
 * in both files, and is what the checks below still guard.
 *
 * Sections are extracted by stable anchor text (never brittle whole-file
 * or line-number snapshots), so reformatting elsewhere in either file
 * cannot break these checks. Each extraction throws a specific, clear
 * error if its anchors are not found -- e.g. because a step was renamed
 * or reworded -- rather than silently comparing empty strings.
 */

async function readVerify(): Promise<string> {
  return readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
}

async function readAdversarialReview(): Promise<string> {
  return readFile(join(templatesRoot(), "commands", "adversarial-review.md"), "utf8");
}

async function readArchive(): Promise<string> {
  return readFile(join(templatesRoot(), "commands", "archive.md"), "utf8");
}

async function readEnrich(): Promise<string> {
  return readFile(join(templatesRoot(), "commands", "enrich.md"), "utf8");
}

/**
 * Strips each line's leading whitespace. Used only for the Knowledge check
 * reasoning core below: `archive.md` embeds it as a numbered step's
 * indented body while `adversarial-review.md` embeds it as an unindented
 * top-level section, so the two are identical prose at a different nesting
 * depth -- not drift. Every other pinned block in this file is compared
 * without this normalization, since both sides share the same nesting
 * there.
 */
function dedent(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, ""))
    .join("\n");
}

/** Extracts the substring from `startMarker` through the end of `endMarker`, inclusive. */
function extractSection(content: string, label: string, startMarker: string, endMarker: string): string {
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`${label}: could not find start marker ${JSON.stringify(startMarker)}`);
  }
  const endIdx = content.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) {
    throw new Error(`${label}: could not find end marker ${JSON.stringify(endMarker)}`);
  }
  return content.slice(startIdx, endIdx + endMarker.length);
}

describe("Cross-file methodology consistency (/verify vs /adversarial-review)", () => {
  describe("Lens-selection algorithm", () => {
    it("shares an identical lens-ownership statement", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      const start = "ce-harness -- not the runner -- owns lens selection.";
      const end = "such as `opencode/agents/`.";

      const verifyBlock = extractSection(verify, "verify.md ownership statement", start, end);
      const adversarialBlock = extractSection(
        adversarial,
        "adversarial-review.md ownership statement",
        start,
        end,
      );

      expect(adversarialBlock).toBe(verifyBlock);
    });

    it("shares identical steps 1-2 (skip-if-empty; list and read descriptions)", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      const start = "1. If `CE_LENSES_DIR` is unset";
      const end = "frontmatter field.";

      const verifyBlock = extractSection(verify, "verify.md steps 1-2", start, end);
      const adversarialBlock = extractSection(adversarial, "adversarial-review.md steps 1-2", start, end);

      expect(adversarialBlock).toBe(verifyBlock);
    });

    it("shares an identical operational-vs-structural tie-break rule (step 4)", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      const start = "4. If both an operational/runtime concern";
      const end = "and be selected overall.";

      const verifyBlock = extractSection(verify, "verify.md tie-break rule", start, end);
      const adversarialBlock = extractSection(adversarial, "adversarial-review.md tie-break rule", start, end);

      expect(adversarialBlock).toBe(verifyBlock);
    });

    it("shares identical steps 5-8 (single match / no match / multi-match ask / explicit override)", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      const start = "5. If exactly one lens clearly matches";
      const end = "use it instead of steps 2-7.";

      const verifyBlock = extractSection(verify, "verify.md steps 5-8", start, end);
      const adversarialBlock = extractSection(adversarial, "adversarial-review.md steps 5-8", start, end);

      expect(adversarialBlock).toBe(verifyBlock);
    });

    // Deliberately NOT asserted identical (documented, intentional
    // differences -- see the file-level doc comment above and the task
    // report that introduced this test):
    // - adversarial-review.md's extra opening "A lens is an additional
    //   reasoning layer..." paragraph, absent from verify.md.
    // - The "Lenses are additive..." framing paragraph: present in both,
    //   but worded differently (adversarial-review's version references
    //   its own Step 6 baseline pass, which has no verify.md equivalent).
    // - Step 3 ("Compare each description against..."): worded
    //   differently, since adversarial-review compares against a
    //   dual-workspace-type baseline (Step 3) that verify.md doesn't have.
    // - The "If one or more lenses are selected, load each one's
    //   file..." trailing paragraph: worded differently (different
    //   session-vs-review framing, and adversarial-review adds an
    //   example sentence about layering on top of its Step 6 baseline).
    // - "Record the outcome...": 3-part in verify.md, 4-part in
    //   adversarial-review.md (which also records what each lens added
    //   beyond its Step 6 baseline -- a concept verify.md has no
    //   equivalent of).
  });

  describe("External Agent Skill lenses", () => {
    it("both templates widen lens discovery to include an immediate subdirectory's own SKILL.md", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      for (const [label, content] of [
        ["verify.md", verify],
        ["adversarial-review.md", adversarial],
      ] as const) {
        expect(content, `${label} discovery step`).toMatch(
          /every immediate subdirectory's own\s*`SKILL\.md`/,
        );
        expect(content, `${label} skip condition`).toMatch(
          /nor any immediate subdirectory's own\s*`SKILL\.md`/,
        );
      }
    });

    it("both templates instruct applying an external Agent Skill lens for identification only, never as license to edit or fix", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      for (const [label, content] of [
        ["verify.md", verify],
        ["adversarial-review.md", adversarial],
      ] as const) {
        expect(content, `${label} external-skill clause`).toMatch(
          /When a loaded lens is an external Agent Skill/,
        );
        expect(content, `${label} identification-only instruction`).toMatch(
          /apply its guidance for\s*identification only/,
        );
        expect(content, `${label} never-edit guardrail`).toMatch(
          /never as\s*license to edit, fix, or otherwise modify anything/,
        );
      }
    });

    it("both templates' Lens Coverage table falls back to a lens's own description when it has no '## Lens checks' section", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      for (const [label, content] of [
        ["verify.md", verify],
        ["adversarial-review.md", adversarial],
      ] as const) {
        expect(content, `${label} Lens Coverage fallback`).toMatch(
          /when the lens has no such section, as with an external Agent Skill/,
        );
      }
    });
  });

  describe("Diff-scope resolution (both commands delegate to `ce diff-scope`)", () => {
    // The merge-base/base-branch-fallback algorithm itself no longer lives
    // here as prose kept in sync by this test -- it is a single
    // implementation in src/core/diffScope.ts, exercised directly (against
    // real Git repositories) by test/unit/diffScopeResolution.test.ts.
    // What remains worth pinning here is that both templates actually
    // delegate to it, identically, instead of one silently reverting to
    // restating the algorithm inline.

    it("both templates invoke `ce diff-scope` instead of restating the algorithm inline", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      for (const [label, content] of [
        ["verify.md", verify],
        ["adversarial-review.md", adversarial],
      ] as const) {
        expect(content, `${label} should call \`ce diff-scope\``).toContain("ce diff-scope");
        // The old inline algorithm must not have crept back in.
        expect(content, `${label} must not restate the merge-base fallback inline`).not.toMatch(
          /LOCAL_MB=|ORIGIN_MB=|BASE_MB=/,
        );
      }
    });

    it("shares an identical explanation of the algorithm and identical explicit/merge-base mode handling", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      const start = "Resolve the diff range to review.";
      const end =
        'Use `diffRange`\n  (three-dot) for the diff and `logRange` (two-dot) for the commit log:\n  ```bash\n  git -C "$CE_WORKTREE" log --oneline "<logRange>"\n  git -C "$CE_WORKTREE" diff "<diffRange>"\n  ```\n- `"mode": "merge-base"` -- a base was found (`base`, resolved from\n  `baseSource`).';

      const verifyBlock = extractSection(verify, "verify.md diff-scope pointer", start, end);
      const adversarialBlock = extractSection(
        adversarial,
        "adversarial-review.md diff-scope pointer",
        start,
        end,
      );

      expect(adversarialBlock).toBe(verifyBlock);
    });

    // Deliberately NOT asserted identical: the "no-base" bullet's trailing
    // clause, since it names each report's own, differently-shaped
    // structure (verify.md: a "Gaps and Blockers" section; adversarial-review.md:
    // a "**Scope limitations:**" field) -- a genuine, documented difference,
    // not drift.
  });
});

describe("Cross-file methodology consistency (/archive vs /adversarial-review)", () => {
  describe("Knowledge check reasoning core", () => {
    it("shares an identical reasoning core (the question, and the yes/no/scan/branch logic), modulo nesting-depth indentation", async () => {
      const archive = await readArchive();
      const adversarial = await readAdversarialReview();

      const start = "**Ask: did this produce reusable project knowledge that is not";
      const end = "for the human to act on later.";

      const archiveBlock = extractSection(archive, "archive.md Knowledge check reasoning core", start, end);
      const adversarialBlock = extractSection(
        adversarial,
        "adversarial-review.md Knowledge check reasoning core",
        start,
        end,
      );

      expect(dedent(adversarialBlock)).toBe(dedent(archiveBlock));
    });

    // Deliberately NOT asserted identical, and NOT part of the pinned
    // block above: each caller's setup (what it gathers -- archive.md reads
    // proposal/design/enrich/tasks and every report; adversarial-review.md
    // reads the PR description, repo conventions, and its own findings) and
    // each caller's handling of the outcome (archive.md may pause for the
    // human to incorporate a small find before archiving; adversarial-review.md
    // only ever surfaces text, never pauses, never writes) -- these differ
    // by design (caller-specific setup/handling around a shared reasoning
    // core), not by drift.
  });

  describe("Project-local learned knowledge (knowledge.md) eligibility rule and write mechanics", () => {
    it("shares an identical eligibility rule and read-before-append/update mechanic, byte-for-byte", async () => {
      const enrich = await readEnrich();
      const adversarial = await readAdversarialReview();

      const start = "**Ask, of the specific conclusion you just reached, all five:**";
      const end = 'this command")\n```';

      const enrichBlock = extractSection(enrich, "enrich.md knowledge.md eligibility rule", start, end);
      const adversarialBlock = extractSection(
        adversarial,
        "adversarial-review.md knowledge.md eligibility rule",
        start,
        end,
      );

      expect(adversarialBlock).toBe(enrichBlock);
    });

    // Deliberately NOT asserted identical: each caller's own trigger
    // sentence just above the pinned block (enrich.md: "step 6's analysis
    // or step 7's resolution of a blocking item"; adversarial-review.md:
    // "a finding was just classified RESOLVED or NO LONGER APPLICABLE"),
    // and each caller's closing sentence just below it, pointing at that
    // command's own non-knowledge.md home for speculative content
    // (enrich.md: Open Questions/Assumptions; adversarial-review.md:
    // Findings tables/Open Questions) -- both genuinely differ by which
    // command is writing, not by drift.
  });
});
