import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { templatesRoot } from "../../src/core/templates.js";
import { createTempRepo } from "../helpers/tempRepo.js";
import { computeWorktreeFingerprint } from "../../src/core/git.js";
import { readProvenance } from "../../src/core/provenance.js";

/**
 * Executes the actual provenance-recording and staleness-checking bash
 * `/explore`, `/enrich`, `/propose`, and `/apply` ship -- extracted
 * verbatim from the real templates/commands/*.md files -- against real,
 * constructed Git repositories, the same "prove the shell behavior, not
 * just the markdown text" approach test/unit/verificationFreshness.test.ts
 * already uses for /verify's own fingerprint snippet.
 *
 * Real gap this fixes: durable planning artifacts (explore.md,
 * enrich.md, and /propose's proposal.md/design.md/tasks.md) had zero
 * provenance tracking -- a durable store outlives any one workspace, so
 * a much later stage reusing it could silently trust findings/a plan
 * written against a codebase snapshot no longer resembling the current
 * one. These tests prove: each stage's recording snippet actually
 * writes a correct, TypeScript-readable stamp; every stage's
 * fingerprint computation is byte-for-byte the algorithm
 * `computeWorktreeFingerprint` (git.ts) and `/verify` already use, not
 * a parallel, potentially-diverging reimplementation; and a template's
 * own staleness-checking snippet actually detects drift for real.
 */

async function readTemplate(name: string): Promise<string> {
  return readFile(join(templatesRoot(), "commands", name), "utf8");
}

/** Extracts a bash block starting at `startMarker` through its enclosing fence's close, dedenting up to 3 leading spaces of list-item indentation per line (0/2/3-space indents all handled). */
function extractBashBlock(content: string, startMarker: string, label: string): string {
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`${label}: start marker not found: ${JSON.stringify(startMarker)}`);
  }
  const closeMatch = /\n[ \t]{0,3}```/.exec(content.slice(startIdx));
  if (!closeMatch) {
    throw new Error(`${label}: closing fence not found after start marker`);
  }
  const endIdx = startIdx + closeMatch.index;
  return content
    .slice(startIdx, endIdx)
    .split("\n")
    .map((line) => line.replace(/^ {0,3}/, ""))
    .join("\n");
}

async function extractRecordingSnippet(templateFile: string, stage: string): Promise<string> {
  const content = await readTemplate(templateFile);
  return extractBashBlock(content, 'COMMIT=$(git -C "$CE_WORKTREE" rev-parse HEAD)', `${templateFile} (${stage} recording)`);
}

async function runRecordingSnippet(templateFile: string, stage: string, worktreePath: string, changeRoot: string): Promise<void> {
  const snippet = (await extractRecordingSnippet(templateFile, stage)).replaceAll("<changeRoot>", changeRoot);
  await execa("bash", ["-c", snippet], { env: { ...process.env, CE_WORKTREE: worktreePath } });
}

/** Extracts just the "current fingerprint" computation (the part reused, verbatim, in every checking and recording snippet alike). */
async function extractFingerprintComputation(templateFile: string, marker: string): Promise<string> {
  const content = await readTemplate(templateFile);
  const startIdx = content.indexOf(marker);
  if (startIdx === -1) throw new Error(`${templateFile}: fingerprint computation marker not found: ${marker}`);
  // The computation is the "{ ... } | (sha256sum ...) | cut -c1-12" block -- ends at the first "cut -c1-12" after the marker.
  const cutIdx = content.indexOf("cut -c1-12", startIdx);
  if (cutIdx === -1) throw new Error(`${templateFile}: fingerprint computation doesn't end in cut -c1-12`);
  const endIdx = content.indexOf("\n", cutIdx);
  return content
    .slice(startIdx, endIdx)
    .split("\n")
    .map((line) => line.replace(/^ {0,3}/, ""))
    .join("\n");
}

