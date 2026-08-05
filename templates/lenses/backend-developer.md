---
name: backend-developer
description: Use when reasoning about backend or server-side code in any language or stack -- module boundaries, data access, dependency management, type safety, error handling, testability, or database/query design. Applies to new features, code reviews, module design, query authoring, and API design, regardless of framework.
---

# Backend Developer

A reasoning lens for backend and server-side code: module boundaries, data
access, dependency seams, type stability, testability, and database/query
design. It evaluates code against engineering principles, not against a
fixed named architecture -- it does not arrive at a codebase having already
decided its shape.

**Scope note**: this lens does not review pipeline or operational-script
execution behavior -- idempotency, retries, checkpointing, concurrency
(that is the pipeline-data-engineer lens's scope), does not go deep on
type-system mechanics -- soundness, narrowing, variance (that is the
typescript-engineer lens's scope), does not review UI/component
architecture or client-side rendering (that is the frontend-developer
lens's scope), and does not review trust-boundary, injection, or
authorization depth (that is the security-reviewer lens's scope). This
lens covers module boundaries, dependency seams, and database/query
design for backend and server-side code generally; when a task is
squarely inside one of those four other domains, defer to the lens that
owns it.

This is a reasoning lens loaded into the current review session as context,
the same way a proposal, design doc, or spec is loaded. It is not a
separate agent, and it never implements, edits, or runs anything -- the
command that loaded it (`/verify`, `/adversarial-review`, or a future
workflow stage) owns those actions and its own report format.

---

## Phase 0 -- Read before reasoning

No conclusion is valid without evidence from the actual codebase. Skipping
this produces reviews that miss the real problems.

1. Read the project's `AGENTS.md`, `README`, or equivalent, if present --
   these often contain rules that override general engineering defaults.
2. Check the project's manifest (`package.json`, `pyproject.toml`,
   `Cargo.toml`, `go.mod`, `Gemfile`, or equivalent) for the tech stack,
   scripts, and workspace layout.
3. If a `.codegraph/` index exists at or above the project root, use
   `codegraph_explore` as the primary exploration tool -- name the
   symbols, files, or call chains relevant to the change; it returns
   verbatim source and call paths in one round-trip. Fall back to
   targeted Grep and Read only when no index is present.

Then characterise the existing architecture by answering, from the code
itself:

1. **Module boundaries**: how is the project divided, and what are the
   conventions for what belongs where?
2. **Data access pattern**: where do queries live -- inline, in dedicated
   query modules, behind interface abstractions? What query tool or ORM
   (if any) is used?
3. **Dependency management**: how are side-effectful dependencies (DB
   clients, HTTP clients, external SDKs) made available -- singletons,
   passed arguments, locally instantiated? A singleton exported from a
   single initialisation module is a legitimate pattern; the question is
   whether callers can substitute it for testing.
4. **Side-effect boundaries**: where do HTTP calls, queue publishes, file
   I/O, and external API calls happen -- isolated at the edges, or
   scattered through business logic?
5. **Type discipline**: is the codebase strictly typed? Are boundary types
   stable, or wide aliases that could silently accept anything?
6. **Error handling**: thrown exceptions, typed error objects, returned
   `Result` types, or a mix? Is there a consistent, documented convention?
7. **Test approach**: what framework, where do tests live, what is
   mocked vs. hitting real infrastructure?
8. **Existing abstractions**: what already exists? Are they consistently
   used or bypassed? A bypass pattern is often more informative than the
   abstraction itself.

Write a 3-5 sentence characterisation of what was observed. This is the
factual baseline for everything that follows.

---

## Phase 1 -- Classify the work

State both classifications explicitly.

### Scope

| Class | Meaning |
|---|---|
| **Incremental** | Fits the existing structure. No new modules, no boundary changes. |
| **Structural** | Requires a new module, a new abstraction, or a meaningful shift in an existing boundary. Worth calling out explicitly. |
| **Architectural refactor** | Changes how multiple modules relate. Should be a separate, explicit change -- not bundled into a feature. |

### Risk

| Risk | Indicators |
|---|---|
| **Low** | Adds new code; existing callers unaffected. |
| **Medium** | Modifies shared utilities, query modules, or types with multiple callers. |
| **High** | Changes module contracts, removes abstractions, or alters schema. |

---

## Phase 2 -- Engineering principles

Heuristics informed by engineering experience, not laws. Every principle
has a context where it should yield -- when applying one, name it; when
trading it off, say what for.

### Separation of concerns

A module that does two things has two reasons to change and two behaviours
to test. Split when the concerns evolve at different rates or testing one
requires setting up the other. Keep together when the concerns are
structurally coupled and splitting adds indirection with no isolation
benefit. The question is not "can this be split?" -- it's whether splitting
makes each part meaningfully easier to understand, test, or replace.

### Dependency management at the right seam

Side-effectful dependencies (database clients, HTTP clients, external
SDKs, clocks, queues) should be injectable at the seam where they need to
be swapped or faked -- not necessarily at every call site. A client
initialised once at startup and exported from a single module is a
legitimate pattern; the seam is at the module level. The problem is when
that client is used directly in logic that should be unit-testable
without live infrastructure -- there, pass the relevant functions (or an
interface over them) as arguments. The principle is: identify where a
seam is needed for testing or substitution, and make it explicit. Pure
utilities need no injection.

### Type stability at module boundaries

Every public function and export needs an explicit type signature -- but
explicit is necessary, not sufficient. Types at a boundary must be
*stable*: a change to the implementation should cause a type error at the
caller if the contract changed. Signs of weak typing: untyped `any`,
unnarrowed `unknown`, wide generic record shapes, or re-exported
infrastructure types that leak implementation details. Internal details
can tolerate weaker types when the scope is genuinely small.

This principle covers whether a boundary is typed at all and whether it
stays honest over time. Deeper type-system questions -- soundness of a
generic, exhaustiveness of narrowing, variance of a shared mutable
structure -- are the typescript-engineer lens's scope, not this one's.

### Testability as a design signal

Hard-to-test logic is a design signal, not a testing problem. Hidden
dependencies, multiple concerns, or deeply nested control flow are the
usual causes -- the fix is almost always a design change. Identify the
scenarios that matter (happy path, key error path, critical invariants
like access control or data integrity) rather than mandating a fixed
coverage number; risk-proportionate coverage is the standard. Use the
test framework already present; introducing a new one needs explicit
justification.

### Maintainability: prefer the boring solution

Clever code is a liability. Prefer what a new team member can understand
in five minutes over what requires tracing three levels of abstraction --
this is not an argument against abstractions, only against abstractions
that exist for their own sake. When an abstraction exists and works, use
it consistently; when it's bypassed by multiple callers, that bypass is
the de facto standard -- either fix the abstraction or delete it and make
the bypass official.

### Abstraction: earn it before introducing it

The most common source of unnecessary backend complexity is introducing
abstractions before there's evidence they're needed. Before proposing any
new abstraction (interface, base class, service layer, repository, policy
object), be able to state all three:

- **What concrete problem it solves** -- a specific pain, not a category
  like "separation of concerns."
- **What future change it protects against** -- name the change.
- **Why the complexity is proportional** -- indirection cost vs. benefit
  at current and anticipated scale.

If any of the three can't be answered, record it as a candidate for
later. Two distinct consumers is a reliable trigger for extraction, but
not automatic justification -- a shared helper function may be enough.

### Code quality at the implementation level

- **Naming**: does the name tell you what the thing does, or do you have
  to read the body to find out?
- **Function length and cognitive complexity**: can you write a
  one-sentence docstring for it?
- **Dead code and unused exports**: exported symbols with no callers,
  commented-out blocks, stale `TODO`s.
- **Inconsistency within a module**: two different patterns doing the
  same thing in the same file is a sign a decision was never made.

---

## Phase 3 -- Named architectural patterns are tools, not defaults

Named patterns (domain-driven design, CQRS, event-driven architecture,
pipeline patterns, clean architecture, and any specific framework or ORM)
are tools with known trade-offs -- apply them when the specific problem
they solve is present in this codebase; decline them when it isn't. Never
assume any one of them, or any particular framework, as a default.

- **Domain modeling with explicit invariants** is appropriate when
  business rules are complex enough that embedding them in query modules
  or service functions makes those hard to test and reason about
  independently, or when the same invariant must be enforced across
  multiple entry points and can't be reliably expressed as a DB
  constraint alone. It is not appropriate for simple CRUD, a small team
  where the ceremony costs more than it saves, or when the existing
  codebase already uses a simpler, working approach.
- **Pipeline patterns** are appropriate when the work is a sequence of
  stages with clear inputs and outputs, independently testable, where the
  sequence itself may vary.
- **Read/write separation (event-driven or CQRS-style)** is appropriate
  when reads and writes have significantly different scaling or
  consistency requirements, or multiple downstream consumers react to the
  same state change.

When recommending a named pattern, state which specific problem in this
codebase it solves and what the adoption cost is. When declining one,
say so and propose a simpler alternative that still satisfies the
engineering principles above.

---

## Phase 4 -- Database and query design

Whenever the work touches data access:

1. **Locate where queries live** and follow the project's existing
   convention for where new ones belong.
2. **Check index coverage**: for every new filter or sort, verify an
   index covers it. If not, note the gap -- proposing an index is
   informational; applying a schema change requires explicit review and
   a migration, never assume this lens can do that itself.
3. **Composite index prefix rule**: a composite index on `(a, b)` serves a
   query that filters on `a` and sorts on `b`, but only when `a` is
   constrained. An unfiltered sort on `b` alone needs its own index on
   `(b)`. This holds for any database with B-tree indexes, regardless of
   ORM.
4. **N+1 queries**: a loop issuing one query per iteration should be
   flagged, with a batched or joined alternative proposed.
5. **Transaction boundaries**: when multiple writes must succeed or fail
   atomically, identify and name the boundary explicitly. For a
   pipeline's status-gate or idempotency-specific transaction reasoning,
   see the pipeline-data-engineer lens's deeper treatment instead of
   re-deriving it here.

---

## Lens checks

Read before reasoning; scope classification; risk classification;
separation of concerns; dependency management at the right seam; type
stability at boundaries; testability as a design signal; maintainability
and the boring-solution preference; abstraction discipline (the
three-question justification); named patterns as tools, not defaults;
query/index/transaction reasoning.

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
