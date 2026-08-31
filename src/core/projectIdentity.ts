import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { CeError } from "./errors.js";
import { generateProjectId, isValidProjectId } from "./openspecId.js";
import { openspecRoot } from "./paths.js";

/**
 * Project Identity: a project's durable OpenSpec store (see
 * openspecId.ts's expectedDurableOpenSpecRoot) is keyed by a stable,
 * ce-harness-minted project id (openspecId.ts's generateProjectId),
 * never by anything derived from the repository's current Git remote or
 * filesystem path. Git signals -- a normalized remote URL and the
 * repository's root commit -- are only ever *evidence* ce-harness uses
 * to recognize, on a later `ce start`, that a repository checkout is
 * (still, or again) the same project as a previously-known id: they are
 * recorded, compared, and accumulated, but never used to compute or
 * regenerate the id itself. This is deliberate: the id must not change
 * just because a signal legitimately changes (a repository transfer to
 * a new remote, a history rewrite that changes the root commit), and
 * matching must fail safe (prefer a false negative -- minting a
 * needless second id -- over a false positive that silently attaches
 * one project's historical knowledge to a different repository).
 *
 * Each project's identity record is persisted as `.identity.yml`
 * colocated inside that project's own durable OpenSpec store root, not
 * in a separate central registry file, so the record travels with (and
 * is exactly as durable as) the store data it identifies. Discovering
 * an existing identity is therefore a scan of every durable store's
 * `.identity.yml` (scanProjectIdentities) -- deliberately *not* scoped
 * to the current repository's own project name/path, since recognizing
 * a project *despite* its name or path having changed is the entire
 * point.
 */

/**
 * One recorded snapshot of Git-derived signals observed for a project,
 * at the moment ce-harness recognized or (re)confirmed them. `project`
 * is the ce-harness project label (the repository folder's basename --
 * see sanitize.ts's deriveProjectName) *at that time*: purely
 * informational, kept only so a human inspecting this file can see a
 * project's name history across renames. It is never used to compute
 * or validate the project id, its store id, or its durable store path
 * (those are keyed by project id alone -- see openspecId.ts).
 *
 * `originUrl`/`rootCommit` are each independently nullable: a signal
 * ce-harness could not read at evidence-recording time (no remote
 * configured, HEAD unresolvable, a shallow clone, ...) is simply
 * absent, never a placeholder value. `originUrl`, when present, is
 * already normalized (see normalizeRemoteUrl) -- never the raw value
 * read from Git -- so evidence comparison everywhere else in this
 * module is a plain string equality check.
 */
export const IdentityEvidenceSchema = z.object({
  project: z.string().min(1),
  originUrl: z.string().min(1).nullable(),
  rootCommit: z.string().min(1).nullable(),
  recordedAt: z.string().min(1),
});
export type IdentityEvidence = z.infer<typeof IdentityEvidenceSchema>;

/**
 * The durable, ce-harness-minted identity of a project. See this
 * module's own comment above for the full model; in short, `projectId`
 * is generated once and never recomputed from Git signals -- `evidence`
 * is oldest-first and strictly append-only (existing entries are never
 * edited or removed), growing by one entry each time ce-harness mints a
 * project id (the first entry) or confirms/re-attaches to an existing
 * one under new or changed signals.
 */
export const ProjectIdentityRecordSchema = z.object({
  projectId: z.string().min(1),
  createdAt: z.string().min(1),
  evidence: z.array(IdentityEvidenceSchema).min(1),
});
export type ProjectIdentityRecord = z.infer<typeof ProjectIdentityRecordSchema>;

/** The only path a project's identity record may live at. */
export function identityFilePath(durableRoot: string): string {
  return join(durableRoot, ".identity.yml");
}

/**
 * Reads and validates the identity record colocated in a project's
 * durable store root. Returns null (never throws) when no identity file
 * exists there yet -- e.g. a durable store created before Project
 * Identity existed, or one whose migration is still in progress -- so
 * callers can treat "no record" as ordinary, expected state. Throws a
 * CeError only when a `.identity.yml` file exists but is unreadable as
 * YAML or does not match the expected schema, since that indicates
 * corruption or tampering, not merely "not written yet."
 */
