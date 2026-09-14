---
description: Independently hunt for defects, gaps, and risks in an implementation before archiving, or in an existing pull request -- assumes flaws exist until argued against with evidence
---

Act as an **independent adversarial reviewer**: assume gaps, flaws, or
unsafe behavior may exist until you have argued against them with
evidence.

This skill is intended for the verification window of spec-driven
development (after implementation, before archiving), when the human runs
a different agent or session than the one that implemented the change.

Do not prescribe which agent, model, or IDE to use. That is the human's
choice.

This command supports two workspace types, first-class -- detect which
one applies from the workspace's own type (the same distinction `ce
status`/`/workspace` already report, equivalently whether `CE_DIFF_BASE`/
`CE_DIFF_HEAD` are set):

- **Implementation workspace** (the default `ce start` flow): reviews an
  OpenSpec change's implementation. Checks conformance **and** looks
  beyond it for defects, regressions, and risks the specification itself
  doesn't describe. Runs after `/verify` and independently challenges
  that conformance baseline rather than duplicating it.
- **Existing PR review workspace** (`ce start --base --head`): reviews an
  already-given commit range directly. There is no OpenSpec change here
  to check conformance against, and this command never tries to resolve,
  require, or invent one -- never perform proposal/design/tasks/spec
  conformance checks in this workspace type. The PR description, the
  target repository's own conventions and documentation, and the commit
  range itself are the review baseline instead. `/verify` refuses to run
  in this workspace type (see its own guard); this command is the only
  review step here.

Both workspace types share the same adversarial mindset, baseline pass,
lens selection, finding classification, and verdict rules below -- only
how the review baseline is established (Steps 1 and 3), whether a prior
`/verify` report is consulted (Step 4), and the report's identifying
fields and destination (Step 9) differ. Each step below calls out
explicitly where the two workspace types diverge; everything not called
out is identical for both. It never modifies the target repository, the
worktree, or task checkboxes; it only reads evidence and writes a report
into the external OpenSpec store.

## 0. Guard

If `CE_OPENSPEC_STORE` or `CE_WORKTREE` is empty or unset, stop and tell the
user to run `ce start` first -- there is no store or worktree to review
against. Every `openspec` command below includes
`--store "$CE_OPENSPEC_STORE"`. All code inspection happens only inside
`$CE_WORKTREE`.

**Detect the workspace type before anything else.** If `CE_DIFF_BASE` and
`CE_DIFF_HEAD` are *not* both set, this is an **Implementation
workspace** -- use every "Implementation workspace" branch below; skip
straight to **Input** below.

If `CE_DIFF_BASE` and `CE_DIFF_HEAD` *are* both set, this workspace was
created to review an existing, already-given commit range -- but that
alone never decides the type: a review workspace can legitimately
transition into real implementation (the reviewer discovers the PR needs
repair, then runs `/explore` -> `/enrich` -> `/propose` -> `/apply`
inside this same workspace). Run:

```bash
ce diff-scope
```

and read its `reviewTransition` field:

- **`null` or `{"detected": false, ...}`** -- no active change owned by
  this workspace has an implementation-base marker recorded by `/apply`
  (see below). This is an **Existing PR review** workspace -- use every
  "Existing PR review workspace" branch below.
- **`{"detected": true, "changeName": "<name>", ...}`** -- deterministic
  evidence (an implementation-base marker `/apply` itself recorded for
  `<name>` the first time it began implementing -- something only
  `/apply`, and nothing else in the workflow, ever writes) shows this
  workspace has transitioned from review into implementation. Treat this as an
  **Implementation workspace** for the rest of this command, reviewing
  `<name>`'s implementation -- use every "Implementation workspace"
  branch below. **You already have this invocation's diff-scope result
  from the call above -- reuse it directly in Step 5 rather than calling
  `ce diff-scope` again.** Record in the report (Step 9) that this
  workspace originated as a review of an external commit range and
  transitioned into implementation -- never let this look
  indistinguishable from a workspace that started as an Implementation
  workspace from the beginning.

Never infer the type any other way -- in particular, never treat the mere
existence of an OpenSpec change, a validated `/propose` plan, or a
worktree that merely differs from the original PR head as implementation
on its own: a user could run `/propose` and then hand-edit any file,
satisfying all three without `/apply` ever running, which would
incorrectly unlock treating this as an Implementation workspace.
`reviewTransition` requires the dedicated implementation-base marker
`/apply` itself writes (see `templates/commands/apply.md`), the one
signal nothing else in the workflow ever produces.

**Detect a follow-up review (Existing PR review workspace only, never
transitioned).** A user re-runs `ce review <repo> <pr-number>` when the
pull request has new commits since it was last reviewed here; `ce
review` itself fetches those commits and moves this workspace's worktree
forward before relaunching, so by the time you are reading this, `git
log`/`git diff` already reflect the new code -- this step is only about
recognizing that a *previous* review of this same workspace exists, so
you treat it as a follow-up instead of a from-scratch review.

If `CE_PR_NUMBER` is set, look for an existing report in this order
(never write anything yet -- this is discovery only):

```bash
ls "<root.path>/reviews/"*"-pr-${CE_PR_NUMBER}-adversarial-review.md" 2>/dev/null | sort
```

(`<root.path>` is read from `openspec list --store "$CE_OPENSPEC_STORE" --json`
in Step 1 below -- if you haven't run Step 1 yet, do that first.)

- **One or more files found** -- this is a **follow-up review**. Take the
  last one (sorted, so the most recent). Read it in full now -- its
  Findings tables are what Step 8 below verifies against the new code.
  Also extract its `**Reviewed PR head:**` field (the exact SHA it
  covered) -- this is the base of the delta you'll diff in Step 5.
- **None found**, but `CE_PR_NUMBER` is set -- also check the legacy,
  pre-PR-scoping filename convention as a fallback:
  ```bash
  ls "<root.path>/reviews/"*"-adversarial-review.md" 2>/dev/null | grep -v -- '-pr-[0-9]*-adversarial-review\.md$' | sort
  ```
  If that finds a file, this is still a **follow-up review**, but treat
  it as a **legacy previous review**: read it the same way, but note in
  Step 9 that it predates PR-number scoping and, if this project has ever
  reviewed more than one pull request, may not be specific to this PR. If
  it has no `**Reviewed PR head:**` field either (almost certainly true
  for a report this old), you cannot compute a precise delta -- fall back
  to reviewing the full `$CE_DIFF_BASE..$CE_DIFF_HEAD` range in Step 5
  exactly as a first-time review would, and say so explicitly in Step 9's
  **Follow-up review** field rather than guessing a delta.
- **Nothing found either way, or `CE_PR_NUMBER` is unset** -- this is a
  **first-time review** of this pull request. Proceed exactly as the rest
  of this command already describes; there is nothing follow-up-specific
  to do.

**Input** (Implementation workspaces only, including a transitioned
review workspace): Optionally specify a change name (e.g.,
`/adversarial-review add-auth`). If omitted, infer it from conversation
context or auto-select if exactly one active change exists; if
ambiguous, list changes and ask the user to choose. Never guess. A
non-transitioned Existing PR review workspace has no change to name --
this input does not apply there; proceed directly to Step 1.

## 1. Resolve the review scope

**Implementation workspace:**

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

**Existing PR review workspace:** never attempt to resolve, require, or
create an OpenSpec change here -- there is none, and none should be
created to compensate. Only resolve the store's root path, needed for the
report destination in Step 9:

```bash
openspec list --store "$CE_OPENSPEC_STORE" --json
```

Read `root.path` from the JSON -- present even with zero changes, and the
only piece of OpenSpec state this workspace type ever touches.

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

## 3. Load the review baseline

**Implementation workspace:** read, in order, whichever of these exist
(from `artifactPaths`, inside the external store):
1. The change's `proposal.md` -- scope and non-goals
2. The change's `design.md`, if it exists -- technical commitments
3. All delta specs under the change's `specs/` directory, including their
   scenarios
4. The change's `tasks.md` -- checked and unchecked tasks

Extract the acceptance criteria and explicit non-goals: list what must be
true for "done." Note anything underspecified -- ambiguous acceptance,
missing error cases, missing security constraints.

**Existing PR review workspace:** there is no proposal, design, spec, or
tasks file, and none should be created to compensate -- never perform
proposal/design/tasks/spec conformance checks in this workspace type.
Establish the review baseline from these instead:
1. **The PR description** -- fetch it if a GitHub remote and the `gh` CLI
   are available (e.g. `gh pr view --json title,body,baseRefName,
   headRefName`), or ask the user for it if not available. Extract what
   the PR claims to do, its stated scope, and any explicit non-goals --
   the same things the Implementation-workspace branch above extracts
   from a proposal.
2. **Repository conventions and documentation** -- read the target
   repository's own `AGENTS.md`, `README`, `CONTRIBUTING`, or equivalent,
   inside `$CE_WORKTREE`, for whatever conventions this codebase already
   documents. Optional and read-only; never assume a particular file
   exists.
3. **The commit range itself** (`$CE_DIFF_BASE`..`$CE_DIFF_HEAD`, loaded
   in Step 5) -- what actually changed is as much a part of the baseline
   as the PR description's claims are.
4. **A follow-up review only:** the previous review report identified in
   Step 0 -- its Findings tables are an additional baseline, since Step 8
   below must verify each of them against the new code, not just review
   the delta in isolation.

Extract the same things the other branch extracts -- what must be true
for this PR to be correct, and what's underspecified -- just sourced from
the PR description and repository conventions instead of OpenSpec
artifacts.

## 4. Check for an existing verify report -- and challenge it (Implementation workspaces only) -- or, for an Existing PR review follow-up, the previous review report

**Existing PR review workspace, first-time review (Step 0 found no
previous report):** `/verify` refuses to run in an Existing PR review
workspace (see its own guard) -- so there is never a verify report to
look for there. Skip this step entirely in that workspace type and
proceed directly to Step 5; record `**Verify report reviewed:** N/A --
/verify does not run in an Existing PR review workspace.` in the report
(Step 9) instead.

**Existing PR review workspace, follow-up review (Step 0 found a previous
review report):** there is still no verify report -- but the previous
`/adversarial-review` report itself now plays this step's role. You
already read it in full in Step 0/3. For each finding in its "Findings
Affecting This Change" and "Pre-Existing or Adjacent Issues" tables,
check it against the new code (the delta identified in Step 5) and
classify it into exactly one of:

- **RESOLVED** -- the code the finding pointed at has changed in a way
  that fixes it; cite the new evidence (file:line, diff hunk) that shows
  it's fixed.
- **PARTIALLY RESOLVED** -- some but not all of the finding's concern was
  addressed; state precisely what remains.
- **NOT RESOLVED** -- the code the finding pointed at is unchanged, or
  changed in a way that doesn't address it.
- **NO LONGER APPLICABLE** -- the code the finding pointed at was removed
  or restructured such that the finding's premise no longer holds (this
  is not the same as RESOLVED -- say why the concern itself is now moot,
  not just fixed).

Do this for *every* finding in the previous report, not only the ones
that look interesting -- a finding you don't mention is not the same as
one you checked and found unresolved. Record the full table in the
"Follow-up Review" section of the report (Step 9). This classification
pass is this step's entire job for a follow-up review; Step 8 below still
separately reviews the delta itself for regressions and new issues -- the
two are complementary, never a substitute for each other.

**Implementation workspace (including a transitioned review workspace,
per Step 0):**

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
  report (Step 9), even if your conclusion is "the prior verdict holds."
- If the prior report already contains adequate evidence that a
  migration or other state-changing acceptance criterion was exercised
  (e.g. in a proven disposable environment, or with recorded user
  approval), challenge that evidence -- was it sufficient, does it still
  hold against the current diff -- rather than re-running the mutation
  yourself. This command never independently mutates database
  schema/data, infrastructure, external services, or developer
  configuration; see the environment-mutation guardrail below.

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

Resolve the diff range to review. If Step 0 already called `ce diff-scope`
to detect a review-to-implementation transition, you already have this
exact JSON output -- reuse it directly instead of calling it again:

```bash
ce diff-scope
```

This determines, deterministically, exactly which range to review --
an explicit `$CE_DIFF_BASE`/`$CE_DIFF_HEAD` range when both are set (an
existing pull request injected by `ce start --base --head`); otherwise
the merge base against `$CE_BASE_BRANCH` (preferring its current
`origin/` form when the two disagree and it is the more current one),
falling back to `main`/`master` only when `$CE_BASE_BRANCH` is unset or
neither of its forms resolves -- never guessing when the two candidates
have diverged in both directions. Parse its JSON output:

- `"mode": "explicit"` -- an explicit review range. Use `diffRange`
  (three-dot) for the diff and `logRange` (two-dot) for the commit log:
  ```bash
  git -C "$CE_WORKTREE" log --oneline "<logRange>"
  git -C "$CE_WORKTREE" diff "<diffRange>"
  ```
- `"mode": "merge-base"` -- a base was found (`base`, resolved from
  `baseSource`). Review the full diff scope against it, not just the
  default file ordering:
  ```bash
  git -C "$CE_WORKTREE" diff "<diffRange>"
  ```
- `"mode": "no-base"` -- no merge base could be resolved. Note the
  returned `scopeLimitation` in the report's `**Scope limitations:**`
  field and fall back to reviewing `HEAD` and the uncommitted diff only.

**Implementation workspace:** map files and changes to spec sections and
tasks. **Existing PR review workspace:** map files and changes to the PR
description's stated scope and to any repository conventions noted in
Step 3 instead -- there are no spec sections or tasks to map to.

**Existing PR review workspace, follow-up review only:** in addition to
the full range above, also compute the *delta since the last review* --
the specific commits that are new since the previous report. Using the
previously-reviewed head extracted in Step 0 (call it `<previousHead>`):

```bash
git -C "$CE_WORKTREE" log --oneline "<previousHead>..$CE_DIFF_HEAD"
git -C "$CE_WORKTREE" diff "<previousHead>...$CE_DIFF_HEAD"
```

If Step 0 could not recover a previously-reviewed head at all (the legacy
fallback with no `**Reviewed PR head:**` field), skip this delta -- you
already noted that limitation in Step 0/3, and Step 8's regression/new-
issue pass below instead covers the full `$CE_DIFF_BASE..$CE_DIFF_HEAD`
range, exactly like a first-time review. The full-range diff above always
remains the baseline for whether the PR *as a whole* is now correct; the
delta is additional, narrower context specifically for "what actually
changed since I last looked," so Step 8's regression pass can focus its
attention there first before it's satisfied nothing new was missed.

## 6. Baseline adversarial pass (runner- and lens-independent)

Perform this pass regardless of what domain the change touches, and
before any lens is selected or applied. This is the review's generic
floor -- a lens (Step 7) deepens it with additional domain-specific
questions; it never replaces, shortcuts, or narrows it. A change is
never reviewed through a lens alone.

For every changed area and every meaningfully changed file in the diff,
work through all seven of these:

1. **Coverage of the change itself**: has every changed area and every
   meaningfully changed file actually been read and reasoned about --
   not just the file(s) that obviously relate to the stated intent?
2. **Consistency across equivalent call sites**: if the change fixes,
   guards, or alters behavior in one place, are there other call sites,
   branches, or copies of the same logic that needed the same treatment
   and were missed? A fix applied to only one of several equivalent
   surfaces is a first-class finding, not a nitpick.
3. **Integration and wiring between layers**: does the change actually
   connect end to end (e.g. a new field that's written but never read, a
   handler that's defined but never registered, a config flag that's
   parsed but never consulted)? Trace the wiring; do not assume it.
4. **Positive and negative test coverage**: are both the intended-success
   path and realistic failure/abuse/edge paths exercised, not only the
   happy path?
5. **What the tests actually prove**: does a passing test demonstrate the
   user-visible behavior the change claims to deliver, or does it only
   assert an intermediate value or internal state that could pass while
   the externally observable behavior is still wrong?
6. **Regressions from partial or inconsistent rollout**: if the change is
   staged, flagged, or only partially applied, can that partial state
   itself produce incorrect or inconsistent behavior for some inputs,
   users, or timing windows?
7. **Undocumented scope changes**: does the diff do anything beyond what
   the review baseline describes -- the proposal/design/tasks in an
   Implementation workspace, or the PR description in an Existing PR
   review workspace -- an unrelated refactor, a behavior change with no
   corresponding update, a dependency or config change never mentioned?

Record what you found for each of the seven, even when the answer is "no
issue found" -- this becomes the "Baseline Review Coverage" section of
the report (Step 9), independent of whichever lens (if any) is selected
next.

## 7. Select one or more lenses (if any clearly match)

**A lens is an additional reasoning layer, not a filter that narrows the
review to one domain.** It adds domain-specific questions and failure
modes on top of the baseline pass in Step 6 -- it never substitutes for
that baseline, and it never becomes the sole basis of the review. Lenses
are additive, not mutually exclusive: more than one may apply to the same
change, and selecting several never repeats or replaces the Step 6
baseline pass -- each one simply layers additional questions onto that
same single pass.

ce-harness -- not the runner -- owns lens selection. Never rely on the
runner's own automatic skill or agent matching for this. Discover and
read reasoning lenses **only** through the canonical, runner-agnostic
directory at `"$CE_LENSES_DIR"` (injected by `ce start`); never assume or
hardcode any runner-specific path such as `opencode/agents/`.

1. If `CE_LENSES_DIR` is unset, or the directory contains neither a
   `*.md` file directly inside it nor any immediate subdirectory's own
   `SKILL.md`, skip this step entirely -- proceed without a lens and
   report `Lenses applied: None` in the "Lens Coverage" section of the
   report. This is not a failure.
2. Otherwise, list every available lens: every `*.md` file directly
   inside `"$CE_LENSES_DIR"`, plus every immediate subdirectory's own
   `SKILL.md` -- a vendored or user-provided Agent Skill, discovered and
   selected exactly the same way as ce-harness's own lenses, never
   descending further than that one file. Read each one's `description`
   frontmatter field.
3. Compare each description against the review baseline loaded in Step 3
   (the proposal, design, specs, and tasks in an Implementation
   workspace, or the PR description and repository conventions in an
   Existing PR review workspace) and the implementation diff just
   gathered.
4. If both an operational/runtime concern (execution behavior,
   idempotency, retries, concurrency, checkpoints, partial failure) and a
   structural concern (module boundaries, abstraction design, type/API
   design) apply to this change, prefer the lens describing the
   operational/runtime concern -- operational concerns take precedence.
   This tie-break only decides which single lens to prefer when reasoning
   about this specific overlap; it does not cap how many lenses may match
   and be selected overall.
5. If exactly one lens clearly matches, select it and continue -- no need
   to ask.
6. If no lens clearly matches, select none and continue normally --
   report `Lenses applied: None`.
7. If two or more lenses match, do not guess and do not silently pick
   one: tell the user which lenses matched and ask which to apply.
   Applying a lens is additive, so make clear the user may pick one,
   several, all, or none -- this is not a single-choice menu. Accept a
   free-form, comma- or space-separated list of lens names, the literal
   word `all` (apply every matching lens, in the order they were
   presented), or the literal word `none`. De-duplicate repeated names
   without loading the same lens twice, and preserve the order the user
   named them in (or the presented order, for `all`). If any named lens
   does not match an available lens file, do not drop it silently:
   explain which name(s) could not be resolved, list the valid lens
   names, and ask again.
8. Always allow an explicit user override: if the user has already named
   one or more specific lenses (or "none") before this step runs,
   validate that input the same way as step 7 (unresolvable names
   explained and re-asked, duplicates de-duplicated, order preserved) and
   use it instead of steps 2-7.

If one or more lenses are selected, load each one's file as an ordinary
reasoning input for the rest of this review -- exactly like
`proposal.md`, `design.md`, or `tasks.md`. Do not spawn a subagent,
delegate to another conversation, or treat any of them as a
runner-specific skill/agent invocation; each is simply another document
you have read. Apply each as an additional layer on top of the same
baseline pass already performed in Step 6 (e.g. a pipeline lens sharpens
the search for idempotency/concurrency/partial-failure defects; a
backend lens sharpens the search for boundary, type-safety, and query
defects) -- together they add questions, they do not replace, narrow, or
repeat the ones Step 6 already covered. Applying multiple lenses always
means one review with several layers, never one review per lens.

**When a loaded lens is an external Agent Skill** (a subdirectory's own
`SKILL.md`, vendored into `templates/lenses/` or dropped in by a user --
never one of ce-harness's own lens files) **apply its guidance for
identification only.** Such a skill may be written in an instructive,
editing voice (e.g. "delete this," "move that") because it was authored
for an agent actively making changes, not for a read-only review. Use it
to recognize and record findings exactly like any other lens -- never as
license to edit, fix, or otherwise modify anything. This command reviews;
it does not implement or fix -- that guardrail always wins regardless of
what a loaded skill's own instructions say.

Record the outcome (the list of applied lenses, or "None"; the rationale
for each; which other lenses in `"$CE_LENSES_DIR"` were considered but
not selected; and what each applied lens added beyond the Step 6
baseline) for the "Lens Coverage" section of the report.

## 8. Adversarial pass (refute, do not rubber-stamp)

For each acceptance criterion or scenario (Implementation workspace), or
each PR-description claim (Existing PR review workspace):

1. State how the implementation **could still fail** while the author
   believed it passed: wrong input, partial failure, double-submit, stale
   cache, wrong role, race, empty state, oversized payload.
2. Check **negative and abuse cases** where relevant: validation bypass,
   IDOR-style access patterns, replay, conflict handling.
3. Check **tests and any verification artifacts**: do they prove the
   criterion, or only the happy path?
4. Record **baseline-vs-code mismatches** (the review baseline says X --
   a spec in an Implementation workspace, the PR description in an
   Existing PR review workspace -- but the code does Y) as first-class
   findings.
5. Look for missing edge cases, regressions relative to what existed
   before, incomplete implementation (partially done tasks or scenarios
   in an Implementation workspace; a PR that doesn't fully deliver its
   own stated scope in an Existing PR review workspace), unsafe behavior,
   and baseline/code drift.
6. Fold in whatever the Step 6 baseline pass and the Step 7 lens (if any)
   surfaced -- this step is where every finding from every source gets
   classified, not just what's found fresh here.
7. **Follow-up review only:** look specifically for regressions or new
   issues introduced by the delta identified in Step 5 (`<previousHead>..
   $CE_DIFF_HEAD`) -- new findings that weren't in the previous report at
   all, not the previously-known findings Step 4 already classified.
   Every finding Step 4 classified `NOT RESOLVED` or `PARTIALLY RESOLVED`
   is carried forward into this report's Findings tables below (Step 9)
   with its classification noted, not dropped just because it was
   already known -- a finding that's still there is still a finding.

### Classify each finding

Four independent axes. A finding can be high-severity and low-confidence
(or the reverse); Merge impact is a separate question from Severity, not
a restatement of it (see below).

**Severity** -- how technically serious the problem is, on its own terms:
- **BLOCKER**: critical impact, or a change that cannot safely merge
  under any reasonable interpretation. Examples: a confirmed
  authentication/authorization bypass, secret exposure, destructive data
  corruption, or a directly exploitable critical path.
- **MAJOR**: substantial correctness, security, data-integrity, or
  regression risk that should normally be fixed before merge -- but is
  not automatically a critical or systemic failure.
- **MINOR**: limited impact, robustness, maintainability, or
  test-coverage gap that does not invalidate the change's central
  behavior.

**Confidence** -- how well-evidenced the finding is (kept separate from
Severity):
- **High** -- demonstrated by concrete code flow, exact file/line
  evidence, a test failure, command output, or measured behavior.
- **Medium** -- strongly supported by code reading, but one relevant
  runtime/data-flow assumption remains unverified.
- **Low** -- plausible but speculative; must not be presented as a
  confirmed defect.

**Merge impact** -- whether this specific finding, for this specific
change, should gate merge. This is not a synonym for Severity: a
BLOCKER-severity finding on a pre-existing, out-of-scope issue still
does not block *this* change's merge, because this change didn't cause
it and doesn't depend on it (see Step 9's two-table split, below).
**Do not use BLOCKER merely as a synonym for "please fix before merge"**
-- Severity and Merge impact answer different questions.
- **Blocking** -- this finding, on its own, means the change must not
  merge as-is.
- **Non-blocking** -- does not block merge by itself, but should be
  addressed, normally before merge or immediately after if the risk is
  explicitly accepted.
- **Follow-up** -- does not need to gate this change at all; track it
  separately.

**Area** (pick exactly one; use `Other: <label>` if none fit):
Logic, Auth/Authz, Data integrity, Error handling, Tests, Spec conformance,
Security, Performance, Docs/Spec, Other: `<label>`.

For each finding, state whether the fix belongs in **code**, **tests**,
**OpenSpec artifacts** (scenarios, specs, tasks -- Implementation
workspaces only, since an Existing PR review workspace has none), or
**documentation**.

### Sort each finding into exactly one of two groups

**Findings affecting this change** -- a finding belongs here when the
change:
- introduces it;
- worsens it;
- claims to fix the same behavior/class of problem but misses an
  in-scope equivalent surface;
- depends on the flawed behavior for correctness.

**Pre-existing or adjacent issues** -- everything else: a real issue,
worth recording, that this change did not introduce, does not worsen,
and does not depend on. These still carry a genuine Severity and
Confidence, but their Merge impact is normally `Follow-up`. Do not let a
repository-wide adjacent issue silently turn a focused review of this
change into a full-system audit -- note it, classify it, and move on.

## 9. Write the report

**Never infer today's date from memory, training data, or any other
form of model knowledge -- always compute it from the system clock:**

```bash
date -u +%Y-%m-%d
```

Use this command's exact output, verbatim, as `<YYYY-MM-DD>` everywhere
below (the filename, and the report's own `**Date:**` field) -- never a
remembered, assumed, or estimated date. `/verify` follows this exact
same rule, from this exact same command, for the same reason: guessing
the date wrong (e.g. from a stale training cutoff) has bitten real
usage before.

**Implementation workspace:** resolve the report destination from
`changeRoot` (never construct it by hand):

```bash
mkdir -p "<changeRoot>/reports"
# write to: <changeRoot>/reports/<YYYY-MM-DD>-adversarial-review.md
```

Before writing the report, resolve exactly (never estimate) what state
this review covers -- `/archive` later uses these three values to detect
whether this evidence has gone stale:

```bash
# Commit -- for human reference only; not itself what /archive compares.
git -C "$CE_WORKTREE" rev-parse HEAD

