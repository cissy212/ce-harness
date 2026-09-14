import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLensesDir,
  expectedLensesDir,
  lensesDirExists,
  refreshLensesDir,
} from "../../src/core/lenses.js";
import { templatesRoot } from "../../src/core/templates.js";

describe("lenses (canonical, runner-agnostic reasoning-lens directory)", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "ce-harness-lenses-"));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("expectedLensesDir is always <workspacePath>/lenses", () => {
    expect(expectedLensesDir(workspacePath)).toBe(join(workspacePath, "lenses"));
    expect(expectedLensesDir("/home/user/.ce-harness/workspaces/demo/issue-1")).toBe(
      "/home/user/.ce-harness/workspaces/demo/issue-1/lenses",
    );
  });

  it("is not nested inside opencode/ -- it's a sibling directory", () => {
    const dir = expectedLensesDir(workspacePath);
    expect(dir).not.toContain(join("opencode", "agents"));
    expect(dir.startsWith(join(workspacePath, "opencode"))).toBe(false);
  });

  it("lensesDirExists is false before creation", () => {
    expect(lensesDirExists(workspacePath)).toBe(false);
  });

  it("createLensesDir creates <workspacePath>/lenses and returns its path", async () => {
    const dir = await createLensesDir(workspacePath);

    expect(dir).toBe(expectedLensesDir(workspacePath));
    expect(existsSync(dir)).toBe(true);
  });

  it("lensesDirExists is true after creation", async () => {
    await createLensesDir(workspacePath);
    expect(lensesDirExists(workspacePath)).toBe(true);
  });

  it("is idempotent (safe to call twice)", async () => {
    await createLensesDir(workspacePath);
    await expect(createLensesDir(workspacePath)).resolves.toBe(
      expectedLensesDir(workspacePath),
    );
  });

  it("populates from the harness's real templates/lenses/ library, byte-for-byte", async () => {
    const dir = await createLensesDir(workspacePath);

    for (const filename of [
      "backend-developer.md",
      "pipeline-data-engineer.md",
      "frontend-developer.md",
      "accessibility-reviewer.md",
      "typescript-engineer.md",
      "security-reviewer.md",
    ]) {
      const copiedPath = join(dir, filename);
      const sourcePath = join(templatesRoot(), "lenses", filename);
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    }
  });

  it("is generic: copies whatever templates/lenses/ contains, not a hardcoded filename list", async () => {
    const originalOverride = process.env.CE_TEMPLATES_ROOT;
    const fakeTemplatesRoot = await mkdtemp(join(tmpdir(), "ce-harness-fake-templates-"));
    try {
      const lensesDir = join(fakeTemplatesRoot, "lenses");
      await mkdir(lensesDir, { recursive: true });
      await writeFile(join(lensesDir, "custom-lens.md"), "custom content\n", "utf8");
      process.env.CE_TEMPLATES_ROOT = fakeTemplatesRoot;

      const dir = await createLensesDir(workspacePath);

      expect(await readFile(join(dir, "custom-lens.md"), "utf8")).toBe("custom content\n");
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CE_TEMPLATES_ROOT;
      } else {
        process.env.CE_TEMPLATES_ROOT = originalOverride;
      }
      await rm(fakeTemplatesRoot, { recursive: true, force: true });
    }
  });
});

describe("refreshLensesDir (additive sync -- ce refresh's counterpart to createLensesDir)", () => {
  let workspacePath: string;
  let fakeTemplatesRoot: string;
  const originalOverride = process.env.CE_TEMPLATES_ROOT;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "ce-harness-lenses-"));
    fakeTemplatesRoot = await mkdtemp(join(tmpdir(), "ce-harness-fake-templates-"));
    process.env.CE_TEMPLATES_ROOT = fakeTemplatesRoot;
  });

  afterEach(async () => {
    if (originalOverride === undefined) {
      delete process.env.CE_TEMPLATES_ROOT;
    } else {
      process.env.CE_TEMPLATES_ROOT = originalOverride;
    }
    await rm(workspacePath, { recursive: true, force: true });
    await rm(fakeTemplatesRoot, { recursive: true, force: true });
  });

  it("adds a flat .md lens present in the template library but missing from the workspace", async () => {
    await createLensesDir(workspacePath); // empty at this point -- fake root has no lenses/ yet

    const lensesDir = join(fakeTemplatesRoot, "lenses");
    await mkdir(lensesDir, { recursive: true });
    await writeFile(join(lensesDir, "new-lens.md"), "new content\n", "utf8");

    const result = await refreshLensesDir(workspacePath);

    expect(result.written).toEqual(["new-lens.md"]);
    expect(result.skipped).toEqual([]);
    expect(await readFile(join(expectedLensesDir(workspacePath), "new-lens.md"), "utf8")).toBe("new content\n");
  });

  it("adds a vendored Agent Skill lens directory (its own SKILL.md), recursively", async () => {
    await createLensesDir(workspacePath);

    const skillDir = join(fakeTemplatesRoot, "lenses", "comment-cleanup");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: comment-cleanup\n---\n", "utf8");

    const result = await refreshLensesDir(workspacePath);

    expect(result.written).toEqual(["comment-cleanup"]);
    expect(existsSync(join(expectedLensesDir(workspacePath), "comment-cleanup", "SKILL.md"))).toBe(true);
  });

  it("never overwrites an already-existing lens entry, harness-written or user-added", async () => {
    const lensesDir = join(fakeTemplatesRoot, "lenses");
    await mkdir(lensesDir, { recursive: true });
    await writeFile(join(lensesDir, "existing.md"), "template version\n", "utf8");

    await createLensesDir(workspacePath); // copies existing.md as-is at creation time

    // Simulate a user hand-editing it afterward.
    await writeFile(join(expectedLensesDir(workspacePath), "existing.md"), "hand-edited by the user\n", "utf8");
    // The template library also moves on independently.
    await writeFile(join(lensesDir, "existing.md"), "updated template version\n", "utf8");

    const result = await refreshLensesDir(workspacePath);

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(["existing.md"]);
    expect(await readFile(join(expectedLensesDir(workspacePath), "existing.md"), "utf8")).toBe(
      "hand-edited by the user\n",
    );
  });

  it("is idempotent: a second call after adding a lens reports nothing further to write", async () => {
    await createLensesDir(workspacePath);
    const lensesDir = join(fakeTemplatesRoot, "lenses");
    await mkdir(lensesDir, { recursive: true });
    await writeFile(join(lensesDir, "new-lens.md"), "content\n", "utf8");

    await refreshLensesDir(workspacePath);
    const second = await refreshLensesDir(workspacePath);

    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual(["new-lens.md"]);
  });
});
