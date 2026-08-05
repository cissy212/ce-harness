---
description: Independently hunt for defects, gaps, and risks in an OpenSpec change before archiving -- assumes flaws exist until argued against with evidence
---

Act as an **independent adversarial reviewer** for the active OpenSpec
change: assume gaps, flaws, or unsafe behavior may exist until you have
argued against them with evidence.

This skill is intended for the verification window of spec-driven
development (after implementation, before archiving), when the human runs
a different agent or session than the one that implemented the change.

Do not prescribe which agent, model, or IDE to use. That is the human's
choice.

This command checks conformance **and** looks beyond it for defects,
regressions, and risks the specification itself doesn't describe. It runs
after `/verify` and independently challenges that conformance baseline
rather than duplicating it. It never modifies the target repository, the
worktree, or task checkboxes; it only reads evidence and writes a report
into the external OpenSpec store.

## 0. Guard

If `CE_OPENSPEC_STORE` or `CE_WORKTREE` is empty or unset, stop and tell the
user to run `ce start` first -- there is no store or worktree to review
against. Every `openspec` command below includes
`--store "$CE_OPENSPEC_STORE"`. All code inspection happens only inside
`$CE_WORKTREE`.

**Input**: Optionally specify a change name (e.g., `/adversarial-review
add-auth`). If omitted, infer it from conversation context or auto-select if
exactly one active change exists; if ambiguous, list changes and ask the
user to choose. Never guess.

## 1. Resolve the change

```bash
openspec list --store "$CE_OPENSPEC_STORE" --json
openspec status --change "<name>" --store "$CE_OPENSPEC_STORE" --json
```

Read from the status JSON -- never assume a repo-local `openspec/` path:
- `changeRoot` -- the change's directory inside the external store; every
  path in this command (including the report destination) is resolved from
  here or from `artifactPaths`, never hand-constructed
- `artifactPaths` -- resolved paths for proposal, design, specs, tasks (use
  `existingOutputPaths` for files that actually exist)

If the change cannot be resolved unambiguously, ask the user before
proceeding.

## 2. Mindset

Borrowed from common red-team / adversarial practice:

- **Assume gaps, flaws, regressions, or unsafe behavior may exist** until
  disproven by evidence -- do not default to trusting the implementation.
- **Try to break the implementation**, not only to confirm the happy path.
- **Challenge incorrect assumptions** about data shape, timing, ordering,
  authz, idempotency, and error handling.
- **Trace cross-boundary and composition risks**: pieces that look fine in
  isolation but fail together (multi-file, API plus UI, retries plus side
  effects).
- **Treat the diff as incomplete context**: missing tests, missing negative
  paths, or spec drift can hide issues.
- **Calibrate depth** to risk: auth, payments, PII, privilege boundaries,
  and data mutation deserve stricter scrutiny.
- **Never invent findings merely to appear adversarial.** A finding needs
  evidence; a hunch that isn't backed by anything you actually read is not
  a finding -- say so explicitly instead of inventing one.

## 3. Load the specification side

Read, in order, whichever of these exist (from `artifactPaths`, inside the
external store):
1. The change's `proposal.md` -- scope and non-goals
2. The change's `design.md`, if it exists -- technical commitments
3. All delta specs under the change's `specs/` directory, including their
   scenarios
4. The change's `tasks.md` -- checked and unchecked tasks

Extract the acceptance criteria and explicit non-goals: list what must be
true for "done." Note anything underspecified -- ambiguous acceptance,
missing error cases, missing security constraints.

## 4. Check for an existing verify report -- and challenge it

Look for the most recent `<changeRoot>/reports/*-verify.md` file (written by
a prior `/verify` run), if any.

**If one exists:**
- Read it in full, including its evidence, its `Gaps and Blockers`, and its
  `Overall Verdict`.
- Do not accept its conclusions at face value. For each `VERIFIED` item,
  independently sanity-check at least the higher-risk ones -- was the cited
  evidence actually sufficient, or does it only cover the happy path?
- For each `BLOCKED` or `PARTIALLY VERIFIED` item, ask whether it can now be
  resolved with a different approach, or whether it represents a real,
  unaddressed gap.
- If the prior verdict was `PASS`, actively look for what it might have
  missed -- this review's job is exactly the case where verify said
  everything was fine.
- Record whatever you found in the "Verify Report Challenge" section of the
  report (Step 7), even if your conclusion is "the prior verdict holds."

**If none exists:** note this in the report and proceed to establish your
own evidence from scratch (Step 5) -- do not skip the review because no
baseline exists.

Avoid redoing the entire verification pass move-for-move; reuse the prior
report's evidence where it's genuinely sufficient, and spend your effort on
challenging it and looking beyond it, not re-deriving it.

## 5. Load the implementation side

Determine the diff scope, entirely inside `$CE_WORKTREE`:

```bash
git -C "$CE_WORKTREE" status --porcelain
git -C "$CE_WORKTREE" log --oneline -20
```

To find a base for a proper diff, try the common base-branch names in order
(mirrors how `ce start` itself picks a base branch) and use whichever
exists:

```bash
git -C "$CE_WORKTREE" merge-base HEAD main    2>/dev/null
git -C "$CE_WORKTREE" merge-base HEAD master  2>/dev/null
```

If a merge base is found, review the full diff scope against it
(`git -C "$CE_WORKTREE" diff <merge-base>...HEAD`), not just the default
file ordering. If neither `main` nor `master` exists as a reachable branch,
note this as a scope limitation and fall back to reviewing `HEAD` and the
uncommitted diff only.

Map files and changes to spec sections and tasks.

## 6. Select a lens (if one clearly matches)

ce-harness -- not the runner -- owns lens selection. Never rely on the
runner's own automatic skill or agent matching for this. Discover and
read reasoning lenses **only** through the canonical, runner-agnostic
directory at `"$CE_LENSES_DIR"` (injected by `ce start`); never assume or
hardcode any runner-specific path such as `opencode/agents/`.

1. If `CE_LENSES_DIR` is unset, or the directory contains no `*.md`
   files, skip this step entirely -- proceed without a lens and report
   `Lens applied: None` in the "Lens Coverage" section of the report.
   This is not a failure.
2. Otherwise, list every available lens (every `*.md` file directly
   inside `"$CE_LENSES_DIR"`) and read each one's `description`
   frontmatter field.
3. Compare each description against the proposal, design, specs,
   scenarios, and tasks loaded above, and the implementation diff just
   gathered.
4. If both an operational/runtime concern (execution behavior,
   idempotency, retries, concurrency, checkpoints, partial failure) and a
   structural concern (module boundaries, abstraction design, type/API
   design) apply to this change, prefer the lens describing the
   operational/runtime concern -- operational concerns take precedence.
5. If exactly one lens clearly matches, select it.
6. If no lens clearly matches, select none and continue normally --
   report `Lens applied: None`.
7. If two or more lenses match equally well, do not guess: ask the user
   which one to apply (or whether to apply none).
8. Always allow an explicit user override: if the user has already named
   a specific lens (or "none"), use that instead of steps 2-7.

If a lens is selected, load its file as an ordinary reasoning input for
the rest of this review -- exactly like `proposal.md`, `design.md`, or
`tasks.md`. Do not spawn a subagent, delegate to another conversation, or
treat it as a runner-specific skill/agent invocation; it is simply
another document you have read. Apply it as an additional adversarial
lens in the pass below (e.g. a pipeline lens sharpens the search for
idempotency/concurrency/partial-failure defects; a backend lens sharpens
the search for boundary, type-safety, and query defects).

Record the outcome (selected lens or "None", the rationale, and which
other lenses in `"$CE_LENSES_DIR"` were considered) for the "Lens
Coverage" section of the report.

## 7. Adversarial pass (refute, do not rubber-stamp)

For each acceptance criterion or scenario:

1. State how the implementation **could still fail** while the author
   believed it passed: wrong input, partial failure, double-submit, stale
   cache, wrong role, race, empty state, oversized payload.
2. Check **negative and abuse cases** where relevant: validation bypass,
   IDOR-style access patterns, replay, conflict handling.
3. Check **tests and any verification artifacts**: do they prove the
   criterion, or only the happy path?
4. Record **spec-vs-code mismatches** (spec says X, code does Y) as
   first-class findings.
5. Look for missing edge cases, regressions relative to what existed
   before, incomplete implementation (partially done tasks or scenarios),
   unsafe behavior, and spec/code drift.

Classify each finding along three independent axes -- Severity, Area, and
Confidence are not the same thing, and a finding can be high-severity and
low-confidence (or the reverse):

**Severity:**
- **BLOCKER**: incorrect behavior, security/privacy issue, or spec
  violation that should stop archive.
- **MAJOR**: likely bug or significant gap; fix or spec update required
  before archive.
- **MINOR**: clarity, maintainability, or low-risk gap; can follow up.

**Area** (pick exactly one; use `Other: <label>` if none fit):
Logic, Auth/Authz, Data integrity, Error handling, Tests, Spec conformance,
Security, Performance, Docs/Spec, Other: `<label>`.

**Confidence** (kept separate from Severity):
- **High** -- supported by concrete evidence such as file and line
  references, measured output, or a failing test.
- **Medium** -- supported by code reading and reasoning but not yet
  verified by execution.
- **Low** -- plausible based on pattern recognition but still speculative.

For each finding, state whether the fix belongs in **code**, **tests**,
**OpenSpec artifacts** (scenarios, specs, tasks), or **documentation**.

## 8. Write the report

Resolve the report destination from `changeRoot` (never construct it by
hand):

```bash
mkdir -p "<changeRoot>/reports"
# write to: <changeRoot>/reports/<YYYY-MM-DD>-adversarial-review.md
```

Use today's date in the filename. This directory and file live **only**
inside the external OpenSpec store at `$CE_OPENSPEC_STORE` -- never create a
`reports/` directory, `openspec/` directory, `.opencode/` directory, or any
other file inside the target repository or its Git worktree.

### Report structure

