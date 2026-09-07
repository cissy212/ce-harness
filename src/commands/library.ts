import { CeError } from "../core/errors.js";
import { DEFAULT_EDITOR, formatOpenCommand, openInEditor } from "../core/editor.js";
import { rebuildLibrary } from "../core/library.js";

/**
 * `ce library`: rebuilds the human-readable project library (see
 * `core/library.ts`) and opens its root directly in an editor -- the
 * "browse my retained project knowledge" entry point, for someone who
 * won't remember a project id, an issue number, an archived-change slug,
 * or `~/.ce-harness/openspec/...` months later, but will remember that
 * this command shows them their projects by name.
 */
export async function libraryCommand(): Promise<void> {
  const { root, entries, warnings } = await rebuildLibrary();

  for (const warning of warnings) {
    console.error(warning);
  }

  console.log(
    entries.length > 0
      ? `Library rebuilt: ${entries.length} project(s).`
      : "Library rebuilt: no known projects yet.",
  );

  console.log(`Opening "${root}" in ${DEFAULT_EDITOR.label}...`);
  const result = await openInEditor(root);
  if (!result.opened) {
    throw new CeError(
      `Failed to open the library in ${DEFAULT_EDITOR.label}: ${result.message}`,
      `Open it manually with:\n  ${formatOpenCommand(root)}`,
    );
  }
}
