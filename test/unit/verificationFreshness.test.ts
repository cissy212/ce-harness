import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { templatesRoot } from "../../src/core/templates.js";
import { createTempRepo } from "../helpers/tempRepo.js";

/**
 * Executes the actual worktree-fingerprint and artifacts-hash logic
 * `/verify`, `/adversarial-review`, and `/archive` ship -- extracted
 * verbatim from the real templates/commands/*.md files -- against real,
 * constructed Git repositories and directories. A purely textual check
 * (does the markdown contain the right commands) would not catch a
 * computation that's syntactically fine but behaviorally wrong -- e.g.
 * one that only looks at `git rev-parse HEAD` and so misses uncommitted
 * work, which is exactly the bug this module fixes. This proves the
 * actual git/shell behavior is correct for every case that matters.
 *
 * The three files' snippets differ in comment wording and indentation
 * (archive.md's is nested inside a numbered step; verify.md's and
 * adversarial-review.md's are top-level) -- extraction tolerates that
 * via whitespace-flexible regexes, and a dedicated test below proves
 * behavioral equivalence by running all three against identical state,
 * rather than asserting textual byte-equality.
 */

const FILES = ["verify.md", "adversarial-review.md", "archive.md"] as const;

async function readTemplate(name: (typeof FILES)[number]): Promise<string> {
  return readFile(join(templatesRoot(), "commands", name), "utf8");
}

const FINGERPRINT_PATTERN =
  /\{[ \t]*\n[ \t]*git -C "\$CE_WORKTREE" rev-parse HEAD[ \t]*\n[ \t]*git -C "\$CE_WORKTREE" diff HEAD[ \t]*\n[ \t]*git -C "\$CE_WORKTREE" ls-files --others --exclude-standard -z \| \(cd "\$CE_WORKTREE" && xargs -0 cat\) 2>\/dev\/null[ \t]*\n[ \t]*\} \| \(sha256sum 2>\/dev\/null \|\| shasum -a 256\) \| cut -c1-12/;

const ARTIFACTS_HASH_PATTERN =
  /\{[ \t]*\n[ \t]*for f in proposal\.md design\.md tasks\.md; do[ \t]*\n[ \t]*\[ -f "<changeRoot>\/\$f" \] && cat "<changeRoot>\/\$f"[ \t]*\n[ \t]*done[ \t]*\n[ \t]*find "<changeRoot>\/specs" -type f 2>\/dev\/null \| sort \| xargs cat 2>\/dev\/null[ \t]*\n[ \t]*\} \| \(sha256sum 2>\/dev\/null \|\| shasum -a 256\) \| cut -c1-12/;

function extractFingerprintSnippet(content: string, label: string): string {
  const match = content.match(FINGERPRINT_PATTERN);
  if (!match) {
    throw new Error(`${label}: worktree fingerprint snippet not found`);
  }
  return match[0];
}

function extractArtifactsHashSnippet(content: string, label: string): string {
  const match = content.match(ARTIFACTS_HASH_PATTERN);
  if (!match) {
    throw new Error(`${label}: artifacts hash snippet not found`);
  }
  return match[0];
}

async function runFingerprint(worktreePath: string, snippet: string): Promise<string> {
  const result = await execa("bash", ["-c", snippet], {
    env: { ...process.env, CE_WORKTREE: worktreePath },
  });
  return result.stdout.trim();
}

async function runArtifactsHash(changeRoot: string, snippet: string): Promise<string> {
  const resolved = snippet.replaceAll("<changeRoot>", changeRoot);
  const result = await execa("bash", ["-c", resolved]);
  return result.stdout.trim();
}

async function makeChangeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ce-harness-changeroot-"));
  await writeFile(join(dir, "proposal.md"), "# Proposal\n", "utf8");
  await writeFile(join(dir, "design.md"), "# Design\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "- [ ] task one\n", "utf8");
  return dir;
}