```markdown
# Adversarial Review: <change-name>

**Review type:** OpenSpec change
**Date:** YYYY-MM-DD
**Change:** <changeRoot>
**Scope:** <what this review covers>
**Spec sources:** <artifact paths read>
**Implementation sources:** <worktree diff range examined>
**Verify report reviewed:** <path inside changeRoot/reports/, or "None found">
**Scope limitations:** <limitations or "None declared">

> This is an AI-generated review draft. A human reviewer must validate the findings before acting on them or publishing them externally.

---

## Requirement Coverage

| Requirement | Examined? | Outcome | Notes |
|---|---|---|---|
| <acceptance criterion text> | Yes / No | Pass / Issues found / N/A | |

**Underspecified areas:** <list or "None">

---

## Lens Coverage

**Lens applied:** <name from $CE_LENSES_DIR, or "None">
**Selection rationale:** <why this one was selected, or why none was, in 1-3 sentences>
**Other lenses considered:** <other lens names found in $CE_LENSES_DIR, or "None found">
**Lens checks applied:** <the "Lens checks" list from the selected lens's file, or "N/A">

---

## Verify Report Challenge

<what was challenged in the existing verify report and what you concluded, or "No verify report found; evidence established from scratch in this review.">

---

## Risk-Mitigating Observations

<!-- Optional. Include only when a concrete decision directly mitigates a documented risk. Omit this section if there are no meaningful observations. Do not include generic praise. -->

---

## Findings

| Severity | Area | Confidence | Affected Requirement/Design/Task | Finding | Evidence | Impact | Recommended Fix |
|---|---|---|---|---|---|---|---|
| BLOCKER / MAJOR / MINOR | Logic / Auth-Authz / Data integrity / Error handling / Tests / Spec conformance / Security / Performance / Docs-Spec / Other: `<label>` | High / Medium / Low | <requirement, design decision, or task> | <what you found> | <file:line, diff hunk, test output> | <what happens if unaddressed> | code / spec / tests / docs |

---

## Pre-Existing Issues Noticed

<bullet list of issues that predate this change and aren't caused by it, or "None noticed.">

---

## Overall Verdict

PASS

**Reason:** No blockers or majors found.
```

Use exactly one of these three verdict tokens, with a `**Reason:**` line
after it:
- `PASS` -- no `BLOCKER` or `MAJOR` findings; `MINOR`s may be listed.
- `PASS WITH GAPS` -- `MINOR` findings only; no `BLOCKER` or `MAJOR`.
- `FAIL` -- at least one `BLOCKER` or `MAJOR` finding.

## 9. Report back (no automatic fixes)

After writing the report, tell the user its path (inside the external
store) and the overall verdict. You may **suggest** fixes for any findings
in the chat response, but never apply them automatically -- this command
only reviews and reports. If the user wants to act on a finding, that is a
separate, explicit step.

**Guardrails**
- Every `openspec` command must include `--store "$CE_OPENSPEC_STORE"`.
- Never assume repo-local `openspec/` paths -- always resolve `changeRoot`
  and `artifactPaths` from the CLI's JSON output.
- Never invent a finding you don't have evidence for -- every finding must
  state the affected requirement/design decision/task, its impact, its
  Area, its Confidence, and a recommended fix. Evidence discipline is
  mandatory:
  - cite concrete file paths and line ranges where available;
  - cite diff hunks, commands, logs, or test output where relevant;
  - **Avoid vague references.**
  - keep confirmed defects (backed by evidence) clearly separate from
    speculative concerns (pattern-recognition only -- Low confidence);
  - missing or unobtainable evidence must be reported as an uncertainty
    (Low/Medium confidence, or an open question) -- never converted into a
    defect finding just because you couldn't rule it out.
- Do not duplicate the full verification pass when a recent verify report
  already exists and is trustworthy for a given item -- reuse it, but
  actively challenge its assumptions, gaps, blocked items, and PASS verdict
  rather than accepting it at face value.
- Never modify product/application code. This command reviews; it does not
  implement or fix.
- Never check, uncheck, or otherwise edit `tasks.md` or any other OpenSpec
  artifact.
- Never create `openspec/`, `.opencode/`, `reports/`, or any other
  harness/config file or directory inside the target repository or its Git
  worktree -- the review report belongs only inside the external store at
  `$CE_OPENSPEC_STORE`.
- Lenses are discovered and read only through `"$CE_LENSES_DIR"` -- never
  hardcode `opencode/agents/` or any other runner-specific path. Never
  rely on the runner's own automatic skill/agent selection; selection is
  an explicit step this command owns.
- A selected lens is loaded as an ordinary reasoning input (like
  `proposal.md` or `tasks.md`) -- never spawned as a subagent and never
  delegated to as a separate conversation.
- Do not praise the implementation to "balance" criticism unless a strength
  directly mitigates a documented risk (use the optional Risk-Mitigating
  Observations section for that, never as filler in Findings).
- If you cannot access the diff or a referenced artifact, say so and list
  exactly what is needed to continue.

This command does not implement retrospective, intensity levels, export,
or archive gating -- those remain out of scope for this version.

_See `THIRD_PARTY_NOTICES.md` for this command's provenance and licensing._
