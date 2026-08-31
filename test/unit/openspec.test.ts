import { describe, expect, it } from "vitest";
import {
  setupFakeOpenSpec,
  teardownFakeOpenSpec,
  type FakeOpenSpecEnv,
} from "../helpers/fakeOpenSpec.js";

/** A "nothing went wrong at the process level" outcome -- override per test. */
function baseOutcome(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    status: [],
    stderr: "",
    rawStdout: "",
    failed: false,
    isTerminated: false,
    timedOut: false,
    isCanceled: false,
    isMaxBuffer: false,
    ...overrides,
  } as never;
}

describe("describeOpenSpecStatus", () => {
  it("prefers parsed status messages when present, ignoring exitCode/stdout entirely", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    const message = describeOpenSpecStatus(
      baseOutcome({
        status: [{ message: "Store 'x' is already registered." }],
        stderr: "some stderr noise",
        exitCode: 1,
        rawStdout: "{}",
      }),
    );
    expect(message).toBe("Store 'x' is already registered.");
  });

  it("falls back to stderr when no status messages are present", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    const message = describeOpenSpecStatus(
      baseOutcome({ stderr: "  boom: something went wrong  \n", exitCode: 1 }),
    );
    expect(message).toBe("boom: something went wrong");
  });

  it("reports exit code and 'stdout was empty' when neither status nor stderr is available", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    const message = describeOpenSpecStatus(baseOutcome({ exitCode: 17 }));
    expect(message).toContain("exit code 17");
    expect(message).toContain("stdout was empty");
  });

  it("includes the raw stdout content when present but unparseable/status-free", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    const message = describeOpenSpecStatus(
      baseOutcome({ exitCode: 9, rawStdout: "unexpected: not a JSON status payload" }),
    );
    expect(message).toContain("exit code 9");
    expect(message).toContain("raw stdout: unexpected: not a JSON status payload");
  });

  it("reports the terminating signal instead of an exit code when isTerminated is true", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    const message = describeOpenSpecStatus(
      baseOutcome({ exitCode: undefined, isTerminated: true, signal: "SIGKILL" }),
    );
    expect(message).toContain("terminated by signal SIGKILL");
    expect(message).not.toContain("exit code");
  });

  it("reports 'signal unknown' when isTerminated is true but no signal name was captured", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    const message = describeOpenSpecStatus(baseOutcome({ isTerminated: true }));
    expect(message).toContain("terminated by signal unknown");
  });

  it("never claims a signal termination just because exitCode is absent -- distinguishes a spawn failure (isTerminated: false) from a real one", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    // exitCode absent AND isTerminated false -- e.g. the process never
    // completed at all, as opposed to being killed by a signal. This is
    // exactly the ambiguity that previously mislabeled a real failure as
    // "terminated by signal unknown".
    const message = describeOpenSpecStatus(baseOutcome({ exitCode: undefined, isTerminated: false }));
    expect(message).not.toContain("terminated by signal");
    expect(message).toContain("not terminated by a signal");
  });

  it("reports a spawn-level failure (a real Node.js error code) ahead of the exit-code/stdout breakdown", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    const message = describeOpenSpecStatus(
      baseOutcome({
        failed: true,
        code: "ENOENT",
        execaMessage: "spawn openspec ENOENT",
        rawStdout: "should not appear -- code takes priority",
      }),
    );
    expect(message).toContain("ENOENT");
    expect(message).toContain("spawn openspec ENOENT");
    expect(message).not.toContain("should not appear");
  });

  it("does NOT let an ordinary non-zero exit's execaMessage (set by execa for any failure) shadow the raw stdout breakdown", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    // execa sets `shortMessage` ("Command failed with exit code N: ...")
    // for ANY non-zero exit, not just spawn failures -- `code` (absent
    // here) is what actually distinguishes "never ran" from "ran and
    // exited badly". Without `code`, the more specific exit-code/stdout
    // breakdown must still win.
    const message = describeOpenSpecStatus(
      baseOutcome({
        exitCode: 17,
        execaMessage: "Command failed with exit code 17: openspec store setup ...",
        rawStdout: "some raw diagnostic content",
      }),
    );
    expect(message).toContain("exit code 17");
    expect(message).toContain("raw stdout: some raw diagnostic content");
  });

  it("reports a timeout distinctly", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    const message = describeOpenSpecStatus(baseOutcome({ timedOut: true }));
    expect(message).toMatch(/timeout/i);
  });

  it("reports a cancellation distinctly", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    const message = describeOpenSpecStatus(baseOutcome({ isCanceled: true }));
    expect(message).toMatch(/cancel/i);
  });

  it("reports a maxBuffer overflow distinctly", async () => {
    const { describeOpenSpecStatus } = await import("../../src/core/openspec.js");
    const message = describeOpenSpecStatus(baseOutcome({ isMaxBuffer: true }));
    expect(message).toMatch(/buffer/i);
  });
});

