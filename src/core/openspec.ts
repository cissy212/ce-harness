import { execa } from "execa";

/**
 * OpenSpec integration module: the only place in ce-harness that shells
 * out to the `openspec` executable. Commands (start/status/cleanup) call
 * these functions instead of invoking execa directly.
 *
 * Every call uses an argument array (never a shell string) and an
 * explicit working directory. `OPENSPEC_TELEMETRY=0` is set so the CLI's
 * stdout is pure JSON (it otherwise prints a one-line telemetry notice
 * on stdout before the JSON payload) and so this automated tool does not
 * silently phone home on the user's behalf.
 */

/** Resolves the OpenSpec executable to invoke. Overridable for tests. */
export function openSpecBinary(): string {
  return process.env.CE_OPENSPEC_BIN && process.env.CE_OPENSPEC_BIN.length > 0
    ? process.env.CE_OPENSPEC_BIN
    : "openspec";
}

export interface OpenSpecStatusEntry {
  severity?: string;
  code?: string;
  message?: string;
  target?: string;
  fix?: string;
}

/**
 * The raw child-process facts every `runOpenSpec` caller's result carries,
 * regardless of which subcommand ran or how its JSON payload parsed.
 * Kept even when `status`/`stderr` are both empty -- that combination is
 * exactly the case `describeOpenSpecStatus` otherwise has nothing to
 * report from. Covers not just "ran and exited/was signaled" but also
 * "never ran at all" (a spawn-level failure like a missing executable),
 * which looks identical to a killed process if only exitCode/signal are
 * inspected -- both are `undefined` either way. `failed`/`code`/
 * `execaMessage` are what actually distinguish the two.
 */
export interface OpenSpecCallOutcome {
  status: OpenSpecStatusEntry[];
  stderr: string;
  /** `undefined` when the process was terminated by a signal, or never spawned at all. */
  exitCode?: number;
  /** Set only when `isTerminated` is true -- e.g. "SIGKILL", "SIGTERM". */
  signal?: string;
  /** The full, unparsed stdout -- present even when it failed to parse as the expected JSON shape. */
  rawStdout: string;
  /** execa's own `result.failed` -- true for a non-zero exit, a spawn failure, a timeout, or a cancellation. */
  failed: boolean;
  /** True only when a signal actually terminated the process (see execa's `result.isTerminated`). Never assume this from `exitCode` being absent alone -- a spawn failure also leaves `exitCode` absent, with `isTerminated: false`. */
  isTerminated: boolean;
  /** True when the `timeout` option was exceeded. ce-harness never sets `timeout`, so this should always be false; kept so a future regression is visible instead of silently mis-attributed. */
  timedOut: boolean;
  /** True when a `cancelSignal` aborted the process. ce-harness never sets `cancelSignal`, so this should always be false. */
  isCanceled: boolean;
  /** True when output exceeded execa's `maxBuffer` (default 100MB -- effectively unreachable for OpenSpec's small JSON responses, but checked rather than assumed). */
  isMaxBuffer: boolean;
  /** Node.js error code when the process could not be spawned at all, e.g. "ENOENT" (executable not found on PATH) or "EACCES". */
  code?: string;
  /** execa's own short description of the failure (e.g. "Command failed with ENOENT: ..."), when it produced one. */
  execaMessage?: string;
}

export interface SetupStoreResult extends OpenSpecCallOutcome {
  success: boolean;
  storeId?: string;
  root?: string;
}

export interface DoctorResult extends OpenSpecCallOutcome {
  found: boolean;
  healthy: boolean;
  root?: string;
}

export interface UnregisterResult extends OpenSpecCallOutcome {
  success: boolean;
  /** True when the store was already not registered (idempotent case). */
  notFound: boolean;
}

async function runOpenSpec(cwd: string, args: string[]) {
  return execa(openSpecBinary(), args, {
    cwd,
    reject: false,
    env: { OPENSPEC_TELEMETRY: "0" },
  });
}

/** Builds the shared `OpenSpecCallOutcome` fields from a raw `runOpenSpec` result. */
function callOutcome(
  result: Awaited<ReturnType<typeof runOpenSpec>>,
  status: OpenSpecStatusEntry[],
): OpenSpecCallOutcome {
  return {
    status,
    stderr: result.stderr ?? "",
    exitCode: result.exitCode,
    ...(result.isTerminated && result.signal ? { signal: result.signal } : {}),
    rawStdout: result.stdout ?? "",
    failed: result.failed ?? false,
    isTerminated: result.isTerminated ?? false,
    timedOut: result.timedOut ?? false,
    isCanceled: result.isCanceled ?? false,
    isMaxBuffer: result.isMaxBuffer ?? false,
    ...(result.code ? { code: result.code } : {}),
    ...(result.shortMessage ? { execaMessage: result.shortMessage } : {}),
  };
}

/**
 * Renders an OpenSpec call outcome as a single human-readable string.
 * Prefers parsed status messages, then raw stderr -- both of which are
 * normally present on failure. When *neither* is available (the case
 * that previously produced an unhelpful, information-free message),
 * falls back to the raw exit code/signal and raw stdout instead of
 * silently discarding them.
 */