describe("verification freshness fingerprint, executed for real", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    cleanupDirs.length = 0;
  });

  describe("cross-file behavioral equivalence (verify.md, adversarial-review.md, archive.md)", () => {
    it("all three compute the identical worktree fingerprint for identical state", async () => {
      const repoDir = await createTempRepo();
      cleanupDirs.push(repoDir);

      const fingerprints = [];
      for (const file of FILES) {
        const content = await readTemplate(file);
        const snippet = extractFingerprintSnippet(content, file);
        fingerprints.push(await runFingerprint(repoDir, snippet));
      }

      expect(fingerprints[0]).toMatch(/^[0-9a-f]{12}$/);
      expect(fingerprints[1]).toBe(fingerprints[0]);
      expect(fingerprints[2]).toBe(fingerprints[0]);
    });

    it("all three compute the identical artifacts hash for identical state", async () => {
      const changeRoot = await makeChangeRoot();
      cleanupDirs.push(changeRoot);

      const hashes = [];
      for (const file of FILES) {
        const content = await readTemplate(file);
        const snippet = extractArtifactsHashSnippet(content, file);
        hashes.push(await runArtifactsHash(changeRoot, snippet));
      }

      expect(hashes[0]).toMatch(/^[0-9a-f]{12}$/);
      expect(hashes[1]).toBe(hashes[0]);
      expect(hashes[2]).toBe(hashes[0]);
    });
  });

  describe("worktree fingerprint behavior", () => {
    it("unchanged state: same fingerprint (fresh)", async () => {
      const repoDir = await createTempRepo();
      cleanupDirs.push(repoDir);
      const snippet = extractFingerprintSnippet(await readTemplate("verify.md"), "verify.md");

      const a = await runFingerprint(repoDir, snippet);
      const b = await runFingerprint(repoDir, snippet);

      expect(a).toBe(b);
    });

    it("uncommitted tracked edit, no commit made: fingerprint changes -- the reported bug", async () => {
      const repoDir = await createTempRepo();
      cleanupDirs.push(repoDir);
      const snippet = extractFingerprintSnippet(await readTemplate("verify.md"), "verify.md");

      const before = await runFingerprint(repoDir, snippet);
      const headBefore = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

      await writeFile(join(repoDir, "README.md"), "hello\n\nmodified without committing\n", "utf8");

      const after = await runFingerprint(repoDir, snippet);
      const headAfter = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

      expect(headAfter).toBe(headBefore); // sanity: genuinely no commit was made
      expect(after).not.toBe(before);
    });

    it("new untracked file (never git add'ed): fingerprint changes", async () => {
      const repoDir = await createTempRepo();
      cleanupDirs.push(repoDir);
      const snippet = extractFingerprintSnippet(await readTemplate("verify.md"), "verify.md");

      const before = await runFingerprint(repoDir, snippet);
      await writeFile(join(repoDir, "src-foo.ts"), "export const x = 1;\n", "utf8");
      const after = await runFingerprint(repoDir, snippet);

      expect(after).not.toBe(before);
    });

    it("editing an already-untracked file's content: fingerprint changes again, not just its presence", async () => {
      const repoDir = await createTempRepo();
      cleanupDirs.push(repoDir);
      const snippet = extractFingerprintSnippet(await readTemplate("verify.md"), "verify.md");

      await writeFile(join(repoDir, "src-foo.ts"), "export const x = 1;\n", "utf8");
      const afterCreate = await runFingerprint(repoDir, snippet);

      await writeFile(join(repoDir, "src-foo.ts"), "export const x = 2;\n", "utf8");
      const afterEdit = await runFingerprint(repoDir, snippet);

      expect(afterEdit).not.toBe(afterCreate);
    });

    it("staged but not committed change: fingerprint changes", async () => {
      const repoDir = await createTempRepo();
      cleanupDirs.push(repoDir);
      const snippet = extractFingerprintSnippet(await readTemplate("verify.md"), "verify.md");

      const before = await runFingerprint(repoDir, snippet);
      await writeFile(join(repoDir, "README.md"), "hello\n\nstaged edit\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "README.md"]);
      const after = await runFingerprint(repoDir, snippet);

      expect(after).not.toBe(before);
    });

    it("reverting all changes: fingerprint returns to the original value", async () => {
      const repoDir = await createTempRepo();
      cleanupDirs.push(repoDir);
      const snippet = extractFingerprintSnippet(await readTemplate("verify.md"), "verify.md");

      const original = await runFingerprint(repoDir, snippet);
      await writeFile(join(repoDir, "README.md"), "hello\n\nmodified\n", "utf8");
      expect(await runFingerprint(repoDir, snippet)).not.toBe(original);

      await execa("git", ["-C", repoDir, "checkout", "--", "README.md"]);
      expect(await runFingerprint(repoDir, snippet)).toBe(original);
    });

    it("a new commit (nothing left uncommitted): fingerprint changes too, not just uncommitted edits", async () => {
      const repoDir = await createTempRepo();
      cleanupDirs.push(repoDir);
      const snippet = extractFingerprintSnippet(await readTemplate("verify.md"), "verify.md");

      const before = await runFingerprint(repoDir, snippet);
      await writeFile(join(repoDir, "README.md"), "hello\n\ncommitted edit\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "README.md"]);
      await execa("git", ["-C", repoDir, "commit", "-m", "edit"]);
      const after = await runFingerprint(repoDir, snippet);

      expect(after).not.toBe(before);
    });

    it("respects gitignore: an ignored untracked file's content never affects the fingerprint", async () => {
      const repoDir = await createTempRepo();
      cleanupDirs.push(repoDir);
      const snippet = extractFingerprintSnippet(await readTemplate("verify.md"), "verify.md");

      await writeFile(join(repoDir, ".gitignore"), "ignored.txt\n", "utf8");
      const afterGitignoreAdded = await runFingerprint(repoDir, snippet);

      await writeFile(join(repoDir, "ignored.txt"), "should not matter\n", "utf8");
      const afterIgnoredFileAdded = await runFingerprint(repoDir, snippet);

      expect(afterIgnoredFileAdded).toBe(afterGitignoreAdded);
    });
  });

  describe("artifacts hash behavior", () => {
    it("unchanged artifacts: same hash (fresh)", async () => {
      const changeRoot = await makeChangeRoot();
      cleanupDirs.push(changeRoot);
      const snippet = extractArtifactsHashSnippet(await readTemplate("verify.md"), "verify.md");

      const a = await runArtifactsHash(changeRoot, snippet);
      const b = await runArtifactsHash(changeRoot, snippet);

      expect(a).toBe(b);
    });

    it("tasks.md changed: hash changes", async () => {
      const changeRoot = await makeChangeRoot();
      cleanupDirs.push(changeRoot);
      const snippet = extractArtifactsHashSnippet(await readTemplate("verify.md"), "verify.md");

      const before = await runArtifactsHash(changeRoot, snippet);
      await writeFile(join(changeRoot, "tasks.md"), "- [x] task one\n- [ ] task two\n", "utf8");
      const after = await runArtifactsHash(changeRoot, snippet);

      expect(after).not.toBe(before);
    });

    it("design.md changed, tasks.md untouched: hash still changes -- coverage isn't limited to tasks.md", async () => {
      const changeRoot = await makeChangeRoot();
      cleanupDirs.push(changeRoot);
      const snippet = extractArtifactsHashSnippet(await readTemplate("verify.md"), "verify.md");

      const before = await runArtifactsHash(changeRoot, snippet);
      await writeFile(join(changeRoot, "design.md"), "# Design\n\nRevised approach.\n", "utf8");
      const after = await runArtifactsHash(changeRoot, snippet);

      expect(after).not.toBe(before);
    });

    it("proposal.md changed, tasks.md untouched: hash still changes", async () => {
      const changeRoot = await makeChangeRoot();
      cleanupDirs.push(changeRoot);
      const snippet = extractArtifactsHashSnippet(await readTemplate("verify.md"), "verify.md");

      const before = await runArtifactsHash(changeRoot, snippet);
      await writeFile(join(changeRoot, "proposal.md"), "# Proposal\n\nRevised scope.\n", "utf8");
      const after = await runArtifactsHash(changeRoot, snippet);

      expect(after).not.toBe(before);
    });

    it("a delta spec under specs/ changed: hash changes -- coverage extends past the three top-level files", async () => {
      const changeRoot = await makeChangeRoot();
      cleanupDirs.push(changeRoot);
      const snippet = extractArtifactsHashSnippet(await readTemplate("verify.md"), "verify.md");
      await mkdir(join(changeRoot, "specs", "billing"), { recursive: true });
      await writeFile(join(changeRoot, "specs", "billing", "spec.md"), "delta v1\n", "utf8");

      const before = await runArtifactsHash(changeRoot, snippet);
      await writeFile(join(changeRoot, "specs", "billing", "spec.md"), "delta v2\n", "utf8");
      const after = await runArtifactsHash(changeRoot, snippet);

      expect(after).not.toBe(before);
    });

    it("unrelated changeRoot content (e.g. reports/) never affects the artifacts hash -- no self-referential drift", async () => {
      const changeRoot = await makeChangeRoot();
      cleanupDirs.push(changeRoot);
      const snippet = extractArtifactsHashSnippet(await readTemplate("verify.md"), "verify.md");

      const before = await runArtifactsHash(changeRoot, snippet);
      await mkdir(join(changeRoot, "reports"), { recursive: true });
      await writeFile(join(changeRoot, "reports", "2026-09-01-verify.md"), "report content\n", "utf8");
      const after = await runArtifactsHash(changeRoot, snippet);

      expect(after).toBe(before);
    });
  });
});
