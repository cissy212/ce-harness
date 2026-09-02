import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { templatesRoot } from "../../src/core/templates.js";
import { readChangeOwnership } from "../../src/core/activeChange.js";

/**
 * Executes the actual ownership-sidecar-writing bash `/propose` ships --
 * extracted verbatim from templates/commands/propose.md -- against a
 * real directory, the same "prove the shell behavior, not just the
 * markdown text" approach test/unit/verificationFreshness.test.ts uses
 * for /verify's, /adversarial-review's, and /archive's fingerprint
 * snippets.
 */

const SNIPPET_MARKER = "**Record this workspace's ownership of the change**";

async function readPropose(): Promise<string> {
  return readFile(join(templatesRoot(), "commands", "propose.md"), "utf8");
}

function extractOwnershipSnippet(content: string): string {
  const markerIdx = content.indexOf(SNIPPET_MARKER);
  if (markerIdx === -1) {
    throw new Error("ownership-recording marker not found in propose.md");
  }
  const fenceStart = content.indexOf("```bash", markerIdx);
  if (fenceStart === -1) {
    throw new Error("no bash fence found after the ownership-recording marker");
  }
  const codeStart = content.indexOf("\n", fenceStart) + 1;
  const fenceEnd = content.indexOf("```", codeStart);
  if (fenceEnd === -1) {
    throw new Error("unterminated bash fence after the ownership-recording marker");
  }
  return content
    .slice(codeStart, fenceEnd)
    .split("\n")
    .map((line) => line.replace(/^ {0,3}/, ""))
    .join("\n")
    .trim();
}

describe("propose.md's ownership-sidecar bash (verbatim, real execution)", () => {
  let changeRoot: string;

  afterEach(async () => {
    if (changeRoot) await rm(changeRoot, { recursive: true, force: true });
  });

  it("writes a project/issue sidecar readChangeOwnership can parse back exactly", async () => {
    changeRoot = await mkdtemp(join(tmpdir(), "ce-harness-propose-ownership-"));
    const snippet = extractOwnershipSnippet(await readPropose());

    await execa("bash", ["-c", snippet.replaceAll("<changeRoot>", changeRoot)], {
      env: { ...process.env, CE_PROJECT: "my-project", CE_ISSUE: "issue-130" },
    });

    expect(await readChangeOwnership(changeRoot)).toEqual({ project: "my-project", issue: "issue-130" });
  });

  it("is idempotent: re-running for the same workspace leaves the same association", async () => {
    changeRoot = await mkdtemp(join(tmpdir(), "ce-harness-propose-ownership-"));
    const snippet = extractOwnershipSnippet(await readPropose());
    const resolved = snippet.replaceAll("<changeRoot>", changeRoot);

    await execa("bash", ["-c", resolved], {
      env: { ...process.env, CE_PROJECT: "my-project", CE_ISSUE: "issue-130" },
    });
    await execa("bash", ["-c", resolved], {
      env: { ...process.env, CE_PROJECT: "my-project", CE_ISSUE: "issue-130" },
    });

    expect(await readChangeOwnership(changeRoot)).toEqual({ project: "my-project", issue: "issue-130" });
  });
});

describe("propose.md (text content)", () => {
  it("documents the ownership sidecar as ce-harness bookkeeping, never a schema artifact or dependency", async () => {
    const content = await readPropose();
    expect(content).toMatch(/\.ce-workspace\.yml/);
    expect(content).toMatch(/never (part of `applyRequires`|read it)/);
  });

  it("never suggests including the ownership sidecar in the command's output", async () => {
    const content = await readPropose();
    expect(content).toMatch(/never mention(ed)?(\s+it)?\s+in this command's output/);
  });
});
