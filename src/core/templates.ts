import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
 * True if `path` exists but is something other than a directory (e.g. a
 * plain file a repository happens to track at a path ce-harness needs
 * to create as a directory, such as `.claude` or `.claude/commands`).
 * `mkdir(path, { recursive: true })` throws in that situation rather
 * than treating it as "already there" -- callers use this to detect the
 * case up front and degrade gracefully (warn and skip) instead of
 * letting that throw surface as a raw, unhandled filesystem error.
 */
export function existsAsNonDirectory(path: string): boolean {
  return existsSync(path) && !statSync(path).isDirectory();
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

/**
 * The result of a collision-aware copy: which top-level entries under
 * `templates/<name>/` were actually written, and which were left alone
 * because something already existed at that destination path.
 */
export interface CollisionAwareCopyResult {
  /** Top-level entry names (e.g. "workspace.md", "openspec-sync-specs") actually copied in. */
  written: string[];
  /** Top-level entry names left completely untouched due to a pre-existing destination path. */
  skipped: string[];
  /**
   * True if `destinationDir` itself exists but is not a directory (e.g.
   * `.claude/commands` tracked as a plain file), so nothing under it
   * could even be attempted -- `written`/`skipped` are both `[]` in that
   * case, since no individual entry was ever inspected.
   */
  blockedByNonDirectory: boolean;
}

/**
 * Like `copyTemplates`, but collision-safe at the granularity of each
 * top-level entry under `templates/<name>/` (a single command file, or a
 * whole skill directory) rather than the whole category. A top-level
 * entry whose destination path already exists -- whatever put it there,
 * tracked or not -- is left completely untouched (not merged into, not
 * partially overwritten); every other entry is copied in normally. This
 * is what lets ce-harness coexist with a repository that already owns
 * some, but not all, of `.claude/commands/` or `.claude/skills/`, instead
 * of an all-or-nothing directory-level check locking out every template
 * over a single unrelated pre-existing entry.
 *
 * If `destinationDir` itself already exists as something other than a
 * directory, this returns immediately with `blockedByNonDirectory: true`
 * rather than letting `mkdir` throw -- there is nowhere to even attempt
 * placing an entry, so every entry is left alone as a whole, and the
 * pre-existing path is never touched.
 */
export async function copyTemplatesSkippingCollisions(
  name: string,
  destinationDir: string,
): Promise<CollisionAwareCopyResult> {
  const sourceDir = join(templatesRoot(), name);
  if (!existsSync(sourceDir)) return { written: [], skipped: [], blockedByNonDirectory: false };

  if (existsAsNonDirectory(destinationDir)) {
    return { written: [], skipped: [], blockedByNonDirectory: true };
  }

  await mkdir(destinationDir, { recursive: true });

  const entries = await readdir(sourceDir, { withFileTypes: true });
  const written: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const destinationPath = join(destinationDir, entry.name);
    if (existsSync(destinationPath)) {
      skipped.push(entry.name);
      continue;
    }

    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyDirectoryContents(join(sourceDir, entry.name), destinationPath);
    } else if (entry.isFile()) {
      await copyFile(join(sourceDir, entry.name), destinationPath);
    }
    written.push(entry.name);
  }

  return { written, skipped, blockedByNonDirectory: false };
}

/** SHA-256 hex digest of a file's exact byte content. */
export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * The result of a refresh pass: which top-level *file* entries under
 * `templates/<name>/` were written fresh or overwritten with updated
 * content (`updated`), already matched the current template as-is
 * (`unchanged`), or were left completely alone because their current
 * on-disk content could not be proven to still be ce-harness's own
 * (`skipped`) -- plus the new known-good hash for every `updated`/
 * `unchanged` entry (by top-level entry name), for the caller to persist.
 */
export interface RefreshCopyResult {
  updated: string[];
  unchanged: string[];
  skipped: string[];
  hashes: Record<string, string>;
}

/**
 * Like `copyTemplatesSkippingCollisions`, but for refreshing an
 * already-provisioned destination instead of a first write -- the
 * counterpart used by `ce refresh` (see `RunnerSpec.refreshConfig`)
 * rather than `ce start`. Each top-level entry under `templates/<name>/`
 * is compared by content hash, not mere existence:
 *
 * - Missing from `destinationDir` entirely: written fresh (a template
 *   added to the harness's library since this destination was last
 *   provisioned) -- reported as `updated`.
 * - Present, and its current on-disk hash matches `knownHashes[entryName]`
 *   (the hash the caller asserts ce-harness itself last wrote there):
 *   proven untouched since -- safely overwritten with the current
 *   template content, reported as `updated`. What "proven untouched"
 *   means, including how to handle a destination with no prior hash
 *   history at all, is entirely the caller's decision (see
 *   runners/claude.ts's bootstrap handling) -- this function only ever
 *   compares against whatever `knownHashes` it's given.
 * - Present, and its current on-disk hash already matches the *current*
 *   template's hash: nothing to write, reported as `unchanged` rather
 *   than `updated`. This is what makes repeated refreshes idempotent.
 * - Present, but neither of the above (no recorded hash for this entry,
 *   or the recorded hash doesn't match what's on disk): left completely
 *   untouched, reported as `skipped`. This is what protects a genuine
 *   user customization -- or an unrelated pre-existing file `writeConfig`
 *   never owned in the first place -- from ever being silently
 *   overwritten.
 *
 * Deliberately files only: a nested top-level entry (e.g. a skill's own
 * directory) is skipped over entirely rather than guessed at, since
 * directory-content hashing is out of scope for this pass -- see the
 * caller for the current category(ies) this is actually used for.
 */
export async function refreshTemplateFiles(
  name: string,
  destinationDir: string,
  knownHashes: Record<string, string>,
): Promise<RefreshCopyResult> {
  const sourceDir = join(templatesRoot(), name);
  const result: RefreshCopyResult = { updated: [], unchanged: [], skipped: [], hashes: {} };
  if (!existsSync(sourceDir)) return result;

  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    const newHash = await sha256File(sourcePath);

    if (!existsSync(destinationPath)) {
      await mkdir(destinationDir, { recursive: true });
      await copyFile(sourcePath, destinationPath);
      result.updated.push(entry.name);
      result.hashes[entry.name] = newHash;
      continue;
    }

    const onDiskHash = await sha256File(destinationPath);
    if (onDiskHash === newHash) {
      result.unchanged.push(entry.name);
      result.hashes[entry.name] = newHash;
      continue;
    }

    if (knownHashes[entry.name] === onDiskHash) {
      await copyFile(sourcePath, destinationPath);
      result.updated.push(entry.name);
      result.hashes[entry.name] = newHash;
      continue;
    }

    result.skipped.push(entry.name);
  }

  return result;
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
