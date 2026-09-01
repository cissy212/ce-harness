import { execa } from "execa";

/**
 * iTerm2 desktop presentation: opens a new iTerm2 window split into two
 * panes -- left a plain interactive shell already `cd`'d into the
 * worktree with the workspace environment exported, right the configured
 * coding-agent runner already launched there -- via AppleScript
 * (`osascript`). The only module that shells out to `osascript` or knows
 * anything about iTerm2's scripting dictionary.
 *
 * Deliberately knows nothing about which runner is being launched: the
 * right-pane command is handed in fully formed (see
 * `RunnerSpec.formatLaunchCommand`), never constructed here. See
 * core/workspacePresenter.ts for the orchestration that decides *when*
 * to call this module and what to do when it's unavailable or fails.
 */

/** Resolves the `osascript` executable to invoke. Overridable for tests. */
export function osascriptBinary(): string {
  return process.env.CE_OSASCRIPT_BIN && process.env.CE_OSASCRIPT_BIN.length > 0
    ? process.env.CE_OSASCRIPT_BIN
    : "osascript";
}

async function runOsascript(script: string) {
  try {
    return await execa(osascriptBinary(), ["-e", script], { reject: false });
  } catch (error) {
    // Mirrors github.ts's isGhAvailable/runGh: some execa versions/
    // environments throw on a missing executable even with reject:
    // false, rather than resolving with a non-zero exit code.
    return { exitCode: 1, stdout: "", stderr: (error as Error).message } as const;
  }
}

/**
 * Checks whether iTerm2 is installed and scriptable at all -- never
 * whether it's currently running or frontmost, since AppleScript can
 * launch/script it regardless of which terminal (if any) `ce start` was
 * itself invoked from.
 */
export async function isITerm2Available(): Promise<boolean> {
  const result = await runOsascript('id of application "iTerm2"');
  return result.exitCode === 0;
}

/** Escapes `value` for safe interpolation inside an AppleScript double-quoted string literal. */
function appleScriptQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escapes `value` for safe interpolation inside a POSIX shell double-quoted string. */
function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** An RGB color, each channel 0-255. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Small, deliberately generic set of recognized color names for
 * `ce-harness.tab-color` -- never project-specific (no "MAT" or
 * "ce-harness" entries here; those belong entirely to the repository's
 * own Git config, not to this codebase).
 */
const NAMED_COLORS: Record<string, RgbColor> = {
  red: { r: 255, g: 59, b: 48 },
  orange: { r: 255, g: 149, b: 0 },
  yellow: { r: 255, g: 204, b: 0 },
  green: { r: 52, g: 199, b: 89 },
  cyan: { r: 50, g: 173, b: 230 },
  blue: { r: 0, g: 122, b: 255 },
  purple: { r: 175, g: 82, b: 222 },
  violet: { r: 138, g: 43, b: 226 },
  magenta: { r: 255, g: 45, b: 190 },
  pink: { r: 255, g: 105, b: 180 },
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  gray: { r: 142, g: 142, b: 147 },
  grey: { r: 142, g: 142, b: 147 },
};

/**
 * Parses a `ce-harness.tab-color` configured value into an `RgbColor`:
 * either a name from `NAMED_COLORS` (case-insensitive) or a `#RRGGBB`/
 * `#RGB` (with or without the leading `#`) hex value. Returns
 * `undefined` -- never throws -- for anything unset, blank, or
 * unrecognized, so an unset or mistyped value always means "keep
 * iTerm2's normal appearance", not a hard failure.
 */
export function parseTabColor(value: string | undefined): RgbColor | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const named = NAMED_COLORS[trimmed.toLowerCase()];
  if (named) return named;

  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const [r, g, b] = hex.split("");
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    };
  }
  return undefined;
}

/**
 * Shell command that sets the *tab*'s color via iTerm2's proprietary
 * terminal escape sequence (not an AppleScript property) -- this is what
 * actually colors the tab bar the user glances at to tell workspaces
 * apart, and it composes for free with the existing `write text`
 * mechanism already used to type commands into the left pane, with no
 * new AppleScript syntax needed. The values are always integers 0-255
 * produced by `parseTabColor`, never raw user input, so no shell-
 * escaping is needed here.
 */
