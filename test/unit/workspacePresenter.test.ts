import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { execa } from "execa";
import { createTempRepo } from "../helpers/tempRepo.js";
import {
  nonExistentOsascriptBin,
  setupFakeOsascript,
  teardownFakeOsascript,
  type FakeOsascriptEnv,
} from "../helpers/fakeOsascript.js";
import { TAB_COLOR_CONFIG_KEY, TERMINAL_LAYOUT_ENV_VAR } from "../../src/core/terminalPreference.js";
import type { RunnerLaunchResult, RunnerSpec } from "../../src/core/runners/types.js";
import type { PresentAndLaunchOptions } from "../../src/core/workspacePresenter.js";

function fakeRunner(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    id: "fake",
    label: "Fake Runner",
    binary: () => "fake-runner",
    writeConfig: async () => [],
    refreshConfig: async () => ({ result: { updated: [], unchanged: [], skipped: [] }, commandsManaged: [], commandsManagedHashes: {} }),
    writeCodeGraphConfig: async () => false,
    buildEnv: () => ({}),
    managedWorktreeRelativePaths: () => [],
    launch: vi.fn(async (): Promise<RunnerLaunchResult> => ({ launched: true, exitCode: 0 })),
    formatLaunchCommand: (cwd, env) =>
      `cd "${cwd}" && ${Object.entries(env).map(([k, v]) => `${k}="${v}"`).join(" ")} fake-runner`,
    ...overrides,
  };
}

const DEFAULTS: Pick<PresentAndLaunchOptions, "worktreePath" | "launchFailureRecoveryIntro" | "project" | "issue"> = {
  worktreePath: "/worktree",
  launchFailureRecoveryIntro: "Enter the workspace manually with:",
  project: "market-audit-tool",
  issue: "130",
};

