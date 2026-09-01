import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  buildTwoPaneScript,
  isITerm2Available,
  openTwoPaneWorkspace,
  parseTabColor,
} from "../../src/core/terminal/iterm2.js";
import {
  nonExistentOsascriptBin,
  setupFakeOsascript,
  teardownFakeOsascript,
  type FakeOsascriptEnv,
} from "../helpers/fakeOsascript.js";

describe("buildTwoPaneScript (pure -- no osascript invocation)", () => {
  it("cds into the worktree and exports every left-pane env var in the left pane", () => {
    const script = buildTwoPaneScript({
      worktreePath: "/repos/my project/worktree",
      leftEnv: { CE_WORKSPACE: "/ws", CE_ISSUE: "130" },
      rightCommand: "cd /worktree && claude",
      title: "MAT · 130",
    });

    expect(script).toContain('cd \\"/repos/my project/worktree\\"');
    expect(script).toContain("export CE_WORKSPACE=\\\"/ws\\\"");
    expect(script).toContain("export CE_ISSUE=\\\"130\\\"");
  });

  it("splits vertically (side-by-side panes) and writes the exact right-pane command into the split", () => {
    const script = buildTwoPaneScript({
      worktreePath: "/worktree",
      leftEnv: {},
      rightCommand: 'cd "/worktree" && CE_ISSUE="130" claude',
      title: "MAT · 130",
    });

    expect(script).toContain("split vertically");
    expect(script).toContain("tell rightPane");
    expect(script).toContain(appleScriptEscapedContains('cd "/worktree" && CE_ISSUE="130" claude'));
  });

  it("escapes double quotes and backslashes in every written string so the script stays syntactically valid AppleScript", () => {
    const script = buildTwoPaneScript({
      worktreePath: '/weird"path',
      leftEnv: {},
      rightCommand: 'echo "hi" && echo \\done',
      title: 'weird "title"',
    });

    // Every embedded double quote (in a `write text`/`set name to` line)
    // must be escaped, never left bare (which would prematurely
    // terminate the AppleScript string literal).
    const quotedLines = script
      .split("\n")
      .filter((line) => line.includes("write text") || line.includes("set name to"));
    for (const line of quotedLines) {
      const inner = line.replace(/^\s*(write text|set name to) "/, "").replace(/"\s*$/, "");
      expect(inner.match(/(?<!\\)"/g)).toBeNull();
    }
  });

  it("produces no left-pane export line when leftEnv is empty", () => {
    const script = buildTwoPaneScript({
      worktreePath: "/worktree",
      leftEnv: {},
      rightCommand: "claude",
      title: "MAT · 130",
    });
    expect(script).not.toContain("export ");
  });

  it("sets both panes' names to the given title", () => {
    const script = buildTwoPaneScript({
      worktreePath: "/worktree",
      leftEnv: {},
      rightCommand: "claude",
      title: "MAT · 130",
    });

    const setNameLines = script.split("\n").filter((line) => line.includes("set name to"));
    expect(setNameLines).toHaveLength(2);
    for (const line of setNameLines) {
      expect(line).toContain("MAT");
      expect(line).toContain("130");
    }
  });

  it("creates a new tab in the current window when one exists, and only creates a window when none does -- never both, never reusing/splitting an existing tab", () => {
    const script = buildTwoPaneScript({
      worktreePath: "/worktree",
      leftEnv: {},
      rightCommand: "claude",
      title: "MAT · 130",
    });

    expect(script).toContain("if (count of windows) > 0 then");
    expect(script).toContain("tell current window");
    expect(script).toContain("create tab with default profile");
    expect(script).toContain("else");
    expect(script).toContain("create window with default profile");
    expect(script).toContain("set newTab to current tab");
  });

  it("always uses iTerm2's default profile -- ce-harness never creates or selects a named profile", () => {
    const script = buildTwoPaneScript({
      worktreePath: "/worktree",
      leftEnv: {},
      rightCommand: "claude",
      title: "MAT · 130",
    });

    const defaultProfileUses = script.match(/with default profile/g) ?? [];
    // create tab, create window (mutually exclusive branches -- both
    // present in source even though only one runs), and split vertically.
    expect(defaultProfileUses.length).toBe(3);
    expect(script).not.toMatch(/with profile "/);
  });

  it("produces no tab-color escape sequence in the left pane's command when tabColor is not set", () => {
    const script = buildTwoPaneScript({
      worktreePath: "/worktree",
      leftEnv: {},
      rightCommand: "claude",
      title: "MAT · 130",
    });

    expect(script).not.toContain("printf");
    expect(script).not.toContain("6;1;bg;red");
  });

  it("prepends the iTerm2 tab-color escape sequence to the left pane's command when tabColor is set", () => {
    const script = buildTwoPaneScript({
      worktreePath: "/worktree",
      leftEnv: {},
      rightCommand: "claude",
      tabColor: { r: 138, g: 43, b: 226 },
      title: "MAT · 130",
    });

    expect(script).toContain("printf");
    expect(script).toContain("6;1;bg;red;brightness;%d");
    expect(script).toContain("6;1;bg;green;brightness;%d");
    expect(script).toContain("6;1;bg;blue;brightness;%d");
    expect(script).toContain("138 43 226");
    // Only the left pane gets colored -- the right pane's command
    // (the runner-launch command) must never be touched.
    const rightPaneCommandLine = script
      .split("\n")
      .filter((line) => line.includes("write text"))
      .at(-1);
    expect(rightPaneCommandLine).not.toContain("printf");
  });
});

describe("parseTabColor", () => {
  it("returns undefined for undefined/empty/whitespace-only values", () => {
    expect(parseTabColor(undefined)).toBeUndefined();
    expect(parseTabColor("")).toBeUndefined();
    expect(parseTabColor("   ")).toBeUndefined();
  });

  it("resolves recognized color names, case-insensitively", () => {
    expect(parseTabColor("blue")).toEqual({ r: 0, g: 122, b: 255 });
    expect(parseTabColor("BLUE")).toEqual({ r: 0, g: 122, b: 255 });
    expect(parseTabColor("Violet")).toEqual({ r: 138, g: 43, b: 226 });
    expect(parseTabColor("green")).toEqual({ r: 52, g: 199, b: 89 });
  });

  it("resolves a #RRGGBB hex value", () => {
    expect(parseTabColor("#8A2BE2")).toEqual({ r: 138, g: 43, b: 226 });
  });

  it("resolves a bare RRGGBB hex value (no leading #)", () => {
    expect(parseTabColor("8A2BE2")).toEqual({ r: 138, g: 43, b: 226 });
  });

  it("resolves a shorthand #RGB hex value", () => {
    expect(parseTabColor("#0f0")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("returns undefined for an unrecognized name or malformed value, never throwing", () => {
    expect(parseTabColor("chartreuse-ish")).toBeUndefined();
    expect(parseTabColor("#12345")).toBeUndefined();
    expect(parseTabColor("not-a-color")).toBeUndefined();
  });
});

function appleScriptEscapedContains(shellCommand: string): string {
  return shellCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

describe("isITerm2Available / openTwoPaneWorkspace (against a fake osascript -- never real AppleScript)", () => {
  let fakeOsascript: FakeOsascriptEnv;

  beforeEach(async () => {
    fakeOsascript = await setupFakeOsascript();
  });

  afterEach(async () => {
    await teardownFakeOsascript(fakeOsascript);
  });

  it("isITerm2Available() is true when the availability probe exits 0", async () => {
    await expect(isITerm2Available()).resolves.toBe(true);
  });

  it("isITerm2Available() is false when the availability probe exits non-zero", async () => {
    process.env.FAKE_OSASCRIPT_PROBE_EXIT_CODE = "1";
    await expect(isITerm2Available()).resolves.toBe(false);
  });

  it("isITerm2Available() is false when the osascript binary does not exist at all", async () => {
    process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();
    await expect(isITerm2Available()).resolves.toBe(false);
  });

  it("openTwoPaneWorkspace() reports opened:true and runs osascript with the built script on success", async () => {
    const result = await openTwoPaneWorkspace({
      worktreePath: "/worktree",
      leftEnv: { CE_ISSUE: "130" },
      rightCommand: "claude",
      tabColor: { r: 138, g: 43, b: 226 },
      title: "MAT · 130",
    });

    expect(result).toEqual({ opened: true });
    const recorded = JSON.parse(await readFile(fakeOsascript.outputFile, "utf8"));
    expect(recorded.argv[0]).toBe("-e");
    expect(recorded.argv[1]).toContain("CE_ISSUE");
    expect(recorded.argv[1]).toContain("6;1;bg;red;brightness;%d");
    expect(recorded.argv[1]).toContain("138 43 226");
    expect(recorded.argv[1]).toContain("MAT · 130");
  });

  it("openTwoPaneWorkspace() reports opened:false with osascript's stderr on failure, never throwing", async () => {
    process.env.FAKE_OSASCRIPT_EXIT_CODE = "1";
    process.env.FAKE_OSASCRIPT_STDERR = "Not authorized to send Apple events to iTerm2.";

    const result = await openTwoPaneWorkspace({
      worktreePath: "/worktree",
      leftEnv: {},
      rightCommand: "claude",
      title: "MAT · 130",
    });

    expect(result).toEqual({
      opened: false,
      message: "Not authorized to send Apple events to iTerm2.",
    });
  });

  it("openTwoPaneWorkspace() reports opened:false, never throwing, when the osascript binary does not exist", async () => {
    process.env.CE_OSASCRIPT_BIN = nonExistentOsascriptBin();

    const result = await openTwoPaneWorkspace({
      worktreePath: "/worktree",
      leftEnv: {},
      rightCommand: "claude",
      title: "MAT · 130",
    });

    expect(result.opened).toBe(false);
  });
});