function tabColorCommand(color: RgbColor): string {
  return `printf '\\033]6;1;bg;red;brightness;%d\\a\\033]6;1;bg;green;brightness;%d\\a\\033]6;1;bg;blue;brightness;%d\\a' ${color.r} ${color.g} ${color.b}`;
}

export interface TwoPaneWorkspaceOptions {
  /** Absolute path to the worktree the left pane should `cd` into. */
  worktreePath: string;
  /** Env vars to `export` in the left, interactive-shell pane. */
  leftEnv: Record<string, string>;
  /** The exact shell command to run in the right pane (typically `RunnerSpec.formatLaunchCommand(...)`). */
  rightCommand: string;
  /**
   * Tab color to apply (e.g. from the repository's configured
   * `ce-harness.tab-color`, parsed via `parseTabColor`). `undefined`
   * leaves iTerm2's normal appearance untouched, exactly as before this
   * option existed -- ce-harness never creates or manages iTerm2
   * profiles, only this one proprietary-escape-sequence tab color.
   */
  tabColor?: RgbColor;
  /** Session/tab title, e.g. `"MAT · 130"` -- set on both panes. */
  title: string;
}

/**
 * Builds the AppleScript source for the two-pane layout -- pure, no
 * execution, so its output is fully unit-testable without ever invoking
 * `osascript`.
 *
 * Never opens a second iTerm2 window for a workspace that already has one
 * open: if any iTerm2 window exists, a new *tab* is created in the
 * frontmost one (never reusing or splitting an existing tab); only when
 * no iTerm2 window exists at all is a new window created, using its
 * initial tab. Either way, that tab is then split into a left and a
 * right pane (`split vertically`, iTerm2's term for a side-by-side
 * divider -- not a stacked one): the left pane gets the (optional tab
 * color, then) `cd`/`export` line, the right pane gets the runner-launch
 * command. Both panes' names are set to `title` so the tab visually
 * identifies the workspace.
 */
export function buildTwoPaneScript(options: TwoPaneWorkspaceOptions): string {
  const exportAssignments = Object.entries(options.leftEnv)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("; ");
  const tabColorPrefix = options.tabColor ? `${tabColorCommand(options.tabColor)}; ` : "";
  const leftCommand = `${tabColorPrefix}cd ${shellQuote(options.worktreePath)}${
    exportAssignments ? `; ${exportAssignments}` : ""
  }; clear`;
  const title = appleScriptQuote(options.title);

  return [
    'tell application "iTerm2"',
    "  activate",
    "  if (count of windows) > 0 then",
    "    tell current window",
    "      set newTab to (create tab with default profile)",
    "    end tell",
    "  else",
    "    set newWindow to (create window with default profile)",
    "    tell newWindow",
    "      set newTab to current tab",
    "    end tell",
    "  end if",
    "  tell current session of newTab",
    `    set name to "${title}"`,
    `    write text "${appleScriptQuote(leftCommand)}"`,
    "    set rightPane to (split vertically with default profile)",
    "  end tell",
    "  tell rightPane",
    `    set name to "${title}"`,
    `    write text "${appleScriptQuote(options.rightCommand)}"`,
    "  end tell",
    "end tell",
  ].join("\n");
}

export type OpenTwoPaneWorkspaceResult = { opened: true } | { opened: false; message: string };

/**
 * Opens the two-pane layout described by `options`. Never throws: any
 * failure (iTerm2 not installed, Automation permission denied, a
 * scripting error) is reported as `{ opened: false, message }`, the same
 * never-throw contract as `openInEditor`/`RunnerSpec.launch` -- callers
 * decide how to react, and a failure here must never roll back or block
 * an already-created workspace.
 */
export async function openTwoPaneWorkspace(
  options: TwoPaneWorkspaceOptions,
): Promise<OpenTwoPaneWorkspaceResult> {
  const script = buildTwoPaneScript(options);
  const result = await runOsascript(script);

  if (result.exitCode !== 0) {
    return {
      opened: false,
      message: result.stderr?.trim() || `osascript exited with code ${result.exitCode}.`,
    };
  }
  return { opened: true };
}