describe("presentAndLaunch", () => {
  let repoDir: string;
  const originalPreference = process.env[TERMINAL_LAYOUT_ENV_VAR];

  beforeEach(async () => {
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    if (originalPreference === undefined) {
      delete process.env[TERMINAL_LAYOUT_ENV_VAR];
    } else {
      process.env[TERMINAL_LAYOUT_ENV_VAR] = originalPreference;
    }
    await rm(repoDir, { recursive: true, force: true });
  });

  it('preference "none": launches the runner directly and never touches osascript', async () => {
    process.env[TERMINAL_LAYOUT_ENV_VAR] = "none";
    process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();
    const { presentAndLaunch } = await import("../../src/core/workspacePresenter.js");
    const runner = fakeRunner();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await presentAndLaunch({ ...DEFAULTS, repoPath: repoDir, runner, launchEnv: {} });

    expect(runner.launch).toHaveBeenCalledTimes(1);
  });

  it('preference "auto" with iTerm2 unavailable: falls back to a direct launch, printing worktree + relaunch command', async () => {
    process.env[TERMINAL_LAYOUT_ENV_VAR] = "auto";
    process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();
    const { presentAndLaunch } = await import("../../src/core/workspacePresenter.js");
    const runner = fakeRunner();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await presentAndLaunch({ ...DEFAULTS, repoPath: repoDir, runner, launchEnv: { CE_ISSUE: "130" } });

    expect(runner.launch).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("/worktree");
    expect(output).toContain("fake-runner");
  });

  describe("with a fake osascript reporting iTerm2 available", () => {
    let fakeOsascript: FakeOsascriptEnv;
    const originalPlatform = process.platform;

    beforeEach(async () => {
      fakeOsascript = await setupFakeOsascript();
      Object.defineProperty(process, "platform", { value: "darwin" });
    });

    afterEach(async () => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      await teardownFakeOsascript(fakeOsascript);
    });

    it('preference "auto" + iTerm2 available + open succeeds: opens the layout and never calls runner.launch', async () => {
      process.env[TERMINAL_LAYOUT_ENV_VAR] = "auto";
      const { presentAndLaunch } = await import("../../src/core/workspacePresenter.js");
      const runner = fakeRunner();
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await presentAndLaunch({ ...DEFAULTS, repoPath: repoDir, runner, launchEnv: {} });

      expect(runner.launch).not.toHaveBeenCalled();
    });

    it("open succeeding writes the runner's exact formatLaunchCommand() into the right pane via osascript", async () => {
      process.env[TERMINAL_LAYOUT_ENV_VAR] = "iterm2";
      const { presentAndLaunch } = await import("../../src/core/workspacePresenter.js");
      const runner = fakeRunner();
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await presentAndLaunch({ ...DEFAULTS, repoPath: repoDir, runner, launchEnv: { CE_ISSUE: "130" } });

      const { readFile } = await import("node:fs/promises");
      const recorded = JSON.parse(await readFile(fakeOsascript.outputFile, "utf8"));
      expect(recorded.argv[1]).toContain("fake-runner");
      expect(recorded.argv[1]).toContain("CE_ISSUE");
    });

    it("no tab color configured: opens with iTerm2's default profile, no color escape sequence, and titles the tab \"<project> · <issue>\"", async () => {
      process.env[TERMINAL_LAYOUT_ENV_VAR] = "iterm2";
      const { presentAndLaunch } = await import("../../src/core/workspacePresenter.js");
      const runner = fakeRunner();
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await presentAndLaunch({ ...DEFAULTS, repoPath: repoDir, runner, launchEnv: {} });

      const { readFile } = await import("node:fs/promises");
      const recorded = JSON.parse(await readFile(fakeOsascript.outputFile, "utf8"));
      expect(recorded.argv[1]).toContain("with default profile");
      expect(recorded.argv[1]).not.toMatch(/with profile "/);
      expect(recorded.argv[1]).not.toContain("printf");
      expect(recorded.argv[1]).toContain("market-audit-tool · 130");
    });

    it("ce-harness.tab-color configured with a named color: applies the tab-color escape sequence, title still \"<project> · <issue>\"", async () => {
      await execa("git", ["config", TAB_COLOR_CONFIG_KEY, "violet"], { cwd: repoDir });
      process.env[TERMINAL_LAYOUT_ENV_VAR] = "iterm2";
      const { presentAndLaunch } = await import("../../src/core/workspacePresenter.js");
      const runner = fakeRunner();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await presentAndLaunch({ ...DEFAULTS, repoPath: repoDir, runner, launchEnv: {} });

      const { readFile } = await import("node:fs/promises");
      const recorded = JSON.parse(await readFile(fakeOsascript.outputFile, "utf8"));
      expect(recorded.argv[1]).toContain("6;1;bg;red;brightness;%d");
      expect(recorded.argv[1]).toContain("138 43 226");
      expect(recorded.argv[1]).toContain("market-audit-tool · 130");

      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain('Opened iTerm2 tab "market-audit-tool · 130"');
    });

    it("ce-harness.tab-color configured with an unrecognized value: warns and proceeds without a color, never blocking the launch", async () => {
      await execa("git", ["config", TAB_COLOR_CONFIG_KEY, "not-a-real-color"], { cwd: repoDir });
      process.env[TERMINAL_LAYOUT_ENV_VAR] = "iterm2";
      const { presentAndLaunch } = await import("../../src/core/workspacePresenter.js");
      const runner = fakeRunner();
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await presentAndLaunch({ ...DEFAULTS, repoPath: repoDir, runner, launchEnv: {} });

      const { readFile } = await import("node:fs/promises");
      const recorded = JSON.parse(await readFile(fakeOsascript.outputFile, "utf8"));
      expect(recorded.argv[1]).not.toContain("printf");

      const errorOutput = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(errorOutput).toContain('Ignoring unrecognized "not-a-real-color"');
    });

    it("a review workspace's issue (review-pr-452) produces a title that makes the review identity clear", async () => {
      process.env[TERMINAL_LAYOUT_ENV_VAR] = "iterm2";
      const { presentAndLaunch } = await import("../../src/core/workspacePresenter.js");
      const runner = fakeRunner();
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await presentAndLaunch({
        ...DEFAULTS,
        repoPath: repoDir,
        runner,
        launchEnv: {},
        issue: "review-pr-452",
      });

      const { readFile } = await import("node:fs/promises");
      const recorded = JSON.parse(await readFile(fakeOsascript.outputFile, "utf8"));
      expect(recorded.argv[1]).toContain("market-audit-tool · review-pr-452");
    });

    it("automation failing (non-zero osascript exit) still falls back to a direct launch, never leaving the runner unlaunched", async () => {
      process.env[TERMINAL_LAYOUT_ENV_VAR] = "iterm2";
      process.env.FAKE_OSASCRIPT_EXIT_CODE = "1";
      process.env.FAKE_OSASCRIPT_STDERR = "Not authorized to send Apple events to iTerm2.";
      const { presentAndLaunch } = await import("../../src/core/workspacePresenter.js");
      const runner = fakeRunner();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await presentAndLaunch({ ...DEFAULTS, repoPath: repoDir, runner, launchEnv: {} });

      expect(runner.launch).toHaveBeenCalledTimes(1);
      const errorOutput = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(errorOutput).toMatch(/Not authorized to send Apple events/);
      const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("/worktree");
    });
  });

  it("throws a CeError, workspace untouched, when the direct-launch fallback itself fails to launch", async () => {
    process.env[TERMINAL_LAYOUT_ENV_VAR] = "none";
    const { presentAndLaunch } = await import("../../src/core/workspacePresenter.js");
    const { CeError } = await import("../../src/core/errors.js");
    const runner = fakeRunner({
      launch: vi.fn(async (): Promise<RunnerLaunchResult> => ({ launched: false, message: "boom" })),
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      presentAndLaunch({ ...DEFAULTS, repoPath: repoDir, runner, launchEnv: {} }),
    ).rejects.toThrow(CeError);
  });
});