async function runFingerprintComputation(snippet: string, worktreePath: string): Promise<string> {
  // `snippet` is a complete `VAR=$({ ... } | ... | cut -c1-12)` assignment
  // -- normalize whatever variable name it assigns to, then print it.
  // Never re-wrap it in another `$(...)`, which would double-substitute.
  const normalized = snippet.replace(/^\w+=/, "FP=");
  const wrapped = `${normalized}\nprintf '%s' "$FP"`;
  const result = await execa("bash", ["-c", wrapped], { env: { ...process.env, CE_WORKTREE: worktreePath } });
  return result.stdout.trim();
}

describe("provenance recording, executed for real", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    cleanupDirs.length = 0;
  });

  async function setup(): Promise<{ repoDir: string; changeRoot: string }> {
    const repoDir = await createTempRepo();
    const changeRoot = await mkdtemp(join(tmpdir(), "ce-harness-provenance-changeroot-"));
    cleanupDirs.push(repoDir, changeRoot);
    return { repoDir, changeRoot };
  }

  it("explore.md's recording snippet writes a stamp whose fingerprint matches computeWorktreeFingerprint", async () => {
    const { repoDir, changeRoot } = await setup();
    const expected = await computeWorktreeFingerprint(repoDir);

    await runRecordingSnippet("explore.md", "explore", repoDir, changeRoot);

    const stamp = await readProvenance(changeRoot, "explore");
    expect(stamp).not.toBeNull();
    expect(stamp?.fingerprint).toBe(expected);
    expect(stamp?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(stamp?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("enrich.md's recording snippet writes a stamp whose fingerprint matches computeWorktreeFingerprint", async () => {
    const { repoDir, changeRoot } = await setup();
    const expected = await computeWorktreeFingerprint(repoDir);

    await runRecordingSnippet("enrich.md", "enrich", repoDir, changeRoot);

    const stamp = await readProvenance(changeRoot, "enrich");
    expect(stamp?.fingerprint).toBe(expected);
  });

  it("propose.md's recording snippet writes a stamp whose fingerprint matches computeWorktreeFingerprint", async () => {
    const { repoDir, changeRoot } = await setup();
    const expected = await computeWorktreeFingerprint(repoDir);

    await runRecordingSnippet("propose.md", "propose", repoDir, changeRoot);

    const stamp = await readProvenance(changeRoot, "propose");
    expect(stamp?.fingerprint).toBe(expected);
  });

  it("each stage writes to its own distinct sidecar file, never overwriting another stage's", async () => {
    const { repoDir, changeRoot } = await setup();

    await runRecordingSnippet("explore.md", "explore", repoDir, changeRoot);
    await writeFile(join(repoDir, "after-explore.txt"), "x\n", "utf8");
    await runRecordingSnippet("enrich.md", "enrich", repoDir, changeRoot);
    await writeFile(join(repoDir, "after-enrich.txt"), "y\n", "utf8");
    await runRecordingSnippet("propose.md", "propose", repoDir, changeRoot);

    const explore = await readProvenance(changeRoot, "explore");
    const enrich = await readProvenance(changeRoot, "enrich");
    const propose = await readProvenance(changeRoot, "propose");

    expect(explore).not.toBeNull();
    expect(enrich).not.toBeNull();
    expect(propose).not.toBeNull();
    // Each was recorded at a different worktree state -- proves they
    // didn't clobber each other into agreeing by accident.
    expect(new Set([explore?.fingerprint, enrich?.fingerprint, propose?.fingerprint]).size).toBe(3);
  });

  it("re-running a stage's recording snippet refreshes its stamp in place (idempotent, not additive)", async () => {
    const { repoDir, changeRoot } = await setup();

    await runRecordingSnippet("explore.md", "explore", repoDir, changeRoot);
    const first = await readProvenance(changeRoot, "explore");

    await writeFile(join(repoDir, "more-exploration.txt"), "x\n", "utf8");
    await runRecordingSnippet("explore.md", "explore", repoDir, changeRoot);
    const second = await readProvenance(changeRoot, "explore");

    expect(second?.fingerprint).not.toBe(first?.fingerprint);
    expect(second?.fingerprint).toBe(await computeWorktreeFingerprint(repoDir));
  });

  it("all three recording snippets compute byte-for-byte the same fingerprint for identical worktree state", async () => {
    const { repoDir, changeRoot } = await setup();

    await runRecordingSnippet("explore.md", "explore", repoDir, changeRoot);
    await runRecordingSnippet("enrich.md", "enrich", repoDir, changeRoot);
    await runRecordingSnippet("propose.md", "propose", repoDir, changeRoot);

    const explore = await readProvenance(changeRoot, "explore");
    const enrich = await readProvenance(changeRoot, "enrich");
    const propose = await readProvenance(changeRoot, "propose");

    expect(enrich?.fingerprint).toBe(explore?.fingerprint);
    expect(propose?.fingerprint).toBe(explore?.fingerprint);
  });
});

describe("staleness-checking fingerprint computation is consistent across every consuming template", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    cleanupDirs.length = 0;
  });

  it("enrich.md's, propose.md's, and apply.md's own current-fingerprint checks all agree with computeWorktreeFingerprint", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    await writeFile(join(repoDir, "some-change.txt"), "x\n", "utf8");
    const expected = await computeWorktreeFingerprint(repoDir);

    const enrichSnippet = await extractFingerprintComputation("enrich.md", "CURRENT_FINGERPRINT=$({");
    const proposeSnippet = await extractFingerprintComputation("propose.md", "CURRENT_FINGERPRINT=$({");
    const applySnippet = await extractFingerprintComputation("apply.md", "CURRENT_FINGERPRINT=$({");

    expect(await runFingerprintComputation(enrichSnippet, repoDir)).toBe(expected);
    expect(await runFingerprintComputation(proposeSnippet, repoDir)).toBe(expected);
    expect(await runFingerprintComputation(applySnippet, repoDir)).toBe(expected);
  });
});