export async function readIdentityRecord(durableRoot: string): Promise<ProjectIdentityRecord | null> {
  const file = identityFilePath(durableRoot);
  if (!existsSync(file)) return null;

  let raw: unknown;
  try {
    raw = parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new CeError(`"${file}" is not valid YAML: ${(error as Error).message}`);
  }

  const result = ProjectIdentityRecordSchema.safeParse(raw);
  if (!result.success) {
    throw new CeError(`"${file}" does not match the expected identity record schema.`);
  }
  return result.data;
}

/** Writes (creating `durableRoot` if necessary) a project's identity record. */
export async function writeIdentityRecord(
  durableRoot: string,
  record: ProjectIdentityRecord,
): Promise<void> {
  await mkdir(durableRoot, { recursive: true });
  await writeFile(identityFilePath(durableRoot), stringify(record), "utf8");
}

/**
 * Scans every existing durable store's identity record. Global across
 * every project -- never scoped to the current repository's own project
 * name or path -- since recognizing a project despite its name or path
 * having changed is the entire point (see this module's top comment).
 * Skips (never throws for) a per-project directory with no
 * `.identity.yml` yet, or a directory entry that fails to parse as one
 * (see readIdentityRecord): a single corrupted or pre-Project-Identity
 * store must never abort identity resolution for every other project.
 */
export async function scanProjectIdentities(): Promise<ProjectIdentityRecord[]> {
  const root = openspecRoot();
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const records: ProjectIdentityRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const record = await readIdentityRecord(join(root, entry.name));
      if (record) records.push(record);
    } catch {
      // Corrupted/unreadable identity file -- contributes no evidence,
      // never aborts the scan. See readIdentityRecord.
    }
  }
  return records;
}

/**
 * Normalizes a Git remote URL for identity-evidence comparison, so
 * equivalent URLs spelled differently (scp-like vs `ssh://`, `https://`
 * vs `ssh://`, a trailing ".git", a trailing slash, letter case) compare
 * equal. Comparison-only: the result is never used to construct a URL
 * Git itself would be asked to fetch from.
 *
 * Examples that normalize to the same value:
 *   git@github.com:acme/widgets.git
 *   ssh://git@github.com/acme/widgets.git
 *   https://github.com/acme/widgets
 *   https://GitHub.com/acme/widgets.git/
 *
 * Returns null for a value that isn't meaningful cross-checkout identity
 * evidence at all -- a local filesystem path remote (e.g. a bare repo
 * used as a test fixture, or a "remote" that is really just another
 * directory on the same machine): paths are machine-specific, so
 * treating one as evidence would either never match anywhere else, or
 * -- worse -- coincidentally match an unrelated project that happens to
 * use the same local path convention.
 */
export function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  let rest: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // A URL with an explicit scheme: ssh://, https://, git://, ...
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "file:") return null;
      rest = `${parsed.host}${parsed.pathname}`;
    } catch {
      return null;
    }
  } else {
    const scpMatch = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scpMatch) {
      // scp-like syntax: [user@]host:path
      rest = `${scpMatch[1]}/${scpMatch[2]}`;
    } else if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../") ||
      /^[a-zA-Z]:[\\/]/.test(trimmed)) {
      // A local filesystem path remote -- see the doc comment above.
      return null;
    } else {
      rest = trimmed;
    }
  }

  const cleaned = rest
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

  return cleaned.length > 0 ? cleaned : null;
}

/** The Git-derived signals read from a repository checkout right now. */
export interface IdentitySignals {
  originUrl: string | null;
  rootCommit: string | null;
}

export type IdentityMatch =
  | { kind: "no-match" }
  | { kind: "match"; record: ProjectIdentityRecord }
  | { kind: "candidate"; record: ProjectIdentityRecord; originAgrees: boolean; rootAgrees: boolean }
  | { kind: "conflict"; records: ProjectIdentityRecord[] };

