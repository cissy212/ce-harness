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

export interface SetupStoreResult {
  success: boolean;
  storeId?: string;
  root?: string;
  status: OpenSpecStatusEntry[];
  stderr: string;
}

export interface DoctorResult {
  found: boolean;
  healthy: boolean;
  root?: string;
  status: OpenSpecStatusEntry[];
  stderr: string;
}

export interface UnregisterResult {
  success: boolean;
  /** True when the store was already not registered (idempotent case). */
  notFound: boolean;
  status: OpenSpecStatusEntry[];
  stderr: string;
}

async function runOpenSpec(cwd: string, args: string[]) {
  return execa(openSpecBinary(), args, {
    cwd,
    reject: false,
    env: { OPENSPEC_TELEMETRY: "0" },
  });
}

/** Renders OpenSpec status entries (and/or stderr) as a single human-readable string. */
export function describeOpenSpecStatus(status: OpenSpecStatusEntry[], stderr: string): string {
  const messages = status.map((entry) => entry.message).filter((m): m is string => !!m);
  if (messages.length > 0) return messages.join("; ");
  if (stderr.trim().length > 0) return stderr.trim();
  return "no further details were provided by the openspec CLI.";
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
    status,
    stderr: result.stderr ?? "",
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
    status,
    stderr: result.stderr ?? "",
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

  return { success, notFound, status, stderr: result.stderr ?? "" };
}
