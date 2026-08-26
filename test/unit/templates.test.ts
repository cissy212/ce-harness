import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("templates (generic copy mechanism)", () => {
  let tempDir: string;
  let fakeTemplatesRoot: string;
  let destinationDir: string;
  const originalOverride = process.env.CE_TEMPLATES_ROOT;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ce-harness-templates-"));
    fakeTemplatesRoot = join(tempDir, "templates");
    destinationDir = join(tempDir, "destination");
    await mkdir(fakeTemplatesRoot, { recursive: true });
    process.env.CE_TEMPLATES_ROOT = fakeTemplatesRoot;
  });

  afterEach(async () => {
    if (originalOverride === undefined) {
      delete process.env.CE_TEMPLATES_ROOT;
    } else {
      process.env.CE_TEMPLATES_ROOT = originalOverride;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("copies a single file, preserving its filename and byte-for-byte contents", async () => {
    const { copyTemplates } = await import("../../src/core/templates.js");
    const commandsDir = join(fakeTemplatesRoot, "commands");
    await mkdir(commandsDir, { recursive: true });
    const content = "---\ndescription: test\n---\nHello, world.\n";
    await writeFile(join(commandsDir, "workspace.md"), content, "utf8");

    const copied = await copyTemplates("commands", destinationDir);

    expect(copied).toEqual(["workspace.md"]);
    expect(existsSync(join(destinationDir, "workspace.md"))).toBe(true);
    expect(await readFile(join(destinationDir, "workspace.md"), "utf8")).toBe(content);
  });

  it("is generic: copies every file it finds, not just a hardcoded name", async () => {
    const { copyTemplates } = await import("../../src/core/templates.js");
    const commandsDir = join(fakeTemplatesRoot, "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "workspace.md"), "workspace content\n", "utf8");
    await writeFile(join(commandsDir, "another-command.md"), "another content\n", "utf8");
    await writeFile(join(commandsDir, "yet-another.md"), "yet another content\n", "utf8");

    const copied = await copyTemplates("commands", destinationDir);

    expect(copied.sort()).toEqual(["another-command.md", "workspace.md", "yet-another.md"]);
    const destEntries = (await readdir(destinationDir)).sort();
    expect(destEntries).toEqual(["another-command.md", "workspace.md", "yet-another.md"]);
    expect(await readFile(join(destinationDir, "another-command.md"), "utf8")).toBe(
      "another content\n",
    );
    expect(await readFile(join(destinationDir, "yet-another.md"), "utf8")).toBe(
      "yet another content\n",
    );
  });

  it("works for any category name, not just 'commands'", async () => {
    const { copyTemplates } = await import("../../src/core/templates.js");
    const agentsDir = join(fakeTemplatesRoot, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "reviewer.md"), "agent content\n", "utf8");

    const copied = await copyTemplates("agents", destinationDir);

    expect(copied).toEqual(["reviewer.md"]);
    expect(await readFile(join(destinationDir, "reviewer.md"), "utf8")).toBe("agent content\n");
  });

  it("is a no-op (and creates no destination directory) when the template category doesn't exist yet", async () => {
    const { copyTemplates } = await import("../../src/core/templates.js");

    const copied = await copyTemplates("skills", destinationDir);

    expect(copied).toEqual([]);
    expect(existsSync(destinationDir)).toBe(false);
  });

  it("recursively copies files inside nested subdirectories, preserving relative paths", async () => {
    const { copyTemplates } = await import("../../src/core/templates.js");
    const commandsDir = join(fakeTemplatesRoot, "commands");
    await mkdir(join(commandsDir, "nested"), { recursive: true });
    await writeFile(join(commandsDir, "top-level.md"), "top level\n", "utf8");
    await writeFile(join(commandsDir, "nested", "inner.md"), "inner\n", "utf8");

    const copied = await copyTemplates("commands", destinationDir);

    expect(copied.sort()).toEqual([join("nested", "inner.md"), "top-level.md"].sort());
    expect(existsSync(join(destinationDir, "top-level.md"))).toBe(true);
    expect(existsSync(join(destinationDir, "nested", "inner.md"))).toBe(true);
    expect(await readFile(join(destinationDir, "nested", "inner.md"), "utf8")).toBe("inner\n");
  });

  it("recurses to arbitrary depth, creating intermediate directories as needed", async () => {
    const { copyTemplates } = await import("../../src/core/templates.js");
    const skillsDir = join(fakeTemplatesRoot, "skills");
    const skillDir = join(skillsDir, "openspec-sync-specs");
    await mkdir(skillDir, { recursive: true });
    const content = "---\nname: openspec-sync-specs\n---\nSync content.\n";
    await writeFile(join(skillDir, "SKILL.md"), content, "utf8");

    const copied = await copyTemplates("skills", destinationDir);

    expect(copied).toEqual([join("openspec-sync-specs", "SKILL.md")]);
    const copiedPath = join(destinationDir, "openspec-sync-specs", "SKILL.md");
    expect(existsSync(copiedPath)).toBe(true);
    expect(await readFile(copiedPath, "utf8")).toBe(content);
  });

  it("flat command copying is unaffected by recursion support: no subdirectories, unchanged behavior", async () => {
    const { copyTemplates } = await import("../../src/core/templates.js");
    const commandsDir = join(fakeTemplatesRoot, "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "workspace.md"), "workspace\n", "utf8");
    await writeFile(join(commandsDir, "explore.md"), "explore\n", "utf8");

    const copied = await copyTemplates("commands", destinationDir);

    expect(copied.sort()).toEqual(["explore.md", "workspace.md"]);
    expect((await readdir(destinationDir)).sort()).toEqual(["explore.md", "workspace.md"]);
  });

  describe("copyTemplatesSkippingCollisions (per top-level-entry collision safety)", () => {
    it("copies every entry when the destination is empty, reporting them all as written", async () => {
      const { copyTemplatesSkippingCollisions } = await import("../../src/core/templates.js");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, "workspace.md"), "workspace\n", "utf8");
      await writeFile(join(commandsDir, "explore.md"), "explore\n", "utf8");

      const result = await copyTemplatesSkippingCollisions("commands", destinationDir);

      expect(result.written.sort()).toEqual(["explore.md", "workspace.md"]);
      expect(result.skipped).toEqual([]);
      expect(await readFile(join(destinationDir, "workspace.md"), "utf8")).toBe("workspace\n");
    });

    it("skips only the colliding top-level entry, copying every other one in, and leaves the collision untouched", async () => {
      const { copyTemplatesSkippingCollisions } = await import("../../src/core/templates.js");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, "workspace.md"), "template content\n", "utf8");
      await writeFile(join(commandsDir, "explore.md"), "explore\n", "utf8");

      await mkdir(destinationDir, { recursive: true });
      await writeFile(join(destinationDir, "workspace.md"), "the caller's own content\n", "utf8");

      const result = await copyTemplatesSkippingCollisions("commands", destinationDir);

      expect(result.written).toEqual(["explore.md"]);
      expect(result.skipped).toEqual(["workspace.md"]);
      expect(await readFile(join(destinationDir, "workspace.md"), "utf8")).toBe(
        "the caller's own content\n",
      );
      expect(await readFile(join(destinationDir, "explore.md"), "utf8")).toBe("explore\n");
    });

    it("treats a whole skill directory as one collision unit, without merging into a same-named pre-existing directory", async () => {
      const { copyTemplatesSkippingCollisions } = await import("../../src/core/templates.js");
      const skillsDir = join(fakeTemplatesRoot, "skills");
      await mkdir(join(skillsDir, "openspec-sync-specs"), { recursive: true });
      await writeFile(join(skillsDir, "openspec-sync-specs", "SKILL.md"), "template skill\n", "utf8");
      await mkdir(join(skillsDir, "composition-patterns"), { recursive: true });
      await writeFile(join(skillsDir, "composition-patterns", "SKILL.md"), "other skill\n", "utf8");

      await mkdir(join(destinationDir, "openspec-sync-specs"), { recursive: true });
      await writeFile(
        join(destinationDir, "openspec-sync-specs", "SKILL.md"),
        "the repository's own skill\n",
        "utf8",
      );

      const result = await copyTemplatesSkippingCollisions("skills", destinationDir);

      expect(result.written).toEqual(["composition-patterns"]);
      expect(result.skipped).toEqual(["openspec-sync-specs"]);
      expect(await readFile(join(destinationDir, "openspec-sync-specs", "SKILL.md"), "utf8")).toBe(
        "the repository's own skill\n",
      );
      expect(await readFile(join(destinationDir, "composition-patterns", "SKILL.md"), "utf8")).toBe(
        "other skill\n",
      );
    });

    it("is a no-op (and creates no destination directory) when the template category doesn't exist yet", async () => {
      const { copyTemplatesSkippingCollisions } = await import("../../src/core/templates.js");

      const result = await copyTemplatesSkippingCollisions("skills", destinationDir);

      expect(result).toEqual({ written: [], skipped: [], blockedByNonDirectory: false });
      expect(existsSync(destinationDir)).toBe(false);
    });

    it("returns blockedByNonDirectory: true (and touches nothing) when the destination already exists as a file", async () => {
      const { copyTemplatesSkippingCollisions } = await import("../../src/core/templates.js");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, "workspace.md"), "workspace\n", "utf8");

      // destinationDir itself is a plain file, not a directory.
      await writeFile(destinationDir, "not a directory\n", "utf8");

      const result = await copyTemplatesSkippingCollisions("commands", destinationDir);

      expect(result).toEqual({ written: [], skipped: [], blockedByNonDirectory: true });
      expect(await readFile(destinationDir, "utf8")).toBe("not a directory\n");
    });
  });

  describe("sha256File / refreshTemplateFiles (the primitives behind `ce refresh`)", () => {
    it("sha256File is deterministic and content-sensitive", async () => {
      const { sha256File } = await import("../../src/core/templates.js");
      const filePath = join(destinationDir, "a.txt");
      await mkdir(destinationDir, { recursive: true });
      await writeFile(filePath, "hello\n", "utf8");

      const first = await sha256File(filePath);
      const second = await sha256File(filePath);
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{64}$/);

      await writeFile(filePath, "hello, world\n", "utf8");
      expect(await sha256File(filePath)).not.toBe(first);
    });

    it("writes a template entry fresh (reported `updated`) when the destination doesn't exist at all", async () => {
      const { refreshTemplateFiles, sha256File } = await import("../../src/core/templates.js");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, "verify.md"), "template content\n", "utf8");

      const result = await refreshTemplateFiles("commands", destinationDir, {});

      expect(result.updated).toEqual(["verify.md"]);
      expect(result.unchanged).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(await readFile(join(destinationDir, "verify.md"), "utf8")).toBe("template content\n");
      expect(result.hashes["verify.md"]).toBe(await sha256File(join(commandsDir, "verify.md")));
    });

    it("reports `unchanged` (and writes nothing) when the destination's content already matches the current template", async () => {
      const { refreshTemplateFiles } = await import("../../src/core/templates.js");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, "verify.md"), "same content\n", "utf8");
      await mkdir(destinationDir, { recursive: true });
      await writeFile(join(destinationDir, "verify.md"), "same content\n", "utf8");

      const result = await refreshTemplateFiles("commands", destinationDir, {});

      expect(result.unchanged).toEqual(["verify.md"]);
      expect(result.updated).toEqual([]);
      expect(result.skipped).toEqual([]);
    });

    it("overwrites (`updated`) when the destination's on-disk hash matches the caller-supplied known-good hash, even though it differs from the current template", async () => {
      const { refreshTemplateFiles, sha256File } = await import("../../src/core/templates.js");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdir(commandsDir, { recursive: true });
      await mkdir(destinationDir, { recursive: true });
      await writeFile(join(destinationDir, "verify.md"), "old (known-good) content\n", "utf8");
      const knownHash = await sha256File(join(destinationDir, "verify.md"));

      await writeFile(join(commandsDir, "verify.md"), "new template content\n", "utf8");

      const result = await refreshTemplateFiles("commands", destinationDir, { "verify.md": knownHash });

      expect(result.updated).toEqual(["verify.md"]);
      expect(await readFile(join(destinationDir, "verify.md"), "utf8")).toBe("new template content\n");
    });

    it("skips (leaves completely untouched) when the destination's on-disk content doesn't match any known-good hash", async () => {
      const { refreshTemplateFiles } = await import("../../src/core/templates.js");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, "verify.md"), "new template content\n", "utf8");
      await mkdir(destinationDir, { recursive: true });
      await writeFile(join(destinationDir, "verify.md"), "someone else's content entirely\n", "utf8");

      const result = await refreshTemplateFiles("commands", destinationDir, {
        "verify.md": "0".repeat(64), // an unrelated, non-matching hash
      });

      expect(result.skipped).toEqual(["verify.md"]);
      expect(result.updated).toEqual([]);
      expect(await readFile(join(destinationDir, "verify.md"), "utf8")).toBe(
        "someone else's content entirely\n",
      );
    });

    it("skips when there is no known-good hash for the entry at all, rather than guessing", async () => {
      const { refreshTemplateFiles } = await import("../../src/core/templates.js");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, "verify.md"), "new template content\n", "utf8");
      await mkdir(destinationDir, { recursive: true });
      await writeFile(join(destinationDir, "verify.md"), "pre-existing, unrelated content\n", "utf8");

      const result = await refreshTemplateFiles("commands", destinationDir, {});

      expect(result.skipped).toEqual(["verify.md"]);
      expect(await readFile(join(destinationDir, "verify.md"), "utf8")).toBe(
        "pre-existing, unrelated content\n",
      );
    });

    it("never inspects a nested directory entry (e.g. a skill folder) -- files only", async () => {
      const { refreshTemplateFiles } = await import("../../src/core/templates.js");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdir(join(commandsDir, "a-directory"), { recursive: true });
      await writeFile(join(commandsDir, "a-directory", "inner.md"), "inner\n", "utf8");
      await writeFile(join(commandsDir, "verify.md"), "template content\n", "utf8");

      const result = await refreshTemplateFiles("commands", destinationDir, {});

      expect(result.updated).toEqual(["verify.md"]);
      expect(existsSync(join(destinationDir, "a-directory"))).toBe(false);
    });

    it("is idempotent: running it again with the hashes it just returned reports everything unchanged", async () => {
      const { refreshTemplateFiles } = await import("../../src/core/templates.js");
      const commandsDir = join(fakeTemplatesRoot, "commands");
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, "verify.md"), "template content\n", "utf8");

      const first = await refreshTemplateFiles("commands", destinationDir, {});
      expect(first.updated).toEqual(["verify.md"]);

      const second = await refreshTemplateFiles("commands", destinationDir, first.hashes);
      expect(second.updated).toEqual([]);
      expect(second.skipped).toEqual([]);
      expect(second.unchanged).toEqual(["verify.md"]);
      expect(second.hashes).toEqual(first.hashes);
    });

    it("is a no-op (empty result) when the template category doesn't exist at all", async () => {
      const { refreshTemplateFiles } = await import("../../src/core/templates.js");

      const result = await refreshTemplateFiles("commands", destinationDir, {});

      expect(result).toEqual({ updated: [], unchanged: [], skipped: [], hashes: {} });
    });
  });

  describe("existsAsNonDirectory", () => {
    it("returns false for a path that does not exist at all", async () => {
      const { existsAsNonDirectory } = await import("../../src/core/templates.js");
      expect(existsAsNonDirectory(join(tempDir, "nope"))).toBe(false);
    });

    it("returns false for a path that exists as a directory", async () => {
      const { existsAsNonDirectory } = await import("../../src/core/templates.js");
      await mkdir(destinationDir, { recursive: true });
      expect(existsAsNonDirectory(destinationDir)).toBe(false);
    });

    it("returns true for a path that exists as a file", async () => {
      const { existsAsNonDirectory } = await import("../../src/core/templates.js");
      await writeFile(destinationDir, "a file\n", "utf8");
      expect(existsAsNonDirectory(destinationDir)).toBe(true);
    });
  });
});