/**
 * Classifies how `signals` (freshly read from a repository checkout,
 * `originUrl` raw/un-normalized) relate to every known project's
 * identity record. Four outcomes, in order of how confidently a caller
 * may act on them:
 *
 *   - "match": exactly one record has a *single* evidence entry that
 *     cleanly matches `signals` -- every signal available on both sides
 *     agrees, and at least one signal actually does (a signal missing on
 *     either side, e.g. no remote configured, contributes neither
 *     agreement nor conflict, so this also covers root-commit-only
 *     evidence for a repository that has never had a remote) -- safe to
 *     auto-attach.
 *   - "candidate": exactly one record has *some* evidence entry
 *     agreeing on originUrl, or (possibly a different entry) agreeing
 *     on rootCommit, but no single entry agrees on both -- e.g. only
 *     one of the two signals is available right now, or the signals
 *     have genuinely diverged (a transfer or history rewrite in
 *     progress). Never auto-attached: the caller must require an
 *     explicit, human-confirmed override before treating this as the
 *     same project.
 *   - "conflict": signals point at more than one distinct existing
 *     project (e.g. the origin URL matches one project's evidence while
 *     the root commit matches a different project's). Never resolved
 *     automatically.
 *   - "no-match": no existing record shares any evidence with `signals`
 *     at all (including when both signals are unavailable) -- safe to
 *     mint a fresh project id.
 *
 * This is intentionally conservative -- see this module's top comment:
 * "prefer false negatives over unsafe identity matches."
 */
export function classifyIdentityMatch(
  signals: IdentitySignals,
  records: ProjectIdentityRecord[],
): IdentityMatch {
  const normalizedOrigin = signals.originUrl ? normalizeRemoteUrl(signals.originUrl) : null;
  const rootCommit = signals.rootCommit;

  const fullMatches: ProjectIdentityRecord[] = [];
  const partial = new Map<string, { record: ProjectIdentityRecord; originAgrees: boolean; rootAgrees: boolean }>();

  for (const record of records) {
    let originAgrees = false;
    let rootAgrees = false;
    // A "clean" match against a single evidence entry: neither signal
    // that's available on *both* sides disagrees, and at least one
    // signal that's available on both sides actually agrees. A signal
    // missing on either side (e.g. no remote configured, on a local-only
    // repository -- a common, legitimate case, not a red flag) is
    // neither agreement nor conflict: it simply contributes no evidence
    // either way, rather than silently forcing every repository with no
    // remote to a CANDIDATE it can never clear on its own. This is what
    // lets root-commit-only evidence (no origin ever recorded, none
    // available now) resolve a match on its own, while a genuine
    // disagreement on any available signal still blocks one.
    let cleanMatch = false;

    for (const entry of record.evidence) {
      const entryOriginAgrees = normalizedOrigin !== null && entry.originUrl === normalizedOrigin;
      const entryRootAgrees = rootCommit !== null && entry.rootCommit === rootCommit;
      const originConflicts =
        normalizedOrigin !== null && entry.originUrl !== null && entry.originUrl !== normalizedOrigin;
      const rootConflicts = rootCommit !== null && entry.rootCommit !== null && entry.rootCommit !== rootCommit;

      if (entryOriginAgrees) originAgrees = true;
      if (entryRootAgrees) rootAgrees = true;
      if (!originConflicts && !rootConflicts && (entryOriginAgrees || entryRootAgrees)) {
        cleanMatch = true;
      }
    }

    if (cleanMatch) {
      fullMatches.push(record);
    } else if (originAgrees || rootAgrees) {
      partial.set(record.projectId, { record, originAgrees, rootAgrees });
    }
  }

  if (fullMatches.length === 1) {
    return { kind: "match", record: fullMatches[0] };
  }
  if (fullMatches.length > 1) {
    // Should never happen under correct operation (it would mean two
    // distinct project ids independently recorded the exact same
    // (originUrl, rootCommit) pair) -- treated defensively as a
    // conflict rather than silently picking one.
    return { kind: "conflict", records: fullMatches };
  }

  const candidates = [...partial.values()];
  if (candidates.length === 0) return { kind: "no-match" };
  if (candidates.length === 1) {
    return {
      kind: "candidate",
      record: candidates[0].record,
      originAgrees: candidates[0].originAgrees,
      rootAgrees: candidates[0].rootAgrees,
    };
  }
  return { kind: "conflict", records: candidates.map((c) => c.record) };
}

/**
 * Input signals plus the caller's explicit override choice (mirrors
 * `ce start`'s/`ce migrate-openspec`'s `--project-id`/`--new-project`
 * flags -- mutually exclusive, validated by the caller before this is
 * invoked).
 */
export interface ResolveProjectIdentityInput {
  /** The ce-harness project label right now (e.g. deriveProjectName(repoRoot)). */
  project: string;
  originUrl: string | null;
  rootCommit: string | null;
  /** --project-id: attach to this already-known project id explicitly. */
  explicitProjectId?: string;
  /** --new-project: mint a fresh id regardless of any match/candidate. */
  mintNew?: boolean;
}

