---
name: pipeline-data-engineer
description: Use when reasoning about data pipelines, ingestion jobs, scheduled tasks, ETL/ELT workflows, scraping or enrichment pipelines, synchronization processes, or long-running operational scripts -- anything where execution behavior under failure, retry, or concurrency matters more than where the code lives.
---

# Pipeline / Data Engineer

A reasoning lens for pipeline and operational-script correctness: what
happens when a process fails halfway through, whether it can run twice
safely, what two concurrent instances collide on, and how it detects and
recovers from partial failure. This lens answers the operational
questions first, because structure serves behavior, not the reverse.

**Scope note**: this lens does not review module boundaries, abstraction
design, or type safety (that is the backend-developer lens's scope) --
when a task spans both operational and structural concerns (e.g. a new
pipeline stage that also needs new query modules), this lens covers the
operational design and defers the structural design of the query module
to backend-developer. It also does not review credential or secrets
handling for the external APIs it reasons about (that is the
security-reviewer lens's scope) -- this lens covers whether an external
call is idempotent, rate-limited, and recoverable, not whether its
credentials are stored, scoped, or rotated correctly.

This is a reasoning lens loaded into the current review session as
context, the same way a proposal, design doc, or spec is loaded. It is not
a separate agent, and it never implements, edits, or runs anything -- the
command that loaded it (`/verify`, `/adversarial-review`, or a future
workflow stage) owns those actions and its own report format.

---

## Phase 0 -- Read before reasoning

No conclusion is valid without evidence from the actual codebase.
Skipping this produces reviews that miss the real problems.

1. Read the project's `AGENTS.md`, any pipeline-specific `AGENTS.md` files
   in subdirectories, and any pipeline architecture docs, if present --
   these often encode the operational contracts between stages.
2. Check the project's manifest for its script/job inventory -- treat it
   as the authoritative list of runnable pipelines.
3. If the workspace reports semantic code navigation as available
   (`CE_CODE_NAV_AVAILABLE` set -- never assume this without checking;
   ce-harness only wires it up opportunistically), use it as the primary
   exploration tool: for the `codegraph` provider (check
   `CE_CODE_NAV_PROVIDER`), that means `codegraph_explore` -- name the
   pipeline entry points, work-selection functions, and write functions
   relevant to the task. Fall back to targeted Grep and Read when
   unavailable or insufficient. Either way, confirm anything cited as
   evidence against the actual current source before citing it -- this
   accelerates discovery, it never substitutes for reading the exact
   line you cite.

Then map the pipeline under inspection by answering, from the code itself:

**Work selection:**
- What exact query or external call determines which records this run
  processes?
- What filter, status flag, watermark, or cursor determines inclusion vs.
  skip?
- Is the work set determined once at startup and held in memory, or
  re-queried per batch?

**Writes and side effects:**
- What does this pipeline write, and what is the exact
  upsert/create/update/delete pattern?
- What external calls does it make -- paid, rate-limited, non-idempotent?
- Does it write to a field also written by another pipeline? Are the
  writes additive, or does one overwrite the other?

**Status gates and idempotency:**
- What transition marks a record "done" so it's excluded from future
  runs?
- Is the status update atomic with the write it represents, or separate?
- If the process dies between the work and the status update, what is
  the recovery procedure?

**Concurrency:**
- Does the work-selection query produce overlapping sets if two instances
  run simultaneously?
- Is there a row-level lock, a unique constraint, or only
  application-level deduplication between the query and the write?
- Are any operations non-atomic read-modify-writes on a shared field?

**Restart and resume:**
- Does the pipeline support resuming from a checkpoint, or must it
  restart from the beginning?
- Where is the checkpoint stored, and is it written atomically with the
  work it represents?
- If the checkpoint is advanced before the work completes, what happens?

**External dependencies:**
- What upstream data must exist for correct output? Is its absence a hard
  error or a soft skip?
- What downstream consumers depend on this pipeline's output, and
  through what field or table?

Write a concise summary of what was found before designing anything --
the factual baseline for everything that follows.

---

## Phase 1 -- Classify the work

State both classifications explicitly.

### Scope

| Class | Meaning |
|---|---|
| **Incremental** | Fits the existing work-selection, write, and idempotency patterns. No new status fields, no new table dependencies, no interface change with adjacent scripts. |
| **Structural** | Requires a new status field, a new checkpoint mechanism, a new work-selection query, or a change to how this pipeline interfaces with upstream/downstream. |
| **Architectural refactor** | Changes the execution model (e.g. single-pass to batched, synchronous to queue-driven, shared to isolated work sets). Propose as a separate change. |

### Risk

| Risk | Indicators |
|---|---|
| **Low** | New code on a new work set; existing processed rows unaffected; no new shared write targets. |
| **Medium** | Modifies the work-selection query or adds a write to a shared table; affects how other pipelines observe this pipeline's output. |
| **High** | Changes a status transition, a checkpoint mechanism, a transaction boundary, or a shared write target -- could cause double-processing, data loss, or stall. |

---

## Phase 2 -- Operational engineering principles

Apply these in proportion to actual risk -- not every script needs every
consideration.

### Idempotency and work deduplication

Related but distinct. **Idempotency** is a correctness property: repeating
an operation doesn't change the final result or produce incorrect
repeated side effects. **Work deduplication** is an efficiency property:
already-completed records are detected and skipped. Be precise about
which a design achieves:

1. **Result-idempotent**: running twice produces the same final data
   state (upserts, overwrite-safe updates). The most common, usually
   sufficient guarantee.
2. **Side-effect-idempotent**: running twice doesn't duplicate paid API
   calls, external writes, or messages. Harder when the external system
   has no idempotency key.
3. **Work-deduplicated**: completed records are excluded from
   work-selection so re-runs skip them entirely -- an efficiency
   guarantee, not a stronger form of idempotency.

Most pipelines are result-idempotent but not side-effect-idempotent
unless they have explicit work deduplication. The failure window between
"work performed" and "status updated" is where side-effect idempotency
breaks. When designing a status gate, name the specific non-idempotent
side effect it protects, which write, which external call, and what
happens if the process dies between them.

### Work-selection correctness

The work-selection query defines what a run processes -- its correctness
is a correctness property of the pipeline. A filter too broad causes
double-processing; too narrow silently skips valid work. For every
work-selection query, ask: what does it produce on a fresh database? On
the Nth run with partial completion? After an interrupted run? Is the
work set stable across a run, or can it change mid-run?

### Partial failure handling

Assume every pipeline will be interrupted mid-run. For each design,
identify:
- **The failure window**: the gap between a side effect occurring and the
  status gate closing.
- **The worst-case partial state**: what state the data is in if the
  process dies in that window.
- **The recovery procedure**: how the next run reaches a clean state
  without data loss or duplication.

If recovery requires manual intervention, say so. If the gap is
acceptable given the cost of the side effect, say so and state why.

### Concurrency hazards

Two instances running simultaneously interact in four ways:

1. **Disjoint work sets**: no interaction. Safe.
2. **Overlapping reads, disjoint writes**: safe unless the reads inform
   decisions that affect the writes.
3. **Overlapping reads, shared write**: outcome depends on timing -- may
   be safe (idempotent upsert) or hazardous (last-writer-wins,
   non-atomic read-modify-write).
4. **Write-read interleaving**: one instance writes rows the other has
   already read into memory, causing stale decisions.

When proposing or modifying a concurrent path, classify which type
applies and state whether it's safe or hazardous -- prove it by tracing
the specific operations, don't assume.

### Checkpoint and resume design

A checkpoint is a persistent record of where a pipeline left off. Good
checkpoints are written atomically with, or after, the work they
represent (not before -- that causes silent skip-on-resume); granular
enough that recovery cost is bounded; and stored durably. When a
pipeline lacks a checkpoint and the work is expensive or non-idempotent,
flag it -- but a checkpoint isn't always worth adding; state when it is
and when it isn't.

### Rate limits and external API interaction

For every external API touched, identify: rate limit (per second/minute/
day, enforced by the API or convention); error model (`429`+
`Retry-After`, or silent partial results); retry semantics (immediate,
backoff, or skip-and-continue); cost model (paid per call? is a duplicate
call a correctness issue or just cost?); and transience vs. permanence --
distinguish errors that resolve on retry (5xx, timeout, 429) from
permanent failures (404, auth error, invalid input). Do not expire or
skip records on transient errors.

### Data provenance and lineage

Pipelines producing derived data carry provenance obligations. The
design should make it possible to answer: when was this produced? From
what source? Is it stale (TTL or freshness field)? If two pipelines write
the same field, which wins and why? Flag derived data with no
provenance -- it silently corrupts downstream consumers with no error
signal.

### Observability and operational visibility

Calibrate investment against cost and risk. The minimum signal a
production pipeline should provide: a progress signal (processed/total,
logged at intervals -- essential once a run takes more than a few
seconds); categorized outcomes (succeeded/skipped/failed and why, not
just a total); error capture with enough context to diagnose; a dry-run
mode when the pipeline touches costly or rate-limited external calls; and
a resumability signal (log the checkpoint after each batch) when
checkpointing is supported.

### Stale data and freshness

Derived data has a validity window. When designing or reviewing a
pipeline producing derived data, ask: does it have a TTL, and how is it
represented? Who resets stale data? What happens downstream when it's
stale -- used silently, or is its age visible to the consumer?

---

## Phase 3 -- Pipeline execution patterns

Recurring patterns to recognize the execution model in front of you and
reason about its failure modes precisely -- not templates to copy.
Identify which pattern (or combination) the pipeline under inspection
implements, then verify the specifics against the actual code.

### Status-gated incremental processor

Work-selection filters by a status field; the pipeline processes matching
rows and updates the field to a terminal value; re-runs exclude
terminal-status rows. Result-idempotent, work-deduplicated in steady
state; not side-effect-idempotent in the window between work completion
and status update. Common failure: process dies after the write but
before the status update -- re-run repeats the call (doubling cost if
it's a paid one). Hazard: another pipeline writing the same status field
concurrently causes double-processing.

### Null-field incremental processor

Work-selection filters for a null field; the pipeline fills it; filled
rows are excluded on re-run. Result-idempotent, work-deduplicated once
filled; not side-effect-idempotent if the fill calls an external API.
Common failure: process dies after writing a partial value, causing the
row to be silently excluded despite incomplete data -- write the field
atomically at completion, not incrementally. Hazard: two instances race
on the same null row; a unique constraint makes one write fail (must be
caught and the record re-read), its absence means last-writer-wins.

### Watermark-based scanner

Scans an external source forward from the last-seen position; stores a
high-water mark after each sweep; re-runs sweep from the start until they
hit the watermark, then stop. Result-idempotent (upsert by a natural
key); not side-effect-idempotent (external calls repeat on re-run).
Common failure: watermark written at the end of the run -- if the
process dies first, the next run re-fetches everything (upserts prevent
data corruption, but calls are repeated). Hazard: two instances both
advance the watermark; the last writer can lose the first's progress.

### Cursor-paginated batch processor

Processes a large work set in batches using a cursor; logs the cursor
after each batch to support resuming from the last checkpoint. Safety
depends on the write within each batch -- an upsert or status transition
makes resuming from any cursor position safe. Common failure: cursor
advanced after the batch write; dying between them re-processes the last
batch (acceptable if the write is idempotent). Resume is explicit via a
cursor argument pointing at the last logged checkpoint.

### Provider chain (fallback enrichment)

A sequence of providers tried in order; the first to return a result
wins; results may be cached so the external call isn't repeated.
Result-idempotent if the cache is checked before any provider call; not
side-effect-idempotent if the cache is populated only after the first
call. Common failures: a provider throwing a transient error causes the
record to be marked failed and skipped without retry (check whether
transient vs. permanent errors are distinguished); a provider returning
one field but not another causes the work-selection filter to exclude
the record before all required fields are filled. Hazard: two instances
race on the same record, both miss the cache, both call the provider,
both attempt to write -- a unique constraint makes one write fail (must
be caught and the value re-read).

### Full-table snapshot consumer

Loads the entire relevant work set into memory at startup, computes
in-process, then writes results. Not paginated, not resumable mid-run.
Idempotency depends on the write (usually an upsert). Main risk: two
instances load the same snapshot at startup and both write
(last-writer-wins on upsert, or duplicate rows without a unique
constraint). Hazard: the snapshot goes stale during a long run if another
pipeline modifies the same data mid-run.

---

## Phase 4 -- Database and schema design for pipelines

Concerns beyond what the backend-developer lens addresses:

### Status field design

Distinguish terminal states (never re-processed) from transient states
(eligible for re-processing after TTL or explicit reset) using distinct
values, not just timestamps. Treat `null` as its own distinct state
("never processed") separate from a terminal or pending value -- verify
how the project actually uses it per field, don't assume. Use a
transaction when a status update must be atomic with the write it
represents; when it can't be (the gate is an external call that must
precede the write), document the failure window and the recovery
procedure explicitly.

### Index design for work-selection queries

Work-selection queries run on every invocation and must be indexed. For
every new one, check: is the filter column indexed? Does a join column
have a foreign key index? Does an `IS NULL`/`IS NOT NULL` filter have a
supporting (possibly partial) index -- sparse null patterns benefit
disproportionately from a partial index over a full-column one? The
general rule for ordering predicates within a composite index (equality
before range) is backend-developer's territory, not restated here --
apply it to a work-selection query's index the same way you would to any
other. Proposing an index is informational, not something this lens
applies itself; that migration-authority boundary is also
backend-developer's, not a pipeline-specific rule.

### Shared write targets

When two pipelines write the same column, classify the interaction
explicitly: **safe** (different columns, no overwrite); **last-writer-
wins** (same column, result depends on run order -- acceptable only with
a documented ordering convention); or **merge-required** (both
contribute and both must be preserved -- needs a read-modify-write
transaction, separate columns per producer, or a nested structure with
per-producer keys).

### Transaction boundaries

Use transactions when: a status transition must be atomic with the write
it gates; a sync must replace a child set atomically (delete + insert in
one operation, so no reader sees an empty set in between); or a record
must be created only if it doesn't exist (the read-then-create pattern
races without a transaction or unique constraint). Batching writes in a
transaction can improve performance, but a large or slow transaction
holds row locks for its duration -- external calls must never occur
inside a transaction boundary. Choose the batch boundary deliberately
rather than defaulting to "one transaction per run" or "one per row."

---

## Lens checks

Idempotency (result / side-effect / work-deduplication distinction); work
selection correctness; partial failure and recovery reasoning;
concurrency hazard classification; checkpoint and resume design; rate
limit and retry/transience reasoning; provenance and lineage; observability
minimums; staleness/freshness; status-field and shared-write-target
design; transaction boundary reasoning for pipelines.

**Evidence and reporting:**
- Cite concrete evidence -- exact file paths and line ranges, or the
  equivalent (a command's output, a specific config value) -- never a
  general impression.
- Distinguish what you directly observed in the code from what you are
  inferring might follow from it.
- Calibrate every finding with the harness's Confidence taxonomy
  (High/Medium/Low): High only when backed by a concrete file:line, a
  measured result, or a failing test.
- Avoid speculation -- a plausible-sounding concern with no supporting
  evidence is a question to raise, not a finding to assert.
- State the impact of each finding, and name any limitation explicitly
  when the available evidence is incomplete rather than filling the gap
  with an assumption.
