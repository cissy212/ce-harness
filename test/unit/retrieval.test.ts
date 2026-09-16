import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retrieveCandidates } from "../../src/core/retrieval.js";

/** Writes `content` to `relPath` under `root`, creating parent directories as needed. */
async function writeFixtureFile(root: string, relPath: string, content: string): Promise<void> {
  const full = join(root, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function writeCurrentSpec(durableRoot: string, capability: string, content: string): Promise<void> {
  await writeFixtureFile(durableRoot, `openspec/specs/${capability}/spec.md`, content);
}

async function writeArchivedChangeFile(
  durableRoot: string,
  archiveDirName: string,
  relToChange: string,
  content: string,
): Promise<void> {
  await writeFixtureFile(durableRoot, `openspec/changes/archive/${archiveDirName}/${relToChange}`, content);
}

async function writeReviewReportFile(durableRoot: string, filename: string, content: string): Promise<void> {
  await writeFixtureFile(durableRoot, `reviews/${filename}`, content);
}

async function writeKnowledgeFile(durableRoot: string, content: string): Promise<void> {
  await writeFixtureFile(durableRoot, "knowledge.md", content);
}

describe("retrieveCandidates", () => {
  let durableRoot: string;

  beforeEach(async () => {
    durableRoot = await mkdtemp(join(tmpdir(), "ce-harness-retrieval-"));
  });

  afterEach(async () => {
    await rm(durableRoot, { recursive: true, force: true });
  });

  it("returns an empty result with a warning when the query has no usable signals", async () => {
    const result = await retrieveCandidates({ durableRoot });
    expect(result.candidates).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/no search signals/i);
  });

  it("warns (but doesn't throw) when the durable store doesn't exist yet", async () => {
    const missingRoot = join(durableRoot, "does-not-exist");
    const result = await retrieveCandidates({ durableRoot: missingRoot, keywords: ["auth"] });
    expect(result.candidates).toEqual([]);
    expect(result.warnings.some((w) => w.includes(missingRoot))).toBe(true);
  });

  describe("current specs", () => {
    it("matches a current spec by keyword and tags it 'current'", async () => {
      await writeCurrentSpec(durableRoot, "authentication", "# Authentication\n\nHandles login tokens.\n");

      const result = await retrieveCandidates({ durableRoot, keywords: ["tokens"] });
      expect(result.candidates.length).toBe(1);
      const [candidate] = result.candidates;
      expect(candidate.type).toBe("spec");
      expect(candidate.status).toBe("current");
      expect(candidate.path).toBe(join("openspec", "specs", "authentication", "spec.md"));
      expect(candidate.matchedSignals).toEqual([{ kind: "keyword", detail: "tokens" }]);
      expect(candidate.excerpt).toMatch(/tokens/i);
    });

    it("matches a current spec by domain/capability name", async () => {
      await writeCurrentSpec(durableRoot, "billing", "# Billing\n\nInvoices and refunds.\n");
      await writeCurrentSpec(durableRoot, "authentication", "# Authentication\n\nLogin.\n");

      const result = await retrieveCandidates({ durableRoot, domain: "billing" });
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].path).toContain("billing");
      expect(result.candidates[0].matchedSignals.some((s) => s.kind === "domain")).toBe(true);
    });

    it("does not return a spec with no matching signal", async () => {
      await writeCurrentSpec(durableRoot, "billing", "# Billing\n\nInvoices and refunds.\n");
      const result = await retrieveCandidates({ durableRoot, keywords: ["completely-unrelated-term"] });
      expect(result.candidates).toEqual([]);
    });
  });

  describe("archived changes", () => {
    it("classifies proposal/design/tasks/report/delta-spec artifacts and tags them 'historical'", async () => {
      const archiveDir = "2026-05-12-add-user-auth";
      await writeArchivedChangeFile(durableRoot, archiveDir, "proposal.md", "Add user authentication via tokens.\n");
      await writeArchivedChangeFile(durableRoot, archiveDir, "design.md", "Token design notes.\n");
      await writeArchivedChangeFile(durableRoot, archiveDir, "tasks.md", "- [x] implement tokens\n");
      await writeArchivedChangeFile(
        durableRoot,
        archiveDir,
        "reports/2026-05-13-adversarial-review.md",
        "Reviewed token handling for race conditions.\n",
      );
      await writeArchivedChangeFile(
        durableRoot,
        archiveDir,
        "specs/authentication/spec.md",
        "Delta spec: tokens must expire.\n",
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["token"], limit: 20 });
      const types = result.candidates.map((c) => c.type).sort();
      expect(types).toEqual(
        ["change-delta-spec", "change-design", "change-proposal", "change-report", "change-tasks"].sort(),
      );
      expect(result.candidates.every((c) => c.status === "historical")).toBe(true);
    });

    it("dates a report artifact from its own filename, not just the archive directory's date", async () => {
      const archiveDir = "2026-05-12-add-user-auth";
      await writeArchivedChangeFile(
        durableRoot,
        archiveDir,
        "reports/2026-05-20-verify.md",
        "Verified token expiry.\n",
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["token"] });
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].date).toBe("2026-05-20T00:00:00.000Z");
    });

    it("falls back to the archive directory's date when an artifact has no date of its own", async () => {
      const archiveDir = "2026-05-12-add-user-auth";
      await writeArchivedChangeFile(durableRoot, archiveDir, "proposal.md", "Token proposal.\n");

      const result = await retrieveCandidates({ durableRoot, keywords: ["token"] });
      expect(result.candidates[0].date).toBe("2026-05-12T00:00:00.000Z");
    });

    it("never scans a change directory that has not been archived yet", async () => {
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/in-progress-change/proposal.md",
        "Token proposal, still in progress.\n",
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["token"] });
      expect(result.candidates).toEqual([]);
    });

    it("classifies an archived enrich.md as change-enrich, historical", async () => {
      await writeArchivedChangeFile(
        durableRoot,
        "2026-05-12-add-user-auth",
        "enrich.md",
        "Clarified intent: tokens must expire after 24h.\n",
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["token"] });
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].type).toBe("change-enrich");
      expect(result.candidates[0].status).toBe("historical");
    });

    it("matches an archived change via its slug even when the slug text never appears verbatim in the artifact body", async () => {
      await writeArchivedChangeFile(
        durableRoot,
        "2026-01-01-billing-refunds-fix",
        "proposal.md",
        "Fixes an edge case in the refund flow.\n",
      );

      const result = await retrieveCandidates({ durableRoot, domain: "billing" });
      expect(result.candidates.length).toBe(1);
    });
  });

  describe("review reports (Existing PR review workspace)", () => {
    it("matches a review report by keyword and tags it 'review-report', 'historical'", async () => {
      await writeReviewReportFile(
        durableRoot,
        "2026-06-01-pr-42-adversarial-review.md",
        "Reviewed the refund token flow for double-submit races.\n",
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["refund"] });
      expect(result.candidates.length).toBe(1);
      const [candidate] = result.candidates;
      expect(candidate.type).toBe("review-report");
      expect(candidate.status).toBe("historical");
      expect(candidate.path).toBe(join("reviews", "2026-06-01-pr-42-adversarial-review.md"));
    });

    it("dates a review report from its own filename", async () => {
      await writeReviewReportFile(
        durableRoot,
        "2026-06-01-pr-42-adversarial-review.md",
        "Reviewed the refund token flow.\n",
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["refund"] });
      expect(result.candidates[0].date).toBe("2026-06-01T00:00:00.000Z");
    });

    it("matches both PR-scoped and legacy unscoped review report filenames", async () => {
      await writeReviewReportFile(
        durableRoot,
        "2026-06-01-pr-42-adversarial-review.md",
        "Reviewed the refund token flow.\n",
      );
      await writeReviewReportFile(
        durableRoot,
        "2026-06-02-adversarial-review.md",
        "Reviewed another refund token change.\n",
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["refund"], limit: 20 });
      expect(result.candidates.length).toBe(2);
      expect(result.candidates.every((c) => c.type === "review-report")).toBe(true);
    });

    it("does not return a review report with no matching signal", async () => {
      await writeReviewReportFile(
        durableRoot,
        "2026-06-01-pr-42-adversarial-review.md",
        "Reviewed the refund token flow.\n",
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["completely-unrelated-term"] });
      expect(result.candidates).toEqual([]);
    });

    it("is excluded when 'reviewReports' is not in the requested sources", async () => {
      await writeReviewReportFile(
        durableRoot,
        "2026-06-01-pr-42-adversarial-review.md",
        "Reviewed the refund token flow.\n",
      );

      const result = await retrieveCandidates({
        durableRoot,
        keywords: ["refund"],
        sources: ["specs", "archivedChanges", "gitHistory"],
      });
      expect(result.candidates).toEqual([]);
    });
  });

  describe("project-local learned knowledge (knowledge.md)", () => {
    it("matches a knowledge entry by keyword and tags it 'project-knowledge', 'historical'", async () => {
      await writeKnowledgeFile(
        durableRoot,
        [
          "## 2026-06-01 -- Refund tokens are single-use",
          "",
          "**Evidence:** `src/core/refund.ts:42` and `test/refund.test.ts:88` show the token is invalidated immediately after redemption.",
          "**Source:** reports/2026-06-01-adversarial-review.md",
          "",
        ].join("\n"),
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["refund"] });
      expect(result.candidates.length).toBe(1);
      const [candidate] = result.candidates;
      expect(candidate.type).toBe("project-knowledge");
      expect(candidate.status).toBe("historical");
      expect(candidate.path).toBe("knowledge.md");
      expect(candidate.date).toBe("2026-06-01T00:00:00.000Z");
    });

    it("returns one candidate per entry, not one per file, as the file grows", async () => {
      await writeKnowledgeFile(
        durableRoot,
        [
          "## 2026-06-01 -- Refund tokens are single-use",
          "",
          "**Evidence:** src/core/refund.ts:42 demonstrates this.",
          "**Source:** reports/2026-06-01-adversarial-review.md",
          "",
          "## 2026-06-02 -- Billing webhooks retry with exponential backoff",
          "",
          "**Evidence:** src/core/webhooks.ts:10 demonstrates this.",
          "**Source:** reports/2026-06-02-verify.md",
          "",
        ].join("\n"),
      );

      const refundResult = await retrieveCandidates({ durableRoot, keywords: ["refund"] });
      expect(refundResult.candidates.length).toBe(1);
      expect(refundResult.candidates[0].date).toBe("2026-06-01T00:00:00.000Z");

      const webhookResult = await retrieveCandidates({ durableRoot, keywords: ["webhooks"] });
      expect(webhookResult.candidates.length).toBe(1);
      expect(webhookResult.candidates[0].date).toBe("2026-06-02T00:00:00.000Z");
    });

    it("bounds the excerpt to the matching entry, never bleeding in an unrelated entry's text", async () => {
      await writeKnowledgeFile(
        durableRoot,
        [
          "## 2026-06-01 -- Refund tokens are single-use",
          "",
          "**Evidence:** src/core/refund.ts:42 demonstrates this.",
          "",
          "## 2026-06-02 -- Billing webhooks retry with exponential backoff",
          "",
          "**Evidence:** src/core/webhooks.ts:10 demonstrates this.",
          "",
        ].join("\n"),
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["webhooks"] });
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].excerpt).not.toMatch(/refund/i);
    });

    it("does not return a knowledge entry with no matching signal", async () => {
      await writeKnowledgeFile(
        durableRoot,
        "## 2026-06-01 -- Refund tokens are single-use\n\n**Evidence:** src/core/refund.ts:42.\n",
      );

      const result = await retrieveCandidates({ durableRoot, keywords: ["completely-unrelated-term"] });
      expect(result.candidates).toEqual([]);
    });

    it("is excluded when 'projectKnowledge' is not in the requested sources", async () => {
      await writeKnowledgeFile(
        durableRoot,
        "## 2026-06-01 -- Refund tokens are single-use\n\n**Evidence:** src/core/refund.ts:42.\n",
      );

      const result = await retrieveCandidates({
        durableRoot,
        keywords: ["refund"],
        sources: ["specs", "archivedChanges", "gitHistory"],
      });
      expect(result.candidates).toEqual([]);
    });

    it("returns an empty result when knowledge.md does not exist yet", async () => {
      const result = await retrieveCandidates({ durableRoot, keywords: ["refund"] });
      expect(result.candidates).toEqual([]);
    });
  });

  describe("splitKnowledgeEntries", () => {
    it("splits content into one entry per '## ' heading, discarding text before the first heading", async () => {
      const { splitKnowledgeEntries } = await import("../../src/core/retrieval.js");
      const entries = splitKnowledgeEntries(
        [
          "# Project Knowledge",
          "",
          "## 2026-06-01 -- Refund tokens are single-use",
          "Body line 1.",
          "## 2026-06-02 -- Billing webhooks retry with exponential backoff",
          "Body line 2.",
        ].join("\n"),
      );

      expect(entries.length).toBe(2);
      expect(entries[0].date).toBe("2026-06-01T00:00:00.000Z");
      expect(entries[0].claim).toBe("Refund tokens are single-use");
      expect(entries[0].body).toContain("Body line 1.");
      expect(entries[0].body).not.toContain("Body line 2.");
      expect(entries[1].date).toBe("2026-06-02T00:00:00.000Z");
      expect(entries[1].claim).toBe("Billing webhooks retry with exponential backoff");
    });

    it("accepts both an em dash and a plain hyphen between the date and the claim", async () => {
      const { splitKnowledgeEntries } = await import("../../src/core/retrieval.js");
      const entries = splitKnowledgeEntries("## 2026-06-01 — Em dash claim\n## 2026-06-02 - Hyphen claim\n");
      expect(entries.map((e) => e.claim)).toEqual(["Em dash claim", "Hyphen claim"]);
    });

    it("returns an empty array for content with no recognizable heading", async () => {
      const { splitKnowledgeEntries } = await import("../../src/core/retrieval.js");
      expect(splitKnowledgeEntries("Just some prose, no headings.\n")).toEqual([]);
    });
  });

  describe("ranking and confidence", () => {
    it("ranks a candidate matching on both path and keyword above one matching only on keyword", async () => {
      await writeCurrentSpec(
        durableRoot,
        "authentication",
        "# Authentication\n\nSee src/core/auth.ts for token issuance.\n",
      );
      await writeCurrentSpec(durableRoot, "billing", "# Billing\n\nMentions token expiry only in passing.\n");

      const result = await retrieveCandidates({
        durableRoot,
        keywords: ["token"],
        paths: ["src/core/auth.ts"],
        limit: 20,
      });
      expect(result.candidates.length).toBe(2);
      expect(result.candidates[0].path).toContain("authentication");
      expect(result.candidates[0].confidence).toBe("strong");
      expect(result.candidates[1].confidence).toBe("weak");
    });

    it("caps the number of returned candidates to `limit`", async () => {
      for (let i = 0; i < 5; i++) {
        await writeCurrentSpec(durableRoot, `capability-${i}`, `# Capability ${i}\n\nMentions widgets.\n`);
      }
      const result = await retrieveCandidates({ durableRoot, keywords: ["widgets"], limit: 2 });
      expect(result.candidates.length).toBe(2);
    });

    it("respects an explicit `sources` restriction", async () => {
      await writeCurrentSpec(durableRoot, "billing", "# Billing\n\nwidgets\n");
      await writeArchivedChangeFile(durableRoot, "2026-01-01-widgets-fix", "proposal.md", "widgets\n");

      const specsOnly = await retrieveCandidates({ durableRoot, keywords: ["widgets"], sources: ["specs"] });
      expect(specsOnly.candidates.every((c) => c.type === "spec")).toBe(true);

      const archivedOnly = await retrieveCandidates({
        durableRoot,
        keywords: ["widgets"],
        sources: ["archivedChanges"],
      });
      expect(archivedOnly.candidates.every((c) => c.type !== "spec")).toBe(true);
    });

    it("dampens a path signal shared by many candidates (a 'hub' file) so it alone cannot reach 'strong'", async () => {
      // Six archived changes all mention the same hub file, and nothing else.
      for (let i = 0; i < 6; i++) {
        await writeArchivedChangeFile(
          durableRoot,
          `2026-01-0${i + 1}-change-${i}`,
          "tasks.md",
          "Touches src/cliMain.ts as part of this change.\n",
        );
      }
      const result = await retrieveCandidates({ durableRoot, paths: ["src/cliMain.ts"], limit: 20 });
      expect(result.candidates.length).toBe(6);
      expect(result.candidates.every((c) => c.confidence !== "strong")).toBe(true);
    });

    it("does not dampen a path signal that only appears a handful of times", async () => {
      for (let i = 0; i < 2; i++) {
        await writeArchivedChangeFile(
          durableRoot,
          `2026-01-0${i + 1}-change-${i}`,
          "tasks.md",
          "Touches src/core/rareFile.ts as part of this change.\n",
        );
      }
      const result = await retrieveCandidates({ durableRoot, paths: ["src/core/rareFile.ts"], limit: 20 });
      expect(result.candidates.every((c) => c.confidence === "strong")).toBe(true);
    });
  });

  describe("historical vs. current is a structural fact, not a judgment", () => {
    it("returns an archived (historical) candidate exactly as recorded, even if it might be stale -- retrieval never checks it against current code", async () => {
      await writeArchivedChangeFile(
        durableRoot,
        "2020-01-01-old-decision",
        "design.md",
        "Decision: always use synchronous writes for durability.\n",
      );
      const result = await retrieveCandidates({ durableRoot, keywords: ["synchronous"] });
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].status).toBe("historical");
      // No verification/contradiction field exists on the contract at all --
      // reconciling this against current code is the calling workflow's job.
      expect(Object.keys(result.candidates[0])).not.toContain("verified");
      expect(Object.keys(result.candidates[0])).not.toContain("stillValid");
    });
  });

  describe("renamed terminology (known V1 limitation)", () => {
    it("a keyword that never appears verbatim finds nothing, even if a synonym is discussed at length", async () => {
      await writeCurrentSpec(durableRoot, "auth", "# Auth\n\nCovers sign-in and credential checks.\n");
      // The spec discusses "sign-in", but the query only knows the newer term "login" --
      // deterministic keyword matching alone cannot bridge that; see the module's doc
      // comment and the Retrieval Contract design's explicit V1 limitation.
      const result = await retrieveCandidates({ durableRoot, keywords: ["login"] });
      expect(result.candidates).toEqual([]);
    });

    it("a caller that already knows both terms can bridge the rename itself by passing both as keywords", async () => {
      await writeCurrentSpec(durableRoot, "auth", "# Auth\n\nCovers sign-in and credential checks.\n");
      const result = await retrieveCandidates({ durableRoot, keywords: ["login", "sign-in"] });
      expect(result.candidates.length).toBe(1);
    });
  });
});

