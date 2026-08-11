import { execa } from "execa";

/**
 * Editor integration for `ce open`: this is the only module that shells
 * out to a code editor's CLI. Deliberately editor-agnostic in shape --
 * an `EditorSpec` plus a single `openInEditor(path, spec)` function --
 * so a second editor is a new `EditorSpec` entry plus a selection point,
 * never a rewrite of the launch mechanism itself. Only VS Code is wired
 * up today (the only one requested), but nothing here assumes "code" is
 * the only possible editor CLI.
 *
 * Unlike `launchOpenCode` (which hands the terminal over to a long-running,
 * interactive process), an editor CLI like `code <path>` is fire-and-forget:
 * it asks the editor (already running, or newly spawned) to open the path
 * and returns immediately. This never inherits stdio for that reason --
 * there is no interactive session to hand the terminal to.
 */

export interface EditorSpec {
  /** Short, stable identifier (e.g. "vscode"). */
  id: string;
  /** Human-readable name for messages (e.g. "VS Code"). */
  label: string;
  /** Resolves the executable to invoke for this editor. Overridable for tests. */
  binary: () => string;
}

/**
 * VS Code, via its `code` CLI. `CE_EDITOR_BIN` overrides the binary --
 * this already covers `code`-compatible forks (e.g. VSCodium, Cursor's
 * own `cursor` CLI, "code-insiders") without any code change, since they
 * accept the same `<binary> <path>` invocation.
 */
export const VSCODE: EditorSpec = {
  id: "vscode",
  label: "VS Code",
  binary: () =>
    process.env.CE_EDITOR_BIN && process.env.CE_EDITOR_BIN.length > 0
      ? process.env.CE_EDITOR_BIN
      : "code",
};

/** The editor `ce open` uses when none is otherwise specified. */
export const DEFAULT_EDITOR: EditorSpec = VSCODE;

export type OpenInEditorResult = { opened: true } | { opened: false; message: string };

/**
 * Asks `editor` to open `path`. Never throws: a spawn failure (e.g. the
 * executable is missing) or a non-zero exit is reported as
 * `{ opened: false, message }` rather than an exception, so callers can
 * produce their own actionable error.
 */
export async function openInEditor(
  path: string,
  editor: EditorSpec = DEFAULT_EDITOR,
): Promise<OpenInEditorResult> {
  const result = await execa(editor.binary(), [path], { reject: false });

  if (typeof result.exitCode !== "number") {
    return {
      opened: false,
      message: result.shortMessage ?? result.message ?? `${editor.label} could not be launched.`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      opened: false,
      message: result.stderr.trim() || `${editor.label} exited with code ${result.exitCode}.`,
    };
  }
  return { opened: true };
}

/** Renders the exact command line `openInEditor` would run, for recovery messages. */
export function formatOpenCommand(path: string, editor: EditorSpec = DEFAULT_EDITOR): string {
  return `${editor.binary()} "${path}"`;
}
