import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { templatesRoot } from "../../src/core/templates.js";

/**
 * Cross-file drift detection for methodology that `/verify` and
 * `/adversarial-review` each restate independently rather than sharing
 * through any include/partial mechanism (there is none -- see backlog
 * item H2, deliberately out of scope here). This is a safety net only:
 * it does not refactor either template or introduce shared partials: it
 * only proves that the specific sub-blocks intended to be identical
 * have not silently diverged from each other.
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

  describe("Diff-scope algorithm (three-dot vs two-dot, explicit range, base-branch fallback)", () => {
    it("shares an identical diff-scope procedure through the base-branch fallback commands", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      const start = 'Determine the diff scope, entirely inside `$CE_WORKTREE`:';
      const end = 'git -C "$CE_WORKTREE" merge-base HEAD master  2>/dev/null\n```';

      const verifyBlock = extractSection(verify, "verify.md diff-scope procedure", start, end);
      const adversarialBlock = extractSection(
        adversarial,
        "adversarial-review.md diff-scope procedure",
        start,
        end,
      );

      expect(adversarialBlock).toBe(verifyBlock);
    });

    it("prefers CE_BASE_BRANCH (ce start's own detected base branch) over guessing main/master -- both files, not just kept in sync with each other", async () => {
      const verify = await readVerify();
      const adversarial = await readAdversarialReview();

      const start = 'Determine the diff scope, entirely inside `$CE_WORKTREE`:';
      const end = 'git -C "$CE_WORKTREE" merge-base HEAD master  2>/dev/null\n```';

      const verifyBlock = extractSection(verify, "verify.md diff-scope procedure", start, end);
      const adversarialBlock = extractSection(
        adversarial,
        "adversarial-review.md diff-scope procedure",
        start,
        end,
      );

      for (const [label, block] of [
        ["verify.md", verifyBlock],
        ["adversarial-review.md", adversarialBlock],
      ] as const) {
        expect(block, `${label} should try $CE_BASE_BRANCH before main/master`).toContain(
          'merge-base HEAD "$CE_BASE_BRANCH"',
        );
        expect(block, `${label} should also try the origin/ remote-tracking form`).toContain(
          'merge-base HEAD "origin/$CE_BASE_BRANCH"',
        );
        // The main/master guess must still be present, but only as the last resort.
        const baseBranchIdx = block.indexOf('merge-base HEAD "$CE_BASE_BRANCH"');
        const mainIdx = block.indexOf("merge-base HEAD main");
        expect(baseBranchIdx, `${label} is missing the $CE_BASE_BRANCH attempt`).toBeGreaterThan(-1);
        expect(mainIdx, `${label} is missing the main fallback`).toBeGreaterThan(-1);
        expect(baseBranchIdx, `${label} must try $CE_BASE_BRANCH before guessing main`).toBeLessThan(
          mainIdx,
        );
      }
    });

    // Deliberately NOT asserted identical: the paragraph immediately
    // following the merge-base commands ("If a merge base is found...
    // fall back to inspecting/reviewing HEAD...") already differs in
    // wording between the two files today (verify.md: "diff against
    // it... fall back to inspecting HEAD"; adversarial-review.md:
    // "review the full diff scope against it, not just the default file
    // ordering... fall back to reviewing HEAD"; verify.md also cites
    // "Gaps and Blockers" explicitly, adversarial-review.md does not).
    // This is a pre-existing wording variance, not documented anywhere
    // as an intentional difference -- it is excluded from the
    // byte-identical check here (rather than left to fail) because this
    // is a drift-detection safety net for the algorithm's substance, not
    // a byte-for-byte snapshot test; the variance is called out
    // explicitly so it isn't mistaken for coverage.
  });
});
