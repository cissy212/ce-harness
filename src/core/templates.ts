import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generic template-copying mechanism, reused for every template
 * category (e.g. commands/, skills/, lenses/, prompts/). Nothing here
 * knows about any specific template filename; it just copies whatever
 * files exist under templates/<name>/ into a destination directory,
 * preserving filenames exactly.
 */

/**
 * Root of the harness's own template library (checked into the harness
 * repository, never generated from code): <package root>/templates.
 * Resolved relative to this module's own location, so it works
 * identically whether running from source (src/core, via tsx) or from
 * the built output (dist/core) -- both are two directories below the
 * package root, where templates/ lives as a sibling of src/ and dist/.
 *
 * Overridable via CE_TEMPLATES_ROOT (same pattern as CE_HARNESS_HOME,
 * CE_OPENSPEC_BIN, etc.) so tests can prove the copy mechanism is
 * generic without reading from or writing to the harness's real
 * templates/ directory.
 */
export function templatesRoot(): string {
  const override = process.env.CE_TEMPLATES_ROOT;
  if (override && override.length > 0) return override;

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(moduleDir, "..", "..", "templates");
}

/**
 * Copies every file inside templates/<name>/ into `destinationDir`,
 * recursively (so nested directories like a skill's own folder, e.g.
 * templates/skills/openspec-sync-specs/SKILL.md, are preserved at the
 * same relative path in the destination), preserving filenames and
 * byte-for-byte contents exactly. Creates directories as needed.
 *
 * Returns the relative paths copied (e.g. "workspace.md" for a flat
 * command file, or "openspec-sync-specs/SKILL.md" for a nested one), in
 * directory order. If templates/<name>/ does not exist (no templates
 * defined yet for that category), this is a no-op that returns an empty
 * list rather than an error.
 */
export async function copyTemplates(name: string, destinationDir: string): Promise<string[]> {
  const sourceDir = join(templatesRoot(), name);
  if (!existsSync(sourceDir)) return [];

  await mkdir(destinationDir, { recursive: true });
  return copyDirectoryContents(sourceDir, destinationDir);
}

/** Recursive worker behind copyTemplates(); `prefix` tracks the relative path so far. */
async function copyDirectoryContents(
  sourceDir: string,
  destinationDir: string,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const copied: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const nestedSource = join(sourceDir, entry.name);
      const nestedDestination = join(destinationDir, entry.name);
      await mkdir(nestedDestination, { recursive: true });
      copied.push(...(await copyDirectoryContents(nestedSource, nestedDestination, relativePath)));
    } else if (entry.isFile()) {
      await copyFile(join(sourceDir, entry.name), join(destinationDir, entry.name));
      copied.push(relativePath);
    }
  }
  return copied;
}
