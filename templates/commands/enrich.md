---
description: Clarify and confirm the requirement is understood well enough to propose a good technical change
agent: build
---
Determine whether the current task/requirement is understood well enough
to produce a good technical proposal. `/enrich` never designs the
implementation, and it does not always require human interaction -- a
requirement that is already clear should be confirmed as such and passed
through, not interrupted with manufactured questions.

**Keep the separation clear:** `/explore` understands the system and
where a change lives; `/enrich` understands the intent and whether the
requirement is complete; `/propose` designs the technical change; `/apply`
implements it. This command only does the second of those.

**Store:** This command always operates on this workspace's external OpenSpec
store. If `CE_OPENSPEC_STORE` is empty or unset, stop and tell the user to run
`ce start` first -- there is no store to work with. Every `openspec` command
below includes `--store "$CE_OPENSPEC_STORE"`.

## 1. Select the change

If a name is provided, use it. Otherwise:
- Infer from conversation context if the user mentioned a change
- Auto-select if only one active change exists
- If ambiguous, run `openspec list --store "$CE_OPENSPEC_STORE" --json` to get available changes and use the **AskUserQuestion tool** to let the user select

Always announce: "Using change: <name>" and how to override (e.g., `/enrich <other>`).

## 2. Resolve the change root

```bash
openspec status --change "<name>" --store "$CE_OPENSPEC_STORE" --json
```

Resolve `changeRoot` from this JSON -- never construct it by hand.

## 3. Detect whether this is a re-run

Check for `<changeRoot>/enrich.md` and `<changeRoot>/tasks.md`. If
`enrich.md` already exists **and** `tasks.md` exists with at least one
`- [x]` checked task, this is a re-run on a change with implementation
already underway. Treat any material change to the requirement found in
step 6 as blocking (step 7) by default in this case, and say so plainly
in the output -- ce-harness has no way to know whether already-written
code is still valid once the requirement has moved.

## 4. Gather context

- Read `<changeRoot>/explore.md` if present (read-only; this command
  never modifies it) -- it carries `/explore`'s system/context findings.
- Read current OpenSpec context for this store:
  ```bash
  openspec context --store "$CE_OPENSPEC_STORE"
  ```
- Read the task/issue itself (`CE_ISSUE`, and whatever the user has
  stated in this conversation).

Current specs and current repository state (whatever `/explore` found)
are authoritative. Nothing from step 5 below ever overrides them.

## 5. Query the Retrieval Contract

Build one retrieval query from what's known so far -- the task text,
any paths `/explore` identified, a domain/capability name if one is
already implied, and any keywords/identifiers already in view:

```bash
ce retrieve --task "<task text>" --paths "<comma-separated paths, if any>" --domain "<domain, if known>" --keywords "<comma-separated terms, if any>"
```

This prints a small ranked JSON list of candidates (never full artifact
bodies) from this project's durable OpenSpec store and Git history,
strictly scoped to this project. Parse it.

**Inspect only materially relevant candidates:**
- open the full artifact for every `"strong"`-confidence candidate
- open `"moderate"`-confidence candidates too, only if there are fewer
  than 3 strong ones
- never open more than 5 candidates in full, regardless of confidence
- every other candidate is referenced by its retrieval metadata only
  (path, type, date, `whyMatched`) -- never opened

**You may re-run `ce retrieve` at most once more**, with refined
`--keywords`/`--paths`, and only when the first pass returned zero
candidates, or only `"weak"`-confidence ones, while the task text
contains a specific term not yet tried. Never loop beyond one
refinement.

If `ce retrieve` reports a warning (e.g. no durable store yet, or the
repository's Git history couldn't be read), proceed without that source
-- this is expected, ordinary state for a new project, not a failure.

## 6. Analyze

Using steps 4 and 5, determine:
- ambiguities in what's being asked
- missing acceptance criteria
- hidden assumptions
- important constraints
- error cases / edge cases
- conflicts between the request and current behavior/specs (step 4 --
  always authoritative)
- relevant prior decisions or findings (step 5 -- cited with their
  status and date, never treated as current truth)
- questions that genuinely require human clarification

**A question belongs in Open Questions only if a different answer would
change what `/propose` designs.** Everything else is either an
assumption (state it in `enrich.md` and proceed) or a non-blocking note
-- do not create a question just to justify this stage. A clean,
unambiguous task should produce a short `enrich.md` and no questions at
all; that is a fully valid outcome.