# Worktree fingerprint -- covers uncommitted implementation changes, not
# just the commit: tracked changes staged or unstaged (git diff HEAD),
# plus the actual content of untracked, non-ignored files (a new or
# edited file nobody `git add`ed yet still changes this).
{
  git -C "$CE_WORKTREE" rev-parse HEAD
  git -C "$CE_WORKTREE" diff HEAD
  git -C "$CE_WORKTREE" ls-files --others --exclude-standard -z | (cd "$CE_WORKTREE" && xargs -0 cat) 2>/dev/null
} | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-12

# Artifacts hash -- covers the agreed contract this review actually
# checked: proposal.md, design.md, tasks.md, and any delta specs -- not
# just tasks.md, since a proposal/design change can invalidate evidence
# just as much as a task change can.
{
  for f in proposal.md design.md tasks.md; do
    [ -f "<changeRoot>/$f" ] && cat "<changeRoot>/$f"
  done
  find "<changeRoot>/specs" -type f 2>/dev/null | sort | xargs cat 2>/dev/null
} | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-12
```

If none of `proposal.md`/`design.md`/`tasks.md`/`specs/` exist (a
non-spec-driven schema with nothing to hash), record `N/A -- no
artifacts to hash` for the artifacts hash instead of running that
command. An Existing PR review workspace has no `changeRoot` at all
(there is no OpenSpec change, so no `/archive` gate ever applies to it)
-- skip all three fields entirely for that workspace type; see the
report structure below.

**Existing PR review workspace:** there is no `changeRoot`. This is the
**official, dedicated report location** for this workspace type -- resolve
it from the `root.path` read in Step 1, and never invent a different one:

```bash
mkdir -p "<root.path>/reviews"
# CE_PR_NUMBER set (this workspace was created/refreshed by `ce review` --
# true for every review from now on, including every follow-up):
# write to: <root.path>/reviews/<YYYY-MM-DD>-pr-$CE_PR_NUMBER-adversarial-review.md
#
# CE_PR_NUMBER unset (a legacy workspace, or a plain `ce start --base
# --head` never resolved from a GitHub PR at all) -- the original,
# unscoped convention:
# write to: <root.path>/reviews/<YYYY-MM-DD>-adversarial-review.md
```

Never write to the unscoped, legacy filename when `CE_PR_NUMBER` is set --
every review from a `CE_PR_NUMBER`-bearing workspace must use the
PR-scoped name, so a later `ce status`/follow-up review can find it
without ambiguity against any other pull request this project has ever
reviewed (see the module's own `reviews/` directory being shared across
every PR review workspace of the same project).

Either way, this directory and file live **only** inside the external
OpenSpec store at `$CE_OPENSPEC_STORE` -- never create a `reports/`
directory, `reviews/` directory, `openspec/` directory, `.opencode/`
directory, or any other file inside the target repository or its Git
worktree.

### Report structure

Include exactly one of **Change:** / **Pull request:** below, matching
this workspace's type -- never both, and never invent a third variant.

```markdown
# Adversarial Review: <change-name (Implementation workspace), or the PR's identifier -- e.g. its head branch name or PR number (Existing PR review workspace)>