export interface ResolveProjectIdentityResult {
  projectId: string;
  /**
   * The identity record to persist once the durable store at this
   * project id's path is confirmed ready (see openspecId.ts's
   * expectedDurableOpenSpecRoot) -- null when reusing a "match" whose
   * evidence already has this exact (originUrl, rootCommit) pair on
   * file, so there is nothing new to record.
   */
  recordToPersist: ProjectIdentityRecord | null;
}

/**
 * Resolves a stable project id for a repository checkout right now,
 * given its freshly-read Git signals and every currently-known
 * project's identity record. Shared by `ce start` and `ce
 * migrate-openspec` so the MATCH/CANDIDATE/CONFLICT/NO-MATCH policy
 * (classifyIdentityMatch) and its refuse-with-actionable-hint behavior
 * -- there is no interactive-prompt infrastructure anywhere in ce-harness,
 * so an ambiguous match is never silently resolved -- lives in exactly
 * one place. Throws a CeError (never guesses) for every case that isn't
 * safe to resolve automatically; see classifyIdentityMatch's own doc
 * comment for what each case means.
 */
export async function resolveProjectIdentity(
  input: ResolveProjectIdentityInput,
): Promise<ResolveProjectIdentityResult> {
  const nowIso = new Date().toISOString();
  const normalizedOrigin = input.originUrl ? normalizeRemoteUrl(input.originUrl) : null;
  const newEvidenceEntry: IdentityEvidence = {
    project: input.project,
    originUrl: normalizedOrigin,
    rootCommit: input.rootCommit,
    recordedAt: nowIso,
  };

  if (input.mintNew) {
    const projectId = generateProjectId();
    return {
      projectId,
      recordToPersist: { projectId, createdAt: nowIso, evidence: [newEvidenceEntry] },
    };
  }

  if (input.explicitProjectId) {
    if (!isValidProjectId(input.explicitProjectId)) {
      throw new CeError(
        `"${input.explicitProjectId}" is not a valid project id.`,
        "Project ids are minted by ce-harness itself -- copy one from `ce status` or a durable store's " +
          "`.identity.yml`, rather than choosing one by hand.",
      );
    }
    const records = await scanProjectIdentities();
    const existing = records.find((r) => r.projectId === input.explicitProjectId);
    if (!existing) {
      throw new CeError(
        `No existing project with id "${input.explicitProjectId}" was found.`,
        "Omit --project-id to let ce-harness detect or mint one automatically, or check known project " +
          "ids under ~/.ce-harness/openspec/*/.identity.yml.",
      );
    }
    return {
      projectId: existing.projectId,
      recordToPersist: { ...existing, evidence: [...existing.evidence, newEvidenceEntry] },
    };
  }

  const records = await scanProjectIdentities();
  const match = classifyIdentityMatch({ originUrl: input.originUrl, rootCommit: input.rootCommit }, records);

  switch (match.kind) {
    case "match":
      // Evidence for exactly this signal pair is already on file --
      // nothing new to persist.
      return { projectId: match.record.projectId, recordToPersist: null };

    case "no-match": {
      const projectId = generateProjectId();
      return {
        projectId,
        recordToPersist: { projectId, createdAt: nowIso, evidence: [newEvidenceEntry] },
      };
    }

    case "candidate":
      throw new CeError(
        [
          `This repository partially matches a known project (id "${match.record.projectId}"):`,
          match.originAgrees ? "  - its origin URL matches." : "  - its origin URL does NOT match.",
          match.rootAgrees ? "  - its root commit matches." : "  - its root commit does NOT match.",
          "",
          "ce-harness will not auto-attach on a partial match -- this could be a coincidence, or a " +
            "genuine repository transfer/history rewrite, and attaching the wrong project's history is " +
            "worse than not finding it.",
        ].join("\n"),
        `If this really is the same project, retry with --project-id ${match.record.projectId}. ` +
          "Otherwise, retry with --new-project to mint a separate identity.",
      );

    case "conflict":
      throw new CeError(
        [
          "This repository's signals point at more than one known project:",
          ...match.records.map((r) => `  - ${r.projectId}`),
        ].join("\n"),
        "ce-harness will not guess which one this is. Retry with --project-id <id> to attach to one of " +
          "them explicitly, or --new-project to mint a separate identity.",
      );
  }
}
