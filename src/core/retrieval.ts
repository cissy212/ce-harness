import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { commitChangedPaths, pathHistory, searchCommitMessages } from "./git.js";

/**
 * Retrieval Contract: one small, deterministic mechanism workflow stages
 * (/explore, /enrich, /propose, /verify, /adversarial-review -- see
 * commands/retrieve.ts for the exact current caller list) can call to
 * discover relevant *prior* project knowledge, without each one
 * inventing its own search logic. This module answers exactly one
 * question -- "what already-known artifacts might be relevant to this
 * task?" -- and nothing more:
 *
 *   - It never judges whether a historical artifact is still true. A
 *     result's `status: "historical"` plus its `date` is the entire
 *     staleness signal this module provides; the current repository
 *     (and current specs) remain authoritative, and reconciling a
 *     historical artifact against current code is the calling
 *     workflow's job, not this module's.
 *   - It never loads a full artifact into context. Every candidate
 *     carries a path, metadata, and a short bounded excerpt -- the
 *     caller decides whether (and which) candidate is worth opening in
 *     full.
 *   - It is deterministic, filesystem/Git-based matching only: paths,
 *     identifiers, keywords, Git history, and OpenSpec's own directory
 *     structure. No embeddings, no vector/graph database, no daemon or
 *     persisted index, and no new external dependency -- a query is
 *     answered by scanning the durable store and (optionally) the
 *     repository's Git history fresh, every time.
 *
 * Project isolation: every query is scoped to a single, caller-resolved
 * `durableRoot` (see core/projectIdentity.ts / core/openspecId.ts's
 * `expectedDurableOpenSpecRoot`). This module never scans, and has no
 * way to reach, any other project's durable store -- it does not resolve
 * project identity itself, on purpose, so that concern stays owned by
 * exactly one module (core/projectIdentity.ts).
 *
 * Durable store layout this module reads (never writes): confirmed
 * against ce-harness's own `/propose`, `/archive`, `/verify`, and
 * `/adversarial-review` command templates, which are the actual source
 * of truth for what the `openspec` CLI puts on disk --
 *
 *   <durableRoot>/openspec/specs/<capability>/spec.md      (current)
 *   <durableRoot>/openspec/changes/archive/<date>-<name>/  (historical)
 *     proposal.md
 *     design.md
 *     tasks.md
 *     reports/<date>-verify.md
 *     reports/<date>-adversarial-review.md
 *     specs/<capability>/spec.md                            (delta spec)
 *
 * A change directory that has *not yet* been archived
 * (<durableRoot>/openspec/changes/<name>/, i.e. everything except the
 * `archive/` subdirectory) is deliberately never scanned here: it is the
 * workflow's own in-progress work, already directly known to whichever
 * command is running, not "prior project knowledge" to be discovered.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RetrievalSource = "specs" | "archivedChanges" | "gitHistory";

export type ArtifactType =
  | "spec"
  | "change-proposal"
  | "change-design"
  | "change-tasks"
  | "change-enrich"
  | "change-report"
  | "change-delta-spec"
  | "change-other"
  | "git-commit";

export type ArtifactStatus = "current" | "historical";

export type MatchedSignalKind = "path" | "domain" | "identifier" | "keyword";

export interface MatchedSignal {
  kind: MatchedSignalKind;
  /** The literal input value (a path, the domain, or a keyword) that matched. */
  detail: string;
}

export type Confidence = "strong" | "moderate" | "weak";

export interface RetrievalCandidate {
  /**
   * Relative path: relative to `durableRoot` for every OpenSpec-sourced
   * candidate (`spec`/`change-*`), relative to the repository root for
   * `git-commit` candidates.
   */
  path: string;
  root: "durableStore" | "repository";
  type: ArtifactType;
  status: ArtifactStatus;
  /** ISO 8601 date/time when known (file mtime, archive date, or commit date); null if truly unknown. */
  date: string | null;
  /** For `git-commit` candidates only. */
  commitSha?: string;
  matchedSignals: MatchedSignal[];
  /** A short, deterministic, human-readable summary built from `matchedSignals` -- never free-form prose. */
  whyMatched: string;
  confidence: Confidence;
  /** A single short, bounded snippet containing a match. Never the full artifact body. */
  excerpt: string | null;
}