**Review type:** OpenSpec change / Existing PR review
**Date:** YYYY-MM-DD
**Change:** <changeRoot> -- Implementation workspaces only
**Pull request:** <PR number/URL if known, else the head branch name> -- Existing PR review workspaces only
**Reviewed PR head:** <full SHA of $CE_DIFF_HEAD at the moment this review ran> -- Existing PR review workspaces only. This exact line is a durable, machine-checkable sentinel -- `ce status`'s stale-review check and a later follow-up review both read it verbatim -- so write it exactly this way, with the real full SHA, never a placeholder or a short SHA.
**Follow-up review:** <"No -- first review of this pull request", or "Yes -- previous review: <path to the previous report>, previously reviewed head <SHA>", or "Yes (legacy previous review, pre-dates PR-number scoping; delta could not be precisely computed -- reviewed the full range instead)" -- Existing PR review workspaces only, per Step 0's detection>
**Reviewed worktree commit:** <full SHA -- human reference only> -- Implementation workspaces only
**Reviewed worktree fingerprint:** <12-char hash covering the commit plus any uncommitted tracked/untracked implementation changes> -- Implementation workspaces only
**Reviewed artifacts hash:** <12-char hash covering proposal.md/design.md/tasks.md/specs/, or "N/A -- no artifacts to hash"> -- Implementation workspaces only
**Scope:** <what this review covers -- if Step 0 detected a review-to-implementation transition, say so explicitly here (e.g. "This workspace was created via `ce review` for an external PR and transitioned to implementation of change `<name>` -- reviewed as the resulting diff, not the original PR range."), never leaving this indistinguishable from a workspace that started as an Implementation workspace>
**Baseline sources:** <artifact paths read (Implementation workspace), or PR description + repository docs actually read (Existing PR review workspace)>
**Implementation sources:** <worktree diff range examined>
**Verify report reviewed:** <path inside changeRoot/reports/, or "None found" (Implementation workspace); "N/A -- /verify does not run in an Existing PR review workspace" (Existing PR review workspace)>
**Scope limitations:** <limitations, each ending with **Merge impact:** Blocking or Non-blocking, or "None declared">