export function describeOpenSpecStatus(outcome: OpenSpecCallOutcome): string {
  const messages = outcome.status.map((entry) => entry.message).filter((m): m is string => !!m);
  if (messages.length > 0) return messages.join("; ");
  if (outcome.stderr.trim().length > 0) return outcome.stderr.trim();

  // Neither a structured status nor stderr -- report every other clue
  // execa captured, evidence-first, rather than guessing a cause. `code`
  // (a Node.js error code like "ENOENT"/"EACCES") is checked first and
  // specifically because it is the one field execa only ever sets for a
  // genuine spawn-level failure -- the process never actually ran at all.
  // `execaMessage` (execa's `shortMessage`) is NOT used as a priority
  // signal on its own: execa sets it for *any* non-zero exit, including
  // an ordinary one that already has nothing more informative to add
  // than the exit code/stdout breakdown below -- using it unconditionally
  // would shadow that breakdown's raw stdout content, which is usually
  // more diagnostic than a generic "Command failed with exit code N" line.
  if (outcome.code) {
    return (
      `openspec's process could not be run as expected (${outcome.code})` +
      `${outcome.execaMessage ? `: ${outcome.execaMessage}` : ""}.`
    );
  }
  if (outcome.timedOut) {
    return "openspec's process exceeded its timeout.";
  }
  if (outcome.isCanceled) {
    return "openspec's process was canceled.";
  }
  if (outcome.isMaxBuffer) {
    return "openspec's process output exceeded the buffer limit.";
  }

  const exitDescription =
    outcome.exitCode !== undefined
      ? `exit code ${outcome.exitCode}`
      : outcome.isTerminated
        ? `terminated by signal ${outcome.signal ?? "unknown"}`
        : "no exit code, and not terminated by a signal (the process may not have completed at all)";
  const stdout = outcome.rawStdout.trim();
  const stdoutDescription = stdout.length > 0 ? `raw stdout: ${stdout}` : "stdout was empty";
  return `openspec produced no status details and no stderr (${exitDescription}; ${stdoutDescription}).`;
}

/** Best-effort JSON parse that tolerates stray non-JSON lines before the payload. */
function parseJsonOutput(stdout: string): unknown {
  const start = stdout.indexOf("{");
  if (start === -1) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

function asStatusArray(value: unknown): OpenSpecStatusEntry[] {
  return Array.isArray(value) ? (value as OpenSpecStatusEntry[]) : [];
}

/** Checks whether the OpenSpec executable is installed and runnable. */
export async function isOpenSpecAvailable(cwd: string): Promise<boolean> {
  try {
    const result = await execa(openSpecBinary(), ["--version"], {
      cwd,
      reject: false,
      env: { OPENSPEC_TELEMETRY: "0" },
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Creates and registers a new OpenSpec store at `storePath` with id `storeId`. */
export async function setupStore(
  cwd: string,
  storeId: string,
  storePath: string,
): Promise<SetupStoreResult> {
  const result = await runOpenSpec(cwd, [
    "store",
    "setup",
    storeId,
    "--path",
    storePath,
    "--no-init-git",
    "--json",
  ]);

  const parsed = parseJsonOutput(result.stdout ?? "") as
    | { store?: { id?: string; root?: string } | null; status?: unknown }
    | undefined;

  const status = asStatusArray(parsed?.status);
  const success = result.exitCode === 0 && !!parsed?.store;

  return {
    success,
    storeId: parsed?.store?.id,
    root: parsed?.store?.root,
    ...callOutcome(result, status),
  };
}

/** Checks store health via `openspec store doctor`. Read-only. */
export async function storeDoctor(cwd: string, storeId: string): Promise<DoctorResult> {
  const result = await runOpenSpec(cwd, ["store", "doctor", storeId, "--json"]);

  const parsed = parseJsonOutput(result.stdout ?? "") as
    | {
        stores?: Array<{
          id?: string;
          root?: string;
          openspec_root?: { healthy?: boolean };
          status?: unknown;
        }>;
        status?: unknown;
      }
    | undefined;

  const entry = parsed?.stores?.[0];
  const found = !!entry;
  const healthy = found ? entry?.openspec_root?.healthy === true : false;
  const status = [...asStatusArray(parsed?.status), ...asStatusArray(entry?.status)];

  return {
    found,
    healthy,
    root: entry?.root,
    ...callOutcome(result, status),
  };
}

/** True if `storeId` is currently registered with OpenSpec. Read-only. */
export async function isStoreRegistered(cwd: string, storeId: string): Promise<boolean> {
  const result = await runOpenSpec(cwd, ["store", "list", "--json"]);
  if (result.exitCode !== 0) return false;

  const parsed = parseJsonOutput(result.stdout ?? "") as
    | { stores?: Array<{ id?: string }> }
    | undefined;

  return (parsed?.stores ?? []).some((store) => store.id === storeId);
}

/**
 * Unregisters `storeId` from OpenSpec's global registry. Never deletes
 * files on disk (ce-harness retains sole control over filesystem
 * deletion); use `openspec store unregister`, never `store remove`.
 */
export async function unregisterStore(cwd: string, storeId: string): Promise<UnregisterResult> {
  const result = await runOpenSpec(cwd, ["store", "unregister", storeId, "--json"]);

  const parsed = parseJsonOutput(result.stdout ?? "") as
    | { store?: { id?: string } | null; status?: unknown }
    | undefined;

  const status = asStatusArray(parsed?.status);
  const notFound = status.some((entry) => entry.code === "store_not_found");
  const success = result.exitCode === 0 && !!parsed?.store;

  return { success, notFound, ...callOutcome(result, status) };
}