export interface RetrievalQuery {
  /** The current project's durable OpenSpec store root (caller-resolved -- see module doc comment). Required. */
  durableRoot: string;
  /**
   * The current project's repository root, for the `gitHistory` source.
   * Omit to skip that source entirely (e.g. it isn't resolved yet, or
   * the caller only wants OpenSpec-sourced results).
   */
  repositoryPath?: string;
  /** Free-text description of the current task/issue. Used only to derive additional keywords -- see module doc comment on tokenization. */
  taskDescription?: string;
  /** Explicit keywords/identifiers the caller already knows are relevant. */
  keywords?: string[];
  /** Relevant file/directory paths, if known -- the single strongest signal this module has. */
  paths?: string[];
  /** OpenSpec domain/capability name, if known. */
  domain?: string;
  /** Maximum candidates to return, across all sources combined. Default 15. */
  limit?: number;
  /** Restrict which sources run. Default: all three. */
  sources?: RetrievalSource[];
}

export interface RetrievalResult {
  candidates: RetrievalCandidate[];
  /** Non-fatal notes about degraded/skipped sources or an empty query -- never a reason to treat the call as failed. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Tuning constants -- deliberately simple, documented weights, not a
// learned/ML model. See the module doc comment: deterministic first.
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 15;
const DEFAULT_GIT_LOG_LIMIT = 20;

const SIGNAL_WEIGHT: Record<MatchedSignalKind, number> = {
  path: 4,
  domain: 3,
  identifier: 2,
  keyword: 1,
};

/**
 * A path signal shared by more than this many candidates is treated as
 * a "hub" (e.g. cliMain.ts, touched by dozens of unrelated changes) and
 * dampened to half weight for every candidate it appears in, so a
 * frequently-touched file alone can no longer push an otherwise-
 * unrelated candidate to "strong" confidence -- it needs a second,
 * corroborating signal to get there. The signal is never removed from
 * `matchedSignals`/`whyMatched`; only its contribution to scoring and
 * confidence is reduced.
 */
const HUB_FREQUENCY_THRESHOLD = 5;
const HUB_DAMPENED_WEIGHT = SIGNAL_WEIGHT.path / 2;

/**
 * Confidence tiers, applied to the final (possibly dampened/demoted)
 * score. Calibrated against the signal weights above, not chosen in the
 * abstract: a single path match (the strongest signal this module has,
 * weight 4) must clear "strong" on its own -- exactly what a
 * `git-commit` candidate found via `pathHistory` for one of the
 * caller's own `paths` looks like, and the clearest possible case of
 * "this is relevant." A lone domain match (weight 3) lands in
 * "moderate" -- a real but less specific signal than an exact path hit.
 * A lone keyword (weight 1) stays "weak".
 */
const STRONG_THRESHOLD = 4;
const MODERATE_THRESHOLD = 2;

/**
 * A `git-commit` candidate found only via `searchCommitMessages` (no
 * direct path signal) whose own changed files fall entirely outside a
 * caller-inferred monorepo scope loses this much score -- enough to
 * usually drop it out of a small top-N result, without ever hard-
 * excluding it (a genuinely cross-cutting historical decision should
 * still be findable). See `applyMonorepoScope`'s doc comment for why
 * this applies to `git-commit` candidates only.
 */
const SCOPE_DEMOTION = 3;

const EXCERPT_MAX_LENGTH = 200;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "have", "has",
  "was", "were", "are", "not", "but", "you", "your", "its", "it's", "when",
  "what", "where", "which", "while", "then", "than", "them", "they", "their",
  "there", "here", "about", "after", "before", "again", "still", "just",
  "should", "would", "could", "will", "does", "did", "doing", "been", "being",
  "also", "each", "some", "such", "only", "over", "into", "onto", "per",
]);

// ---------------------------------------------------------------------------
// Query-signal preparation
// ---------------------------------------------------------------------------

interface KeywordEntry {
  /** As supplied/derived, original casing preserved (used for identifier detection and display). */
  raw: string;
  lower: string;
  isIdentifier: boolean;
}

interface QuerySignals {
  keywordEntries: KeywordEntry[];
  paths: string[];
  domain: string | null;
}

/**
 * A keyword "looks like an identifier" (code symbol, path fragment, or
 * acronym) rather than a plain English word when it contains internal
 * case changes (camelCase), an underscore, a dot, or a slash, or is a
 * short all-caps token (an acronym, e.g. "CLI"). This is a coarse,
 * deliberately simple heuristic -- see this module's doc comment on
 * why V1 stays deterministic and does not attempt real code-symbol
 * resolution.
 */