> This is an AI-generated review draft. A human reviewer must validate the findings before acting on them or publishing them externally.

---

## Requirement Coverage

<!-- "Requirement" means an OpenSpec acceptance criterion in an
Implementation workspace, or a claim/scope item stated in the PR
description in an Existing PR review workspace -- same table shape
either way. -->

| Requirement | Examined? | Outcome | Notes |
|---|---|---|---|
| <acceptance criterion, or PR-description claim/scope item> | Yes / No | Pass / Issues found / N/A | |

**Underspecified areas:** <list or "None">

---

## Baseline Review Coverage

<!-- The runner- and lens-independent pass from Step 6. This is what every review establishes before any lens contributes anything. -->

- **Changed areas examined:** <every changed area/file actually read and reasoned about>
- **Equivalent call sites checked:** <what else does the same thing, and whether it needed the same treatment, or "N/A -- no equivalent call sites found">
- **Tests inspected:** <which tests were read, and whether they prove the user-visible behavior or only an intermediate value>
- **Integration boundaries traced:** <what wiring/integration points were traced end to end>
- **Gaps or inaccessible evidence:** <anything that could not be checked and why, each ending with **Merge impact:** Blocking or Non-blocking, or "None">

---

## Lens Coverage

**Lenses applied:** <comma-separated lens names, in the order applied, or "None">
**Other lenses considered:** <other lens names found in $CE_LENSES_DIR but not selected, or "None found">

