import { CeError } from "../core/errors.js";
import { retrieveCandidates, type RetrievalSource } from "../core/retrieval.js";
import { readActivePointer, readWorkspace, resolveTrustedOpenSpec } from "../core/workspace.js";

/**
 * Thin CLI surface over core/retrieval.ts's `retrieveCandidates`, for
 * markdown-driven workflow stages (`/explore`, `/enrich`, `/propose`,
 * `/verify`, `/adversarial-review`) to invoke via a plain shell call,
 * exactly the way they already call `openspec ... --json` and parse the
 * result. No new state: `durableRoot` and `repositoryPath` are resolved
 * from the same active-workspace pointer and cross-checked OpenSpec
 * metadata every other read-only command (`ce status`, `ce refresh`)
 * already uses -- never a new "current change" concept, since
 * `retrieveCandidates` itself is change-agnostic (it searches the whole
 * project's durable store, not one change).
 */
export interface RetrieveCommandOptions {
  task?: string;
  keywords?: string[];
  paths?: string[];
  domain?: string;
  limit?: number;
  sources?: RetrievalSource[];
}

export async function retrieveCommand(options: RetrieveCommandOptions): Promise<void> {
  const pointer = await readActivePointer();
  if (!pointer) {
    throw new CeError("No active workspace.", "Run `ce start <repo> <issue>` first.");
  }

  const workspace = await readWorkspace(pointer.project, pointer.sanitizedIssue);
  const trusted = resolveTrustedOpenSpec(workspace);
  if (!trusted) {
    throw new CeError(
      "The active workspace has no trusted OpenSpec store to search.",
      "Run `ce start` (or `ce migrate-openspec`) to provision one, then try again.",
    );
  }

  const result = await retrieveCandidates({
    durableRoot: trusted.root,
    repositoryPath: workspace.worktreePath,
    taskDescription: options.task,
    keywords: options.keywords,
    paths: options.paths,
    domain: options.domain,
    limit: options.limit,
    sources: options.sources,
  });

  console.log(JSON.stringify(result, null, 2));
}