function isIdentifierLike(word: string): boolean {
  if (/[a-z][A-Z]/.test(word)) return true;
  if (word.includes("_") || word.includes(".") || word.includes("/")) return true;
  if (/^[A-Z0-9]{2,}$/.test(word)) return true;
  return false;
}

/**
 * Naive tokenization of free text into candidate keywords: lowercase,
 * split on anything that isn't a letter/digit/underscore, drop short
 * tokens and a small stopword list. This is intentionally crude --
 * good enough to surface a few extra useful keywords from a task
 * description, not a substitute for the caller passing explicit
 * `keywords`/`paths`/`domain` when it already knows them.
 */
function deriveKeywordsFromText(text: string): string[] {
  return text
    .split(/[^a-zA-Z0-9_]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word.toLowerCase()));
}

function buildQuerySignals(query: RetrievalQuery): QuerySignals {
  const rawKeywords = [...(query.keywords ?? [])];
  if (query.taskDescription) {
    rawKeywords.push(...deriveKeywordsFromText(query.taskDescription));
  }

  const seen = new Set<string>();
  const keywordEntries: KeywordEntry[] = [];
  for (const raw of rawKeywords) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    keywordEntries.push({ raw: trimmed, lower, isIdentifier: isIdentifierLike(trimmed) });
  }

  const paths = [...new Set((query.paths ?? []).map((p) => p.trim()).filter((p) => p.length > 0))];
  const domain = query.domain?.trim() ? query.domain.trim() : null;

  return { keywordEntries, paths, domain };
}

// ---------------------------------------------------------------------------
// Matching primitives -- shared by every source below
// ---------------------------------------------------------------------------

function matchKeywords(haystack: string, signals: QuerySignals): MatchedSignal[] {
  const lower = haystack.toLowerCase();
  const matched: MatchedSignal[] = [];
  for (const entry of signals.keywordEntries) {
    if (lower.includes(entry.lower)) {
      matched.push({ kind: entry.isIdentifier ? "identifier" : "keyword", detail: entry.raw });
    }
  }
  return matched;
}

/**
 * A caller-supplied path is treated as matching a document when the
 * document's text mentions either the path itself or (since docs rarely
 * spell out a full path) its basename, as long as that basename is
 * specific enough (>= 3 characters) to not just be common-word noise.
 */
function matchPaths(haystack: string, signals: QuerySignals): MatchedSignal[] {
  const lower = haystack.toLowerCase();
  const matched: MatchedSignal[] = [];
  for (const p of signals.paths) {
    const base = basename(p);
    if (lower.includes(p.toLowerCase()) || (base.length >= 3 && lower.includes(base.toLowerCase()))) {
      matched.push({ kind: "path", detail: p });
    }
  }
  return matched;
}

/**
 * A domain/capability hint matches when the caller's `domain` string and
 * a candidate-specific hint (a spec's capability directory name, or an
 * archived change's slug) overlap as substrings either direction, or
 * -- failing that -- the domain string is mentioned directly in the
 * document's own text.
 */
function matchDomain(haystack: string, candidateHint: string | null, signals: QuerySignals): MatchedSignal[] {
  if (!signals.domain) return [];
  const domainLower = signals.domain.toLowerCase();
  const hintLower = candidateHint?.toLowerCase() ?? "";
  if (hintLower && (hintLower.includes(domainLower) || domainLower.includes(hintLower))) {
    return [{ kind: "domain", detail: signals.domain }];
  }
  if (haystack.toLowerCase().includes(domainLower)) {
    return [{ kind: "domain", detail: signals.domain }];
  }
  return [];
}

function dedupeSignals(signals: MatchedSignal[]): MatchedSignal[] {
  const unique = new Map<string, MatchedSignal>();
  for (const signal of signals) {
    unique.set(`${signal.kind}:${signal.detail.toLowerCase()}`, signal);
  }
  return [...unique.values()];
}

