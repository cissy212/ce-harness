import { CeError } from "../core/errors.js";
import { readActivePointer, readWorkspace } from "../core/workspace.js";
import { migrateOpenSpecStore } from "../core/openspecMigrate.js";

/**
 * Explicitly, safely moves the active workspace's legacy, per-workspace
 * OpenSpec store onto this project's durable, project-scoped store (see
 * core/openspecMigrate.ts for the full algorithm and its safety
 * guarantees). Never runs implicitly -- an existing workspace never
 * changes storage behavior just because the CLI was upgraded.
 *
 * The legacy store's files are never deleted: after a successful
 * migration, the old store remains on disk exactly where it was, purely
 * so the user can remove it themselves once satisfied.
 */
export interface MigrateOpenSpecCommandOptions {
  /** --project-id: attach to this already-known project id explicitly. */
  projectId?: string;
  /** --new-project: mint a fresh project id regardless of any match/candidate. */
  newProject?: boolean;
}

export async function migrateOpenSpecCommand(
  options: MigrateOpenSpecCommandOptions = {},
): Promise<void> {
  if (options.projectId && options.newProject) {
    throw new CeError(
      "--project-id and --new-project are mutually exclusive.",
      "--project-id attaches to an already-known project; --new-project mints a fresh one. Use exactly one.",
    );
  }

  const pointer = await readActivePointer();
  if (!pointer) {
    throw new CeError(
      "No active workspace.",
      ["Start one with:", "", "  ce start <repo> <issue>"].join("\n"),
    );
  }

  const workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);
  const result = await migrateOpenSpecStore(workspace, {
    projectId: options.projectId,
    newProject: options.newProject,
  });

  if (result.status === "already-durable") {
    console.log(
      `Already using the durable OpenSpec store "${result.storeId}" at "${result.root}" -- nothing to migrate.`,
    );
    return;
  }

  console.log(
    `Migrated OpenSpec store "${result.storeId}" to durable, project-scoped storage at "${result.root}".`,
  );
  console.log(`The previous store's files at "${result.sourceRoot}" were left on disk untouched.`);
  if (result.oldStoreUnregisterWarning) {
    console.error(`Warning: ${result.oldStoreUnregisterWarning}`);
  }
  console.log(`Remove those files yourself once you've confirmed the migrated data looks correct, e.g.:`);
  console.log(`  rm -rf "${result.sourceRoot}"`);
  console.log(
    `Note: \`ce cleanup\` will delete "${result.sourceRoot}" anyway (it's still nested inside this workspace's directory) -- this is just for removing it sooner or inspecting it first.`,
  );
}