| Lens | Selection rationale | Lens checks applied | Additional checks beyond the baseline pass |
|---|---|---|---|
| <lens name> | <why this one was selected, in 1-3 sentences> | <the lens's own "## Lens checks" list, or -- when the lens has no such section, as with an external Agent Skill -- a 1-2 sentence summary of its `description` frontmatter instead> | <what this lens surfaced that the Step 6 baseline pass alone would not have> |

Or, if none applied: "N/A -- no lens applied."

---

## Verify Report Challenge

<what was challenged in the existing verify report and what you concluded, or "No verify report found; evidence established from scratch in this review." (Implementation workspace); "N/A -- /verify does not run in an Existing PR review workspace." (Existing PR review workspace)>

---

## Follow-up Review

<!-- Existing PR review workspace only, and only when Step 0 detected a
previous review report. Omit this entire section (never print an empty
one) for a first-time review, or for an Implementation workspace. This
table is Step 4's classification pass -- every finding from the previous
report's "Findings Affecting This Change" and "Pre-Existing or Adjacent
Issues" tables must appear here exactly once. -->

**Previous review:** <path to the previous report>
**Previously reviewed head:** <SHA, or "unknown -- legacy report predates head-tracking">
**Delta reviewed:** <`<previousHead>..CE_DIFF_HEAD` commit range, or "N/A -- previously reviewed head unknown; reviewed the full range as a first-time review would">