function buildWhyMatched(signals: MatchedSignal[]): string {
  const order: MatchedSignalKind[] = ["path", "domain", "identifier", "keyword"];
  const grouped = new Map<MatchedSignalKind, string[]>();
  for (const signal of signals) {
    const list = grouped.get(signal.kind) ?? [];
    if (!list.includes(signal.detail)) list.push(signal.detail);
    grouped.set(signal.kind, list);
  }
  const parts: string[] = [];
  for (const kind of order) {
    const details = grouped.get(kind);
    if (details && details.length > 0) {
      parts.push(`${kind} match: ${details.map((d) => `"${d}"`).join(", ")}`);
    }
  }
  return parts.join("; ");
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function extractExcerpt(content: string, signals: MatchedSignal[]): string | null {
  const lines = content.split("\n");
  for (const signal of signals) {
    const needle = signal.detail.toLowerCase();
    const line = lines.find((l) => l.toLowerCase().includes(needle));
    if (line && line.trim().length > 0) return truncate(line.trim(), EXCERPT_MAX_LENGTH);
  }
  return null;
}

/**
 * A `git-commit` candidate's "content" is its commit subject -- already
 * short, and already the single most relevant line available (unlike a
 * markdown artifact, there is no larger document to search within). A
 * path-matched commit's subject very often never mentions the path
 * itself at all (e.g. "harden refund flow against double-submits"), so
 * the signal-line search `extractExcerpt` performs for OpenSpec
 * artifacts would usually and misleadingly return null here -- the
 * subject is used directly instead.
 */
function excerptForCommit(subject: string): string | null {
  const trimmed = subject.trim();
  return trimmed.length > 0 ? truncate(trimmed, EXCERPT_MAX_LENGTH) : null;
}

function confidenceFor(score: number): Confidence {
  if (score >= STRONG_THRESHOLD) return "strong";
  if (score >= MODERATE_THRESHOLD) return "moderate";
  return "weak";
}

// ---------------------------------------------------------------------------
// Internal candidate shape (carries a numeric score through ranking;
// stripped before being returned -- the public contract exposes only the
// derived `confidence` tier, never a raw score, so scoring internals can
// change without becoming part of the contract).
// ---------------------------------------------------------------------------

interface InternalCandidate extends RetrievalCandidate {
  score: number;
}

function buildCandidate(args: {
  path: string;
  root: "durableStore" | "repository";
  type: ArtifactType;
  status: ArtifactStatus;
  date: string | null;
  commitSha?: string;
  matched: MatchedSignal[];
  content: string;
}): InternalCandidate | null {
  const matchedSignals = dedupeSignals(args.matched);
  if (matchedSignals.length === 0) return null;
  const score = matchedSignals.reduce((sum, s) => sum + SIGNAL_WEIGHT[s.kind], 0);
  return {
    path: args.path,
    root: args.root,
    type: args.type,
    status: args.status,
    date: args.date,
    ...(args.commitSha ? { commitSha: args.commitSha } : {}),
    matchedSignals,
    whyMatched: buildWhyMatched(matchedSignals),
    confidence: confidenceFor(score),
    excerpt: args.type === "git-commit" ? excerptForCommit(args.content) : extractExcerpt(args.content, matchedSignals),
    score,
  };
}

// ---------------------------------------------------------------------------
// Filesystem scanning
// ---------------------------------------------------------------------------

async function walkMarkdownFiles(rootDir: string): Promise<string[]> {
  if (!existsSync(rootDir)) return [];
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(full);
      }
    }
  }
  await walk(rootDir);
  return results;
}

async function mtimeIso(file: string): Promise<string | null> {
  try {
    const stats = await stat(file);
    return stats.mtime.toISOString();
  } catch {
    return null;
  }
}

/** Current OpenSpec specs: `<durableRoot>/openspec/specs/<capability>/spec.md` (and any other .md under specs/). */
async function scanSpecs(durableRoot: string, signals: QuerySignals): Promise<InternalCandidate[]> {
  const specsRoot = join(durableRoot, "openspec", "specs");
  const files = await walkMarkdownFiles(specsRoot);
  const candidates: InternalCandidate[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const relFromSpecs = relative(specsRoot, file);
    const capability = relFromSpecs.split(sep)[0] ?? null;
    const matched = [
      ...matchPaths(content, signals),
      ...matchDomain(content, capability, signals),
      ...matchKeywords(content, signals),
    ];
    const candidate = buildCandidate({
      path: relative(durableRoot, file),
      root: "durableStore",
      type: "spec",
      status: "current",
      date: await mtimeIso(file),
      matched,
      content,
    });
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

const ARCHIVE_DIR_PATTERN = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const REPORT_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})-/;

