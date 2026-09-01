import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { createTempRepo } from "../helpers/tempRepo.js";
import { CeError } from "../../src/core/errors.js";
import {
  DEFAULT_TERMINAL_LAYOUT_PREFERENCE,
  TAB_COLOR_CONFIG_KEY,
  TERMINAL_LAYOUT_CONFIG_KEY,
  TERMINAL_LAYOUT_ENV_VAR,
  resolveTabColor,
  resolveTerminalLayoutPreference,
} from "../../src/core/terminalPreference.js";

describe("resolveTerminalLayoutPreference", () => {
  let repoDir: string;
  const originalEnvValue = process.env[TERMINAL_LAYOUT_ENV_VAR];

  beforeEach(async () => {
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    if (originalEnvValue === undefined) {
      delete process.env[TERMINAL_LAYOUT_ENV_VAR];
    } else {
      process.env[TERMINAL_LAYOUT_ENV_VAR] = originalEnvValue;
    }
    await rm(repoDir, { recursive: true, force: true });
  });

  it('defaults to "auto" when neither the env var nor Git config is set', async () => {
    delete process.env[TERMINAL_LAYOUT_ENV_VAR];
    await expect(resolveTerminalLayoutPreference(repoDir)).resolves.toBe(
      DEFAULT_TERMINAL_LAYOUT_PREFERENCE,
    );
    expect(DEFAULT_TERMINAL_LAYOUT_PREFERENCE).toBe("auto");
  });

  it("reads the Git config key when set", async () => {
    delete process.env[TERMINAL_LAYOUT_ENV_VAR];
    await execa("git", ["config", TERMINAL_LAYOUT_CONFIG_KEY, "none"], { cwd: repoDir });

    await expect(resolveTerminalLayoutPreference(repoDir)).resolves.toBe("none");
  });

  it("the env var takes precedence over the Git config key", async () => {
    await execa("git", ["config", TERMINAL_LAYOUT_CONFIG_KEY, "none"], { cwd: repoDir });
    process.env[TERMINAL_LAYOUT_ENV_VAR] = "iterm2";

    await expect(resolveTerminalLayoutPreference(repoDir)).resolves.toBe("iterm2");
  });

  it("throws a CeError for an invalid env var value", async () => {
    process.env[TERMINAL_LAYOUT_ENV_VAR] = "bogus";
    await expect(resolveTerminalLayoutPreference(repoDir)).rejects.toThrow(CeError);
  });

  it("throws a CeError for an invalid Git config value", async () => {
    delete process.env[TERMINAL_LAYOUT_ENV_VAR];
    await execa("git", ["config", TERMINAL_LAYOUT_CONFIG_KEY, "bogus"], { cwd: repoDir });

    await expect(resolveTerminalLayoutPreference(repoDir)).rejects.toThrow(CeError);
  });

  it("a globally configured preference applies when nothing is set locally", async () => {
    delete process.env[TERMINAL_LAYOUT_ENV_VAR];
    const globalConfigDir = await mkdtemp(join(tmpdir(), "ce-harness-global-gitconfig-"));
    const globalConfigFile = join(globalConfigDir, ".gitconfig");
    const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfigFile;
    try {
      await execa("git", ["config", "--global", TERMINAL_LAYOUT_CONFIG_KEY, "none"]);
      await expect(resolveTerminalLayoutPreference(repoDir)).resolves.toBe("none");
    } finally {
      if (originalGlobalConfig === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
      }
      await rm(globalConfigDir, { recursive: true, force: true });
    }
  });
});

describe("resolveTabColor", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns undefined when no tab color is configured", async () => {
    await expect(resolveTabColor(repoDir)).resolves.toBeUndefined();
  });

  it("returns the configured ce-harness.tab-color Git config value, unparsed", async () => {
    await execa("git", ["config", TAB_COLOR_CONFIG_KEY, "violet"], { cwd: repoDir });
    await expect(resolveTabColor(repoDir)).resolves.toBe("violet");
  });
});
