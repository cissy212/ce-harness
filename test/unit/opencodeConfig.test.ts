import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenCodeConfig,
  expectedOpenCodeConfigDir,
  openCodeConfigExists,
} from "../../src/core/opencodeConfig.js";
import { templatesRoot } from "../../src/core/templates.js";

describe("opencodeConfig", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "ce-harness-opencode-config-"));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("expectedOpenCodeConfigDir is always <workspacePath>/opencode", () => {
    expect(expectedOpenCodeConfigDir(workspacePath)).toBe(join(workspacePath, "opencode"));
    expect(expectedOpenCodeConfigDir("/home/user/.ce-harness/workspaces/demo/issue-1")).toBe(
      "/home/user/.ce-harness/workspaces/demo/issue-1/opencode",
    );
  });

  it("openCodeConfigExists is false before creation", () => {
    expect(openCodeConfigExists(workspacePath)).toBe(false);
  });

  it("createOpenCodeConfig creates commands/skills/agents/prompts and nothing else unexpected", async () => {
    const configDir = await createOpenCodeConfig(workspacePath);

    expect(configDir).toBe(expectedOpenCodeConfigDir(workspacePath));
    expect(existsSync(join(configDir, "commands"))).toBe(true);
    expect(existsSync(join(configDir, "skills"))).toBe(true);
    expect(existsSync(join(configDir, "agents"))).toBe(true);
    expect(existsSync(join(configDir, "prompts"))).toBe(true);

    const { readdir } = await import("node:fs/promises");
    const entries = (await readdir(configDir)).sort();
    expect(entries).toEqual(["agents", "commands", "prompts", "skills"]);
  });

  it("openCodeConfigExists is true after creation", async () => {
    await createOpenCodeConfig(workspacePath);
    expect(openCodeConfigExists(workspacePath)).toBe(true);
  });

  it("is idempotent (safe to call twice)", async () => {
    await createOpenCodeConfig(workspacePath);
    await expect(createOpenCodeConfig(workspacePath)).resolves.toBe(
      expectedOpenCodeConfigDir(workspacePath),
    );
  });

  it("populates commands/ from the harness's real templates/commands/ library, byte-for-byte", async () => {
    const configDir = await createOpenCodeConfig(workspacePath);

    const copiedPath = join(configDir, "commands", "workspace.md");
    const sourcePath = join(templatesRoot(), "commands", "workspace.md");
    expect(existsSync(copiedPath)).toBe(true);
    expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
  });

  it("populates skills/ recursively from the harness's real templates/skills/ library, byte-for-byte", async () => {
    const configDir = await createOpenCodeConfig(workspacePath);

    const copiedPath = join(configDir, "skills", "openspec-sync-specs", "SKILL.md");
    const sourcePath = join(templatesRoot(), "skills", "openspec-sync-specs", "SKILL.md");
    expect(existsSync(copiedPath)).toBe(true);
    expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
  });

  it("populates agents/ (OpenCode's own folder name) from the harness's real templates/lenses/ library, byte-for-byte", async () => {
    const configDir = await createOpenCodeConfig(workspacePath);

    for (const filename of [
      "backend-developer.md",
      "pipeline-data-engineer.md",
      "frontend-developer.md",
      "accessibility-reviewer.md",
      "typescript-engineer.md",
      "security-reviewer.md",
    ]) {
      const copiedPath = join(configDir, "agents", filename);
      const sourcePath = join(templatesRoot(), "lenses", filename);
      expect(existsSync(copiedPath)).toBe(true);
      expect(await readFile(copiedPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
    }
  });
});