function parseArchiveDirName(name: string): { date: string | null; slug: string } {
  const match = ARCHIVE_DIR_PATTERN.exec(name);
  if (!match) return { date: null, slug: name };
  return { date: `${match[1]}T00:00:00.000Z`, slug: match[2] };
}

function classifyChangeArtifactType(relToChange: string): ArtifactType {
  const normalized = relToChange.split(sep).join("/");
  if (normalized === "proposal.md") return "change-proposal";
  if (normalized === "design.md") return "change-design";
  if (normalized === "tasks.md") return "change-tasks";
  // enrich.md is /enrich's own ce-harness-owned, non-schema artifact
  // (see templates/commands/enrich.md) -- a sibling of proposal.md/
  // design.md/tasks.md on disk, but never one of OpenSpec's own
  // schema-tracked artifacts, exactly like explore.md (which this
  // module does not separately classify: /explore's findings are
  // superseded by /enrich's once /enrich has run, so only the latter
  // is worth surfacing to future retrieval).
  if (normalized === "enrich.md") return "change-enrich";
  if (normalized.startsWith("reports/")) return "change-report";
  if (normalized.startsWith("specs/")) return "change-delta-spec";
  return "change-other";
}

/**
 * A report file embeds its own date in its filename
 * (`reports/<date>-verify.md`), which is normally close to but can
 * predate the change's eventual archive date (a change can be verified
 * days before it's archived) -- preferred over the archive date when
 * present, for the most precise per-artifact provenance available.
 */
function artifactDate(relToChange: string, archiveDate: string | null): string | null {
  const normalized = relToChange.split(sep).join("/");
  if (normalized.startsWith("reports/")) {
    const match = REPORT_FILENAME_PATTERN.exec(basename(normalized));
    if (match) return `${match[1]}T00:00:00.000Z`;
  }
  return archiveDate;
}

/**
 * A domain/capability hint for an archived-change artifact: the delta
 * spec's own capability directory when available (most precise), else
 * the change's own slug (dashes read as word separators, e.g. a domain
 * of "billing" plausibly matches a change slugged "billing-refunds-fix").
 */
function changeDomainHint(relToChange: string, slug: string): string {
  const normalized = relToChange.split(sep).join("/");
  if (normalized.startsWith("specs/")) {
    const capability = normalized.slice("specs/".length).split("/")[0];
    if (capability) return capability;
  }
  return slug;
}

/**
 * Archived OpenSpec changes: every `.md` file under
 * `<durableRoot>/openspec/changes/archive/<date>-<name>/`. Deliberately
 * never scans `<durableRoot>/openspec/changes/` outside `archive/` --
 * see this module's doc comment.
 */