describe("template text: guardrails and non-blocking framing", () => {
  it("explore.md, enrich.md, and propose.md each document their own recording step as unconditional (including on a re-run)", async () => {
    const explore = await readTemplate("explore.md");
    const enrich = await readTemplate("enrich.md");
    const propose = await readTemplate("propose.md");

    expect(explore).toMatch(/Never skip step 8 \(recording provenance\)/);
    expect(enrich).toMatch(/Never skip step 9 \(recording provenance\)/);
    expect(propose).toMatch(/Always write\/refresh `<changeRoot>\/\.ce-provenance-propose\.yml`/);
  });

  it("enrich.md, propose.md, and apply.md each hard-gate on staleness (stop, never merely warn)", async () => {
    const enrich = await readTemplate("enrich.md");
    const propose = await readTemplate("propose.md");
    const apply = await readTemplate("apply.md");

    for (const content of [enrich, propose, apply]) {
      expect(content).toMatch(/\*\*stop/i);
    }
  });

  it("enrich.md, propose.md, and apply.md each state that a missing (legacy) sidecar is never treated as fresh", async () => {
    const enrich = await readTemplate("enrich.md");
    const propose = await readTemplate("propose.md");
    const apply = await readTemplate("apply.md");

    for (const content of [enrich, propose, apply]) {
      expect(content).toMatch(/never\s+treat\s+this\s+as\s+fresh/i);
    }
  });

  it("enrich.md, propose.md, and apply.md each direct the user to the specific command to rerun", async () => {
    const enrich = await readTemplate("enrich.md");
    const propose = await readTemplate("propose.md");
    const apply = await readTemplate("apply.md");

    expect(enrich).toMatch(/run\s+`\/explore`\s+again/);
    expect(propose).toMatch(/run\s+`\/explore`\s+again/);
    expect(propose).toMatch(/run\s+`\/enrich`\s+again/);
    expect(apply).toMatch(/run\s+`\/propose`\s+again/);
  });

  it("apply.md checks the propose-stage provenance before implementing, and never invents a package-manager or provenance format", async () => {
    const apply = await readTemplate("apply.md");
    expect(apply).toMatch(/\.ce-provenance-propose\.yml/);
    expect(apply).toMatch(/plan's\s+provenance\s+is\s+unknown\/stale/);
  });
});