| Previous Finding | Previous Severity | Classification | Evidence | Notes |
|---|---|---|---|---|
| <finding, verbatim or summarized from the previous report> | BLOCKER / MAJOR / MINOR | RESOLVED / PARTIALLY RESOLVED / NOT RESOLVED / NO LONGER APPLICABLE | <file:line, diff hunk, or test output showing why> | <anything a reader needs to interpret the classification> |

Or, if the previous report had no findings at all: "N/A -- the previous review found no findings to re-verify."

A `NOT RESOLVED` or `PARTIALLY RESOLVED` classification here means the
underlying finding is still live -- carry it forward into "Findings
Affecting This Change" or "Pre-Existing or Adjacent Issues" below
(whichever this pass now assigns it to; a finding is re-classified on its
own current merits, not frozen into whichever table the previous review
happened to put it in), with its own fresh Severity/Confidence/Merge
impact/Area, not copy-pasted from the previous report unexamined.

---

## Risk-Mitigating Observations

<!-- Optional. Include only when a concrete decision directly mitigates a documented risk. Omit this section if there are no meaningful observations. Do not include generic praise. -->

---

## Findings Affecting This Change

<!-- A finding belongs here only if this change introduces it, worsens it, claims to fix the same behavior/class of problem but misses an in-scope equivalent surface, or depends on the flawed behavior for correctness. This table alone determines the Overall Verdict. "Affected Requirement/Design/Task" means the relevant PR-description claim or code area in an Existing PR review workspace, since there is no requirement/design/task there. Follow-up review: includes both new findings from the delta (Step 8) and any prior finding the "Follow-up Review" section above classified NOT RESOLVED / PARTIALLY RESOLVED and re-assigned here. -->

| Severity | Confidence | Merge impact | Area | Affected Requirement/Design/Task | Finding | Evidence | Impact | Recommended Fix |
|---|---|---|---|---|---|---|---|---|
| BLOCKER / MAJOR / MINOR | High / Medium / Low | Blocking / Non-blocking / Follow-up | Logic / Auth-Authz / Data integrity / Error handling / Tests / Spec conformance / Security / Performance / Docs-Spec / Other: `<label>` | <requirement, design decision, task, or PR-description claim> | <what you found> | <file:line, diff hunk, test output> | <what happens if unaddressed> | code / spec / tests / docs |

Or, if none: "None found."

---

## Pre-Existing or Adjacent Issues

<!-- Real issues this change did not introduce, does not worsen, and does not depend on. These never determine the Overall Verdict on their own -- Merge impact here is normally Follow-up. Do not let a repository-wide issue turn this into a full-system audit. -->

