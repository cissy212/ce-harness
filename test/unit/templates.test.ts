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
});
