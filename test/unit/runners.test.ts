import { describe, expect, it } from "vitest";
import { DEFAULT_RUNNER_ID, resolveRunner, supportedRunnerIds } from "../../src/core/runners/index.js";
import { CeError } from "../../src/core/errors.js";

describe("runner registry (resolveRunner)", () => {
  it('DEFAULT_RUNNER_ID is "opencode"', () => {
    expect(DEFAULT_RUNNER_ID).toBe("opencode");
  });

  it("supportedRunnerIds lists exactly opencode and claude", () => {
    expect(supportedRunnerIds().sort()).toEqual(["claude", "opencode"]);
  });

  it('resolveRunner(undefined) resolves to the OpenCode runner -- backward-compatible default', () => {
    const runner = resolveRunner(undefined);
    expect(runner.id).toBe("opencode");
    expect(runner.label).toBe("OpenCode");
  });

  it('resolveRunner("opencode") resolves to the OpenCode runner', () => {
    const runner = resolveRunner("opencode");
    expect(runner.id).toBe("opencode");
  });

  it('resolveRunner("claude") resolves to the Claude Code runner', () => {
    const runner = resolveRunner("claude");
    expect(runner.id).toBe("claude");
    expect(runner.label).toBe("Claude Code");
  });

  it("resolveRunner throws a CeError listing supported runner ids for an unknown runner", () => {
    try {
      resolveRunner("cursor");
      expect.fail("expected resolveRunner to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CeError);
      const ceError = error as InstanceType<typeof CeError>;
      expect(ceError.message).toMatch(/Unknown runner "cursor"/);
      expect(ceError.recovery).toMatch(/Supported runners:/);
      expect(ceError.recovery).toContain("opencode");
      expect(ceError.recovery).toContain("claude");
    }
  });

  it("every registered runner implements the full RunnerSpec surface", () => {
    for (const id of supportedRunnerIds()) {
      const runner = resolveRunner(id);
      expect(typeof runner.id).toBe("string");
      expect(typeof runner.label).toBe("string");
      expect(typeof runner.binary).toBe("function");
      expect(typeof runner.writeConfig).toBe("function");
      expect(typeof runner.writeCodeGraphConfig).toBe("function");
      expect(typeof runner.buildEnv).toBe("function");
      expect(typeof runner.managedWorktreeRelativePaths).toBe("function");
      expect(typeof runner.launch).toBe("function");
      expect(typeof runner.formatLaunchCommand).toBe("function");
    }
  });
});