async function scanArchivedChanges(durableRoot: string, signals: QuerySignals): Promise<InternalCandidate[]> {
  const archiveRoot = join(durableRoot, "openspec", "changes", "archive");
  if (!existsSync(archiveRoot)) return [];

  let entries;
  try {
    entries = await readdir(archiveRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: InternalCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const { date: archiveDate, slug } = parseArchiveDirName(entry.name);
    const changeDir = join(archiveRoot, entry.name);
    const files = await walkMarkdownFiles(changeDir);

    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const relToChange = relative(changeDir, file);
      const type = classifyChangeArtifactType(relToChange);
      const domainHint = changeDomainHint(relToChange, slug);
      const matched = [
        ...matchPaths(content, signals),
        ...matchDomain(content, domainHint, signals),
        ...matchKeywords(content, signals),
        // The change's own slug is itself keyword/identifier-bearing
        // text (e.g. "billing-refunds-fix") even when it never appears
        // verbatim inside the artifact's body.
        ...matchKeywords(slug.replace(/-/g, " "), signals),
      ];
      const candidate = buildCandidate({
        path: relative(durableRoot, file),
        root: "durableStore",
        type,
        status: "historical",
        date: artifactDate(relToChange, archiveDate),
        matched,
        content,
      });
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Git history scanning
// ---------------------------------------------------------------------------

/**
 * Git-history candidates are always `status: "historical"` -- a commit
 * is, by definition, a record of the past, never the repository's
 * present authoritative state (see this module's doc comment).
 */
async function scanGitHistory(
  repositoryPath: string,
  signals: QuerySignals,
): Promise<{ candidates: InternalCandidate[]; warning: string | null }> {
  const bySha = new Map<string, { subject: string; date: string; matched: MatchedSignal[] }>();

  for (const path of signals.paths) {
    const commits = await pathHistory(repositoryPath, path, DEFAULT_GIT_LOG_LIMIT);
    for (const commit of commits) {
      const existing = bySha.get(commit.sha) ?? { subject: commit.subject, date: commit.date, matched: [] };
      existing.matched.push({ kind: "path", detail: path });
      bySha.set(commit.sha, existing);
    }
  }

  const messageKeywords = signals.keywordEntries.map((entry) => entry.raw);
  if (messageKeywords.length > 0) {
    const commits = await searchCommitMessages(repositoryPath, messageKeywords, DEFAULT_GIT_LOG_LIMIT);
    for (const commit of commits) {
      const existing = bySha.get(commit.sha) ?? { subject: commit.subject, date: commit.date, matched: [] };
      existing.matched.push(...matchKeywords(commit.subject, signals));
      bySha.set(commit.sha, existing);
    }
  }

  if (bySha.size === 0 && (signals.paths.length > 0 || messageKeywords.length > 0)) {
    // Distinguishing "genuinely no history" from "the repository/paths
    // couldn't be read at all" isn't reliable from these two read-only
    // calls alone (both already collapse every failure to an empty
    // array -- see their own doc comments) -- and either way there is
    // nothing more this function can safely do about it, so no warning
    // is raised here. A caller that wants to know whether the
    // repository itself is reachable at all can check that separately.
  }

  const candidates: InternalCandidate[] = [];
  for (const [sha, entry] of bySha) {
    const candidate = buildCandidate({
      path: repositoryPath,
      root: "repository",
      type: "git-commit",
      status: "historical",
      date: entry.date,
      commitSha: sha,
      matched: entry.matched,
      content: entry.subject,
    });
    if (candidate) candidates.push(candidate);
  }
  return { candidates, warning: null };
}

// ---------------------------------------------------------------------------
// Cross-candidate adjustments: hub dampening and monorepo scope
// ---------------------------------------------------------------------------

/**
 * Recomputes score/confidence after a signal's weight has changed. The
 * signal itself is never removed from `matchedSignals`/`whyMatched` --
 * only its contribution to ranking changes, so the "why" a candidate
 * matched stays fully transparent even when its rank was adjusted.
 */
function rescored(candidate: InternalCandidate, score: number): InternalCandidate {
  return { ...candidate, score, confidence: confidenceFor(score) };
}

/**
 * A path signal shared by many candidates (a "hub" file touched by
 * dozens of unrelated archived changes/commits) is dampened to half
 * weight everywhere it appears, so it alone can no longer carry a
 * candidate to "strong" confidence -- see `HUB_FREQUENCY_THRESHOLD`'s
 * doc comment. Applies uniformly to every candidate type, since hub
 * files are just as noisy a signal in an archived change's prose as in
 * `git log -- <path>`.
 */
function applyHubDampening(candidates: InternalCandidate[]): InternalCandidate[] {
  const frequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const signal of candidate.matchedSignals) {
      if (signal.kind !== "path") continue;
      const key = signal.detail.toLowerCase();
      frequency.set(key, (frequency.get(key) ?? 0) + 1);
    }
  }

  return candidates.map((candidate) => {
    let delta = 0;
    for (const signal of candidate.matchedSignals) {
      if (signal.kind !== "path") continue;
      const key = signal.detail.toLowerCase();
      if ((frequency.get(key) ?? 0) > HUB_FREQUENCY_THRESHOLD) {
        delta += HUB_DAMPENED_WEIGHT - SIGNAL_WEIGHT.path;
      }
    }
    return delta === 0 ? candidate : rescored(candidate, candidate.score + delta);
  });
}

/**
 * Monorepo scoping is applied only to `git-commit` candidates found via
 * `searchCommitMessages` (a keyword/message match with no path of its
 * own) -- for those, `commitChangedPaths` gives exact ground truth about
 * which part of the repository the commit actually touched. It is
 * deliberately NOT applied to OpenSpec-sourced candidates (specs,
 * archived changes): those are plain markdown text with no filesystem
 * location of their own to judge scope by, and inventing a heavier
 * per-artifact domain model to approximate one is exactly what this
 * design was asked to avoid unless proven necessary (see this module's
 * doc comment and the Retrieval Contract design's out-of-scope list).
 * A commit found via `pathHistory` for one of the caller's own `paths`
 * needs no scope check at all -- it is already, by construction, about
 * one of the paths the caller cares about.
 */
async function applyMonorepoScope(
  repositoryPath: string,
  candidates: InternalCandidate[],
  signals: QuerySignals,
): Promise<InternalCandidate[]> {
  if (signals.paths.length === 0) return candidates;

  // The scope boundary is each given path's own containing directory --
  // NOT just its first path segment. A monorepo laid out as
  // apps/<app>/... would otherwise treat "apps" itself as the scope,
  // which fails to distinguish one app from another (the exact case
  // this exists to handle). This stays a directory heuristic, not a
  // real package/workspace boundary detector -- see this module's doc
  // comment on why a heavier domain model is out of scope for V1.
  const scopePrefixes = [
    ...new Set(signals.paths.map((p) => dirname(p)).filter((p) => p !== "." && p.length > 0)),
  ];
  if (scopePrefixes.length === 0) return candidates;

  const result: InternalCandidate[] = [];
  for (const candidate of candidates) {
    const matchedViaPath = candidate.matchedSignals.some((s) => s.kind === "path");
    if (candidate.type !== "git-commit" || matchedViaPath || !candidate.commitSha) {
      result.push(candidate);
      continue;
    }
    const changedPaths = await commitChangedPaths(repositoryPath, candidate.commitSha);
    const inScope =
      changedPaths.length === 0 ||
      changedPaths.some((p) => scopePrefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`)));
    // Demotion never excludes: floored at a fractional 0.5 (strictly
    // below any real integer-weighted match, so an out-of-scope
    // candidate always ranks last among equally-signaled candidates
    // without ever being dropped by the `score > 0` filter below).
    result.push(inScope ? candidate : rescored(candidate, Math.max(0.5, candidate.score - SCOPE_DEMOTION)));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function stripScore(candidate: InternalCandidate): RetrievalCandidate {
  const { score: _score, ...rest } = candidate;
  return rest;
}

/**
 * Finds candidate prior-knowledge artifacts relevant to a task, scoped
 * strictly to `query.durableRoot` (and, for the `gitHistory` source,
 * `query.repositoryPath`). See this module's doc comment for the full
 * contract. Never throws: a missing durable store, an unreadable
 * repository, or a query with no usable signals all resolve to an
 * empty (or partial) result plus an explanatory warning, never an
 * exception -- retrieval is best-effort and additive, and a caller
 * should never need a try/catch around it.
 */
export async function retrieveCandidates(query: RetrievalQuery): Promise<RetrievalResult> {
  const warnings: string[] = [];
  const limit = query.limit ?? DEFAULT_LIMIT;
  const sources = query.sources ?? (["specs", "archivedChanges", "gitHistory"] as RetrievalSource[]);
  const signals = buildQuerySignals(query);

  if (signals.keywordEntries.length === 0 && signals.paths.length === 0 && !signals.domain) {
    return {
      candidates: [],
      warnings: ["No search signals were available (no keywords, paths, or domain) -- nothing to search for."],
    };
  }

  const durableRootExists = existsSync(query.durableRoot);
  if (!durableRootExists) {
    warnings.push(`No durable OpenSpec store found at "${query.durableRoot}" yet -- nothing to search there.`);
  }

  let candidates: InternalCandidate[] = [];

  if (sources.includes("specs") && durableRootExists) {
    candidates.push(...(await scanSpecs(query.durableRoot, signals)));
  }
  if (sources.includes("archivedChanges") && durableRootExists) {
    candidates.push(...(await scanArchivedChanges(query.durableRoot, signals)));
  }
  if (sources.includes("gitHistory")) {
    if (query.repositoryPath) {
      const { candidates: gitCandidates, warning } = await scanGitHistory(query.repositoryPath, signals);
      candidates.push(...gitCandidates);
      if (warning) warnings.push(warning);
      candidates = await applyMonorepoScope(query.repositoryPath, candidates, signals);
    }
    // No repositoryPath: silently skipped, not a warning -- an
    // intentional narrowing (repo not resolved yet, or caller only
    // wants OpenSpec-sourced results), not a degraded/failed source.
  }

  candidates = applyHubDampening(candidates);
  candidates = candidates.filter((c) => c.score > 0);
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Recency is a tie-breaker only, never a primary relevance signal
    // -- see the Retrieval Contract design's ranking rules.
    return (b.date ?? "").localeCompare(a.date ?? "");
  });

  return {
    candidates: candidates.slice(0, limit).map(stripScore),
    warnings,
  };
}
