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
