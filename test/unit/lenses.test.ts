import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLensesDir,
  expectedLensesDir,
  lensesDirExists,
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