| Severity | Confidence | Area | Issue | Evidence | Why it is outside this change | Suggested follow-up |
|---|---|---|---|---|---|---|
| BLOCKER / MAJOR / MINOR | High / Medium / Low | Logic / Auth-Authz / Data integrity / Error handling / Tests / Spec conformance / Security / Performance / Docs-Spec / Other: `<label>` | <what you found> | <file:line, diff hunk, test output> | <why this predates or is unrelated to the change> | <what should happen, tracked separately from this review> |

Or, if none: "None noticed."

---

## Overall Verdict

**Verdict:** PASS

**Reason:** No Blocking or Non-blocking findings affecting this change.
```

Write `**Verdict:**` followed by exactly one of `PASS`, `PASS WITH
GAPS`, or `FAIL` -- nothing else on that line. This is a durable,
machine-checkable field: `/archive` greps it verbatim to decide whether
this evidence is good, so never rename it, reformat it, or leave more
than one token on it.

The verdict is derived **only** from the "Findings Affecting This Change"
table plus the **Scope limitations** and **Gaps or inaccessible
evidence** fields -- pre-existing/adjacent issues never determine it on
their own. Every **Scope limitations**/**Gaps or inaccessible evidence**
entry must carry its own explicit **Merge impact: Blocking** or
**Non-blocking** tag, using the exact same discipline as a finding's
Merge impact (see the classification section above): `Blocking` by
default; `Non-blocking` only when you can state a concrete reason the
review's overall conclusion is still adequately supported despite it
(e.g. a check that couldn't run for a stated, verifiable reason, where
the same concern was otherwise addressed some other way). Use exactly
one of these three verdict tokens, with a `**Reason:**` line after it:
- `FAIL` -- at least one finding affecting this change has Merge impact
  `Blocking`, or the change's central behavior is not safe or correct
  (this can be true even without a single finding individually tagged
  `Blocking`, if the accumulated evidence shows the core behavior fails).
- `PASS WITH GAPS` -- no `Blocking` findings affecting this change, but
  at least one `Non-blocking` finding, or at least one **Scope
  limitations**/**Gaps or inaccessible evidence** entry, remains. This
  verdict token alone does not determine archive eligibility --
  `/archive`'s own gate reads each finding's and each limitation's Merge
  impact directly, not just this token.
- `PASS` (adversarial) -- no `Blocking` or `Non-blocking` findings
  affecting this change; **Scope limitations** and **Gaps or
  inaccessible evidence** are both empty; any pre-existing/adjacent
  issues are listed with Merge impact `Follow-up` only; the review was
  completed with adequate evidence.

Pre-existing or adjacent issues, on their own, must never cause `FAIL` --
if every finding lives only in the "Pre-Existing or Adjacent Issues"
table, the verdict is `PASS` or `PASS WITH GAPS`, decided purely by
whatever remains (if anything) in "Findings Affecting This Change."

## 10. Report back (no automatic fixes)

After writing the report, tell the user its exact path (inside the
external store) and the overall verdict -- **and give them a single,
ready-to-run command to open that exact report directly**, since a bare
filesystem path into the external store is not itself an actionable
handoff (it isn't inside the worktree, isn't a URL, and Cmd/Ctrl-clicking
it from a terminal does not open it):

```
ce open --path "<the exact report path resolved in Step 9>"
```

Substitute the literal, already-resolved absolute path from Step 9 --
never a placeholder, and never the store's root or a change's whole
directory -- so the command opens precisely the file just written. This
works identically for both workspace types (`ce open --path` resolves
against the trusted OpenSpec store, not the worktree), requires no
runner- or editor-specific knowledge in this command (it delegates to
whichever editor `ce open` is already configured for), and never requires
the user to know or copy the store's internal path themselves. The
printed report path remains useful as a reference (e.g. to paste
elsewhere), but must never be the only way offered to reach the report.

You may **suggest** fixes for any findings
in the chat response, but never apply them automatically -- this command
only reviews and reports. If the user wants to act on a finding, that is a
separate, explicit step.

**Implementation workspace:** State the next step based on the verdict --
never assert `/archive` is ready from this command's verdict alone; that
is entirely `/archive`'s own gate to decide, since it also requires
`/verify`'s most recent report to be a fresh, clean `PASS`:
- `PASS WITH GAPS` or `FAIL` -- the findings above need addressing (via
  `/apply` or a manual fix) before this change can be archived. Once
  fixed, re-run `/verify` next -- not `/archive`, and not another
  `/adversarial-review` first -- since the implementation will have
  changed and any existing verify evidence would be stale.
- `PASS` (adversarial) -- if `/verify`'s most recent report is also a
  clean, fresh `PASS`, `/archive` is available next; if not, or you are
  unsure, run `/verify` first. Either way, `/archive`'s own gate checks
  this itself -- this command only ever suggests, never guarantees, that
  archiving will succeed.

**Existing PR review workspace:** there is no `/archive` step -- state
the next step in terms of the pull request itself instead:
- `PASS WITH GAPS` or `FAIL` -- the findings need addressing on the pull
  request. That normally happens outside this harness (the PR author
  pushes a fix); once they do, running `ce review <repo> <pr-number>`
  again pulls the new commits into this same workspace and starts a
  follow-up review (see Step 0) that verifies each finding above against
  the fix, rather than reviewing from scratch. If instead *you* are going
  to fix it yourself inside this workspace, say so and mention
  `/explore`/`/propose`/`/apply` are available for that (the workspace
  transitions into implementation -- see Step 0's `reviewTransition`
  detection).
- `PASS` (adversarial) -- nothing further is required from this review;
  mention that `ce review <repo> <pr-number>` can be re-run later if the
  PR gains new commits, to review just the delta.

**Guardrails**
- Never end Step 10 with only the report's printed filesystem path --
  always also give the user a ready-to-run `ce open --path "<report
  path>"` command for that exact file, since a bare external-store path
  is not itself an actionable handoff. Never substitute a directory, the
  store root, or `ce open --change` for this -- the command must open
  the exact report file just written.
- Never write the report's date (filename or `**Date:**` field) from memory or assumption -- always run `date -u +%Y-%m-%d` and use its exact output.
- Every `openspec` command must include `--store "$CE_OPENSPEC_STORE"`.
- Never assume repo-local `openspec/` paths -- always resolve
  `changeRoot`/`artifactPaths` (Implementation workspaces) or `root.path`
  (Existing PR review workspaces) from the CLI's JSON output.