## 7. Resolve or record blocking items

An item is blocking (and needs resolution before `/propose` should
proceed) when it is:
- a genuine conflict between the request and current behavior/specs, or
- a material ambiguity (per step 6's test above), or
- (only when step 3 detected a re-run) a change to the requirement
  found after implementation progress already exists

For each blocking item, if running interactively, use the
**AskUserQuestion tool** to resolve it now. Record the resolution --
or, if it's still unresolved, the open question itself -- in `enrich.md`
either way. Do not silently pick a resolution to a conflict or a
material ambiguity on your own.

## 8. Write `<changeRoot>/enrich.md`

This file is **not** an OpenSpec schema artifact -- like `explore.md`
and `/verify`'s and `/adversarial-review`'s `reports/` files, it is
written directly, never via `openspec instructions`, never validated by
`openspec validate`, and never tracked by `applyRequires`. If it already
exists (a re-run), update it in place -- add a one-line note near the
top of what changed, rather than starting over.

```markdown
# Requirement Understanding: <change-name>

**Status:** ready | needs-clarification
**Last updated:** YYYY-MM-DD

## Clarified Intent

1-3 sentences: what is actually being asked, in your own words.

## Confirmed Acceptance Criteria

- ...

## Assumptions

- ...

## Constraints

- ...

## Edge Cases / Error Cases

- ...

## Conflicts Identified

- request vs. current behavior/spec, if any -- or "None."

## Relevant Current Context

- current spec/code facts, from step 4

## Relevant Prior Context (historical -- current repository/specs remain authoritative)

- [historical, YYYY-MM-DD] <path> -- one-line relevance, from step 5

## Open Questions

- only present when Status is needs-clarification; "None." otherwise
```

**Keep it concise.** `Relevant Current Context` should *cite* `explore.md`
(e.g. "see explore.md's Findings on <topic>") rather than restate it --
include only the specific facts that explain an assumption, constraint,
conflict, or edge case above, never a re-summary of the whole
exploration. Prefer short bullet points over prose. A clean, well-scoped
task should produce a short `enrich.md`, not an exhaustive account.

## 9. Report back

Reply in the conversation (not only in the file) with a concise summary:

- **Understanding**: the clarified intent, in one or two sentences.
- **Acceptance criteria**: the short list confirmed.
- **Prior context cited**: what was found via retrieval and used, if
  anything.
- **Status**: `ready` or `needs-clarification`.
- **Open questions**: only if any remain -- otherwise state plainly that
  none were found and why (e.g. "the request is small and unambiguous").
- **Where to find it**: `enrich.md` was written to this change, alongside
  whatever else already exists (`explore.md`, etc.) -- `ce open --change`
  opens them all in an editor, no internal path needed.

If this was a re-run on a change with implementation already underway
(step 3), say so explicitly and recommend re-running `/propose` next --
to realign `proposal.md`/`design.md`/`tasks.md` with this updated
`enrich.md` -- before continuing `/apply`. This is what turns a
material requirement change into a durable, explicit update to the
agreed contract, rather than a change only the conversation remembers.

## Never

- Never design the technical implementation, or write `design.md` or
  `tasks.md` -- that is `/propose`'s job, not this command's.
- Never modify `proposal.md`, `design.md`, or `tasks.md`.
- Never modify `explore.md` -- read-only context for this command.
- Never open more than 5 retrieval candidates in full, and never open a
  `"weak"`-confidence candidate in full.
- Never invent a clarifying question that wouldn't change the shape of
  the technical proposal.
- Never silently resolve a conflict between the request and current
  behavior/specs -- always surface it as a blocking item.
- Never treat a historical candidate from `ce retrieve` as current truth
  -- current repository state and current specs are always authoritative.
- Never modify, create, or delete any file inside the target repository
  or its Git worktree, for any reason.
- Never create `openspec/`, `.opencode/`, reports, or any other harness
  or OpenSpec file inside the repository or worktree -- all OpenSpec and
  harness artifacts belong only in the external store at
  `$CE_OPENSPEC_STORE`.
- Never call `openspec` or `ce retrieve` without `--store "$CE_OPENSPEC_STORE"` /
  the active workspace already being current.
