import { execa } from "execa";

/**
 * Launches OpenCode as the final step of `ce start`, handing the user's
 * terminal directly to it inside the freshly created worktree. This is
 * the only module that shells out to the `opencode` executable.
 */

/** Resolves the OpenCode executable to invoke. Overridable for tests. */
export function openCodeBinary(): string {
  return process.env.CE_OPENCODE_BIN && process.env.CE_OPENCODE_BIN.length > 0
    ? process.env.CE_OPENCODE_BIN
    : "opencode";
}

export interface LaunchOpenCodeOptions {
  /** Working directory to launch the process in. */
  cwd: string;
  /** Extra environment variables layered on top of the inherited environment. */
  env: Record<string, string>;
}

export type LaunchOpenCodeResult =
  | { launched: true; exitCode: number }
  | { launched: false; message: string };

/**
 * Launches OpenCode with inherited stdio (so the user interacts with it
 * directly) and an inherited environment plus the given `env` overrides.
 *
 * Never throws: a spawn failure (e.g. the executable is missing) is
 * reported as `{ launched: false, message }` rather than an exception, so
 * callers can decide how to react (ce never rolls back a workspace just
 * because OpenCode itself couldn't be launched).
 */
export async function launchOpenCode(options: LaunchOpenCodeOptions): Promise<LaunchOpenCodeResult> {
  const result = await execa(openCodeBinary(), [], {
    cwd: options.cwd,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
    reject: false,
  });

  // A real process invocation always yields a numeric exit code (even a
  // signal-terminated one is normalized by execa); a spawn-time failure
  // (e.g. ENOENT) does not, so this is how we distinguish "the process
  // ran and exited" from "the process could not be launched at all".
  if (typeof result.exitCode !== "number") {
    return {
      launched: false,
      message: result.shortMessage ?? result.message ?? "OpenCode could not be launched.",
    };
  }

  return { launched: true, exitCode: result.exitCode };
}

/** Renders the exact command line `launchOpenCode` would run, for recovery messages. */
export function formatLaunchCommand(cwd: string, env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `cd ${shellQuote(cwd)} && ${assignments} ${openCodeBinary()}`;
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
