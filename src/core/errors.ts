/**
 * A CeError carries a human-readable message plus an optional, actionable
 * recovery hint. The CLI entrypoint catches these and prints both parts
 * without a stack trace; anything else is treated as an unexpected bug.
 */
export class CeError extends Error {
  readonly recovery?: string;

  constructor(message: string, recovery?: string) {
    super(message);
    this.name = "CeError";
    this.recovery = recovery;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof CeError) {
    return error.recovery
      ? `Error: ${error.message}\n\nSuggested fix: ${error.recovery}`
      : `Error: ${error.message}`;
  }
  if (error instanceof Error) {
    return `Unexpected error: ${error.message}`;
  }
  return `Unexpected error: ${String(error)}`;
}