describe("retrieveCandidates -- Git history source", () => {
  let repoDir: string;
  let durableRoot: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "ce-harness-retrieval-repo-"));
    await execa("git", ["init", "--initial-branch=main", repoDir]);
    await execa("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
    await execa("git", ["-C", repoDir, "config", "user.name", "Test User"]);
    durableRoot = await mkdtemp(join(tmpdir(), "ce-harness-retrieval-store-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(durableRoot, { recursive: true, force: true });
  });

  it("finds commits touching a given path", async () => {
    await mkdir(join(repoDir, "apps", "billing"), { recursive: true });
    await writeFile(join(repoDir, "apps", "billing", "refund.ts"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "add refund handling"]);

    const result = await retrieveCandidates({
      durableRoot,
      repositoryPath: repoDir,
      paths: ["apps/billing/refund.ts"],
    });
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].type).toBe("git-commit");
    expect(result.candidates[0].status).toBe("historical");
    expect(result.candidates[0].confidence).toBe("strong");
  });

  it("finds commits by keyword in the commit message", async () => {
    await writeFile(join(repoDir, "a.txt"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "fix widget overflow bug"]);

    const result = await retrieveCandidates({ durableRoot, repositoryPath: repoDir, keywords: ["widget"] });
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].type).toBe("git-commit");
  });

  it("does not run the Git history source at all when repositoryPath is omitted", async () => {
    const result = await retrieveCandidates({ durableRoot, keywords: ["widget"] });
    expect(result.candidates).toEqual([]);
    expect(result.warnings.some((w) => /git/i.test(w))).toBe(false);
  });

  it("demotes (but does not exclude) a message-matched commit whose changed files fall outside the caller's monorepo scope", async () => {
    await mkdir(join(repoDir, "apps", "billing"), { recursive: true });
    await writeFile(join(repoDir, "apps", "billing", "refund.ts"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "widget cleanup in billing app"]);

    await mkdir(join(repoDir, "apps", "notifications"), { recursive: true });
    await writeFile(join(repoDir, "apps", "notifications", "email.ts"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "widget cleanup in notifications app"]);

    // Caller only cares about the billing app.
    const result = await retrieveCandidates({
      durableRoot,
      repositoryPath: repoDir,
      keywords: ["widget"],
      paths: ["apps/billing/unrelated-file.ts"],
      limit: 20,
    });
    expect(result.candidates.length).toBe(2);
    const billing = result.candidates.find((c) => c.excerpt?.includes("billing app"));
    const notifications = result.candidates.find((c) => c.excerpt?.includes("notifications app"));
    expect(billing).toBeDefined();
    expect(notifications).toBeDefined();
    // The in-scope commit ranks above the out-of-scope one.
    expect(result.candidates.indexOf(billing!)).toBeLessThan(result.candidates.indexOf(notifications!));
  });
});