describe("setupStore/storeDoctor/unregisterStore -- exitCode/rawStdout wiring (real child process)", () => {
  let fakeOpenSpec: FakeOpenSpecEnv;

  async function withFakeOpenSpec<T>(fn: () => Promise<T>): Promise<T> {
    fakeOpenSpec = await setupFakeOpenSpec();
    try {
      return await fn();
    } finally {
      await teardownFakeOpenSpec(fakeOpenSpec);
    }
  }

  it("setupStore captures exitCode and empty rawStdout for a silently-crashed process (no stdout, no stderr)", async () => {
    await withFakeOpenSpec(async () => {
      process.env.FAKE_OPENSPEC_SILENT_CRASH = "1";
      const { setupStore, describeOpenSpecStatus } = await import("../../src/core/openspec.js");

      const result = await setupStore("/tmp", "ce-test-silent-crash", "/tmp/does-not-matter");

      expect(result.success).toBe(false);
      expect(result.status).toEqual([]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(17);
      expect(result.rawStdout).toBe("");

      const message = describeOpenSpecStatus(result);
      expect(message).toContain("exit code 17");
      expect(message).toContain("stdout was empty");
    });
  });

  it("setupStore captures exitCode and rawStdout for a process that exits with garbage, non-JSON stdout", async () => {
    await withFakeOpenSpec(async () => {
      process.env.FAKE_OPENSPEC_GARBAGE_STDOUT = "1";
      const { setupStore, describeOpenSpecStatus } = await import("../../src/core/openspec.js");

      const result = await setupStore("/tmp", "ce-test-garbage-stdout", "/tmp/does-not-matter");

      expect(result.success).toBe(false);
      expect(result.status).toEqual([]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(9);
      expect(result.rawStdout).toContain("unexpected: not a JSON status payload");

      const message = describeOpenSpecStatus(result);
      expect(message).toContain("exit code 9");
      expect(message).toContain("raw stdout: unexpected: not a JSON status payload");
    });
  });

  it("storeDoctor and unregisterStore wire the same exitCode/rawStdout fields through", async () => {
    await withFakeOpenSpec(async () => {
      process.env.FAKE_OPENSPEC_SILENT_CRASH = "1";
      const { storeDoctor, unregisterStore } = await import("../../src/core/openspec.js");

      const doctorResult = await storeDoctor("/tmp", "ce-test-silent-crash");
      expect(doctorResult.found).toBe(false);
      expect(doctorResult.exitCode).toBe(17);
      expect(doctorResult.rawStdout).toBe("");

      const unregisterResult = await unregisterStore("/tmp", "ce-test-silent-crash");
      expect(unregisterResult.success).toBe(false);
      expect(unregisterResult.exitCode).toBe(17);
      expect(unregisterResult.rawStdout).toBe("");
    });
  });

  it("existing parsed-status/stderr failure messages are byte-for-byte unchanged (FAKE_OPENSPEC_FAIL_SETUP)", async () => {
    await withFakeOpenSpec(async () => {
      process.env.FAKE_OPENSPEC_FAIL_SETUP = "1";
      const { setupStore, describeOpenSpecStatus } = await import("../../src/core/openspec.js");

      const result = await setupStore("/tmp", "ce-test-fail-setup", "/tmp/does-not-matter");

      expect(result.success).toBe(false);
      // The fixture's FAKE_OPENSPEC_FAIL_SETUP path always returns a real
      // status message -- describeOpenSpecStatus must still prefer it,
      // exactly as before this change, even though exitCode/rawStdout are
      // now also present on the result.
      expect(describeOpenSpecStatus(result)).toBe("Simulated setup failure for testing.");
    });
  });

  it("a healthy success path is completely unaffected: setupStore still reports success with no message needed", async () => {
    await withFakeOpenSpec(async () => {
      const { setupStore } = await import("../../src/core/openspec.js");
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const dir = await mkdtemp(join(tmpdir(), "ce-harness-openspec-success-"));
      const result = await setupStore(dir, "ce-test-success", join(dir, "store"));

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.storeId).toBe("ce-test-success");
    });
  });
});
