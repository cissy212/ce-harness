import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR,
  VSCODE,
  formatOpenCommand,
  openInEditor,
} from "../../src/core/editor.js";
import {
  nonExistentEditorBin,
  setupFakeEditor,
  teardownFakeEditor,
  type FakeEditorEnv,
} from "../helpers/fakeEditor.js";

describe("editor (ce open's launch mechanism)", () => {
  let fakeEditor: FakeEditorEnv;

  beforeEach(async () => {
    fakeEditor = await setupFakeEditor();
  });

  afterEach(async () => {
    await teardownFakeEditor(fakeEditor);
  });

  it("defaults to VS Code", () => {
    expect(DEFAULT_EDITOR).toBe(VSCODE);
    expect(DEFAULT_EDITOR.id).toBe("vscode");
    expect(DEFAULT_EDITOR.label).toBe("VS Code");
  });

  it("invokes the editor binary with exactly the path as its argument", async () => {
    const result = await openInEditor("/some/worktree/path");
    expect(result.opened).toBe(true);

    const recorded = JSON.parse(await readFile(fakeEditor.outputFile, "utf8"));
    expect(recorded.argv).toEqual(["/some/worktree/path"]);
  });

  it("CE_EDITOR_BIN overrides the resolved binary (covers code-compatible forks with no code change)", () => {
    process.env.CE_EDITOR_BIN = "cursor";
    expect(VSCODE.binary()).toBe("cursor");
    delete process.env.CE_EDITOR_BIN;
    expect(VSCODE.binary()).toBe("code");
  });

  it("reports a non-zero exit code as opened: false, with a message", async () => {
    process.env.FAKE_EDITOR_EXIT_CODE = "1";
    process.env.FAKE_EDITOR_STDERR = "something went wrong\n";

    const result = await openInEditor("/some/path");
    expect(result.opened).toBe(false);
    if (!result.opened) {
      expect(result.message).toMatch(/something went wrong/);
    }
  });

  it("reports a missing executable as opened: false, never throws", async () => {
    process.env.CE_EDITOR_BIN = nonExistentEditorBin(fakeEditor.dir);

    const result = await openInEditor("/some/path");
    expect(result.opened).toBe(false);
  });

  it("never inherits stdio -- fire-and-forget, unlike launchOpenCode", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/core/editor.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/stdio:\s*["']inherit["']/);
  });

  it("formatOpenCommand renders the exact manual-recovery command", () => {
    delete process.env.CE_EDITOR_BIN;
    expect(formatOpenCommand("/some/worktree/path")).toBe('code "/some/worktree/path"');
  });
});