- In an Existing PR review workspace, never resolve, require, or invent
  an OpenSpec change, and never perform proposal/design/tasks/spec
  conformance checks -- the PR description, repository conventions and
  documentation, and the commit range are the review baseline instead
  (Step 3). Its report always lives at the official
  `<root.path>/reviews/<date>-pr-<number>-adversarial-review.md` location
  (Step 9, PR-scoped whenever `CE_PR_NUMBER` is set; the older unscoped
  filename only when it isn't) -- never `<changeRoot>/reports/`, since
  there is no change, and never any other invented location.
- Always write the `**Reviewed PR head:**` field, with the real full SHA
  of `$CE_DIFF_HEAD` -- it is what makes both `ce status`'s stale-review
  check and a later follow-up review's delta computation possible at all.
  Never omit it, and never write a placeholder or short SHA in its place.
- A follow-up review (Step 0 found a previous report) must classify
  *every* finding from that previous report's two tables (Step 4) --
  never silently drop one, and never classify one you didn't actually
  re-check against the new code. A finding you don't mention is not the
  same as one you checked. Still separately look for new regressions/
  issues in the delta itself (Step 8) -- classification and fresh review
  are complementary passes, neither substitutes for the other.
- Never overwrite or delete a previous review report -- each review
  (first-time or follow-up) writes its own new, dated file. Historical
  review context is recovered by reading prior reports, never by editing
  them.
- Never invent a finding you don't have evidence for -- every finding must
  state the affected requirement/design decision/task, its impact, its
  Area, its Confidence, its Merge impact, and a recommended fix. Evidence
  discipline is mandatory:
  - cite concrete file paths and line ranges where available;
  - cite diff hunks, commands, logs, or test output where relevant;
  - **Avoid vague references.**
  - keep confirmed defects (backed by evidence) clearly separate from
    speculative concerns (pattern-recognition only -- Low confidence);
  - missing or unobtainable evidence must be reported as an uncertainty
    (Low/Medium confidence, or an open question) -- never converted into a
    defect finding just because you couldn't rule it out.
- The Step 6 baseline pass is mandatory and runner-/lens-independent --
  never skip it or fold it silently into the lens's own questions. A
  selected lens (Step 7) only ever adds to it.
- Severity, Confidence, and Merge impact are three independent
  judgments, not restatements of each other. **Do not use `BLOCKER`
  merely as a synonym for "please fix before merge"** -- a finding can be
  high-Severity with a `Follow-up` Merge impact (e.g. a real but
  pre-existing issue), and a `MINOR`-Severity finding can still be
  `Blocking` if it directly undermines the change's specific claim.
- Every finding must be sorted into exactly one of "Findings Affecting
  This Change" or "Pre-Existing or Adjacent Issues" -- never a single
  merged list. Pre-existing/adjacent issues alone must never produce a
  `FAIL` verdict, and must not be allowed to expand a focused review of
  this change into a full-system audit.
- Do not duplicate the full verification pass when a recent verify report
  already exists and is trustworthy for a given item -- reuse it, but
  actively challenge its assumptions, gaps, blocked items, and PASS verdict
  rather than accepting it at face value. (Implementation workspaces
  only -- an Existing PR review workspace never has a verify report to
  consult; see Step 4.)
- Never modify product/application code. This command reviews; it does not
  implement or fix.
- Never independently mutate database schema/data, infrastructure,
  external services, or developer configuration (e.g. running a
  migration such as `prisma migrate deploy`, a seed, a reset,
  `terraform apply`, `kubectl apply`, or any similar mutating command)
  without explicit user approval -- this applies identically in both
  workspace types. In particular, never run a migration against an
  existing local test database merely to make the test suite runnable.
  This command is observational and more conservative than `/verify`:
  prefer challenging a prior `/verify` report's mutation evidence
  (Step 4) over re-running the mutation. If additional mutation is
  genuinely necessary to investigate a finding, explain why and ask
  first; never infer an environment is disposable merely because it's
  named "test". The same applies to Docker specifically: never reuse,
  stop, or otherwise touch a container or Compose project without first
  confirming (via its `com.docker.compose.project.working_dir` label)
  that it actually belongs to `$CE_WORKTREE` -- see `/verify`'s "Docker
  safety" (Step 8) for the full ownership/collision/port-conflict checks
  this command relies on rather than re-deriving.
- Never check, uncheck, or otherwise edit `tasks.md` or any other OpenSpec
  artifact.
- Never create `openspec/`, `.opencode/`, `reports/`, or any other
  harness/config file or directory inside the target repository or its Git
  worktree -- the review report belongs only inside the external store at
  `$CE_OPENSPEC_STORE`. This forbids harness-identity artifacts (OpenSpec
  stores, reports, commands, lenses, runner configuration); it does not
  forbid ephemeral, tool-generated build/analysis artifacts a worktree's
  own tooling produces inside itself (e.g. `node_modules/`, build output,
  or a semantic-code-navigation index) -- those are expected, untracked,
  and removed automatically along with the worktree on `ce cleanup`.
  Never copy such artifacts into the original repository.
- Lenses are discovered and read only through `"$CE_LENSES_DIR"` -- never
  hardcode `opencode/agents/` or any other runner-specific path. Never
  rely on the runner's own automatic skill/agent selection; selection is
  an explicit step this command owns.
- A selected lens is loaded as an ordinary reasoning input (like
  `proposal.md` or `tasks.md`) -- never spawned as a subagent and never
  delegated to as a separate conversation. A lens is an additional
  reasoning layer, never a filter that narrows the review to one domain.
- Every **Scope limitations** and **Gaps or inaccessible evidence** entry
  must end with an explicit **Merge impact: Blocking** or **Non-blocking**
  tag, using the same discipline as a finding's Merge impact -- `Blocking`
  by default; `Non-blocking` only with a stated reason. `/archive`'s gate
  treats an untagged entry (a legacy report predating this convention) as
  `Blocking`, never as safe by omission.
- Do not praise the implementation to "balance" criticism unless a strength
  directly mitigates a documented risk (use the optional Risk-Mitigating
  Observations section for that, never as filler in Findings).
- If you cannot access the diff or a referenced artifact, say so and list
  exactly what is needed to continue.

This command does not implement retrospective, intensity levels, export,
or archive gating -- those remain out of scope for this version.

_See `THIRD_PARTY_NOTICES.md` for this command's provenance and licensing._
