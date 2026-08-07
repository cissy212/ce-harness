---
description: Verify the implementation in the worktree against the active OpenSpec change -- checks every requirement, scenario, design commitment, and checked task against concrete evidence
---

Verify that the implementation in this workspace's worktree conforms to the
active OpenSpec change. This command checks conformance to the agreed
specification -- it does not fix code, and it does not independently hunt for
defects beyond the specification; `/adversarial-review` runs afterward for
that. It never modifies the target repository, the worktree, or task
checkboxes; it only reads evidence and writes a report into the external
OpenSpec store.

## Relationship to /adversarial-review

- `/verify` (this command) checks whether the implementation conforms to
  the agreed proposal, design, specs, scenarios, and tasks -- it
  establishes the **conformance baseline**.
- `/adversarial-review` runs afterward and independently hunts for
  defects, regressions, unsafe assumptions, and gaps that may not be
  covered by the specification -- it **challenges** that baseline.
- The two stages are complementary, not duplicates: run `/verify` first,
  then `/adversarial-review`.

## 0. Guard

If `CE_DIFF_BASE` and `CE_DIFF_HEAD` are both set, this workspace was
created with `ce start --base --head` to review an existing, already-given
commit range (e.g. an external pull request) -- it is not implementing an
OpenSpec change. Stop immediately, before running any command, and tell
the user:

> This workspace is reviewing an existing commit range
> (`$CE_DIFF_BASE`..`$CE_DIFF_HEAD`), not an implementation produced from
> an OpenSpec change. `/verify` checks conformance against the artifacts
> of an OpenSpec change (proposal, design, specs, tasks) -- there is no
> such implementation here to verify, only the auxiliary OpenSpec change
> this workspace generated for its own exploration. `/adversarial-review`
> is the correct command for reviewing an external commit range directly.

Do not attempt any partial verification in this case -- no `openspec`
command, no diff inspection, no report. Stop entirely and take no further
action.

Otherwise, if `CE_OPENSPEC_STORE` or `CE_WORKTREE` is empty or unset, stop
and tell the user to run `ce start` first -- there is no store or worktree
to verify against. Every `openspec` command below includes
`--store "$CE_OPENSPEC_STORE"`. All code inspection happens only inside
`$CE_WORKTREE`.

**Input**: Optionally specify a change name (e.g., `/verify add-auth`). If
omitted, infer it from conversation context or auto-select if exactly one
active change exists; if ambiguous, list changes and ask the user to choose.
Never guess.

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
- `schemaName` -- the workflow schema in use

If the change cannot be resolved unambiguously, ask the user before
proceeding.

## 2. Load context

Read the store's generic project-level context first -- never a
repo-specific config file (this harness has no such concept):

```bash
openspec context --store "$CE_OPENSPEC_STORE"
```

Then read, in order, whichever of these exist (from `artifactPaths`, inside
the external store):
1. The change's `proposal.md` -- scope and non-goals
2. The change's `design.md`, if it exists -- technical commitments
3. All delta specs under the change's `specs/` directory
4. The change's `tasks.md` -- checked and unchecked tasks

If the target repository has its own `AGENTS.md`, `README`, or similar
top-level documentation, read it too for context on conventions -- this is
optional and read-only; never assume any particular file exists.

## 3. Inspect the implementation in `$CE_WORKTREE`

Use semantic code navigation first, but only when the workspace reports it
as available: check `CE_CODE_NAV_AVAILABLE` before assuming any specific
tool exists -- ce-harness never guarantees this capability, it only wires
it up opportunistically when a provider was detected and successfully
initialized for this exact workspace. If `CE_CODE_NAV_AVAILABLE` is unset,
skip straight to Grep/Read below; this is not a failure.

If it is set, check `CE_CODE_NAV_PROVIDER` to know which tool backs it.
For the `codegraph` provider:

```
mcp__codegraph__codegraph_explore: query the symbols and call paths relevant to the change
```

Fall back to targeted Grep and Read calls inside `$CE_WORKTREE` whenever
`CE_CODE_NAV_AVAILABLE` is unset, or the available provider's output is
insufficient. Either way, before citing anything discovered through
semantic navigation as evidence in the report, confirm it against the
actual current source (Read the cited file:line directly) -- semantic
navigation accelerates discovery, it never substitutes for reading the
exact line you are about to cite.

Determine the diff scope, entirely inside `$CE_WORKTREE`:

```bash
git -C "$CE_WORKTREE" status --porcelain
git -C "$CE_WORKTREE" log --oneline -20
```

If `CE_DIFF_BASE` and `CE_DIFF_HEAD` are both set, this is an explicit
review of a specific commit range (e.g. an existing pull request, open or
already merged) injected by `ce start --base --head` -- use them
directly and skip base-branch detection entirely:

```bash
git -C "$CE_WORKTREE" log --oneline "$CE_DIFF_BASE..$CE_DIFF_HEAD"
git -C "$CE_WORKTREE" diff "$CE_DIFF_BASE...$CE_DIFF_HEAD"
```

Use three-dot (`...`) for the diff itself, not two-dot: three-dot means
"changes introduced on head since it diverged from base," which is
correct whether or not base has since advanced (an open PR whose base
branch moved forward is still a valid comparison). Use two-dot for the
commit log, which lists exactly the commits unique to head. Derive the
actual changed code from the three-dot diff, not from the log.

Otherwise, find a base for a proper diff by trying the common
base-branch names in order (mirrors how `ce start` itself picks a base
branch when `--base`/`--head` are not given) and use whichever exists:

```bash
git -C "$CE_WORKTREE" merge-base HEAD main    2>/dev/null
git -C "$CE_WORKTREE" merge-base HEAD master  2>/dev/null
```

If a merge base is found, diff against it (`git -C "$CE_WORKTREE" diff <merge-base>...HEAD`).
If neither `main` nor `master` exists as a reachable branch, note this as a
scope limitation under "Gaps and Blockers" and fall back to inspecting `HEAD`
and the uncommitted diff only.

Map each changed file to the spec sections and tasks it is supposed to
satisfy.

## 4. Select one or more lenses (if any clearly match)

ce-harness -- not the runner -- owns lens selection. Never rely on the
runner's own automatic skill or agent matching for this. Discover and
read reasoning lenses **only** through the canonical, runner-agnostic
directory at `"$CE_LENSES_DIR"` (injected by `ce start`); never assume or
hardcode any runner-specific path such as `opencode/agents/`.

Lenses are additive, not mutually exclusive -- more than one may apply to
the same change, and applying several never repeats or replaces this
step; each one simply layers onto the same single pass.

1. If `CE_LENSES_DIR` is unset, or the directory contains no `*.md`
   files, skip this step entirely -- proceed without a lens and report
   `Lenses applied: None` in the "Lens Coverage" section of the report.
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
reasoning input for the rest of this session -- exactly like
`proposal.md`, `design.md`, or `tasks.md`. Do not spawn a subagent,
delegate to another conversation, or treat any of them as a
runner-specific skill/agent invocation; each is simply another document
you have read. Applying multiple lenses never repeats this step or any
other step -- all selected lenses are layered onto the same single
verification pass, producing one progressively richer review, not one
review per lens.

Record the outcome (the list of applied lenses, or "None"; the rationale
for each; and which other lenses in `"$CE_LENSES_DIR"` were considered
but not selected) for the "Lens Coverage" section of the report.

## 5. Verify requirements and scenarios

For each requirement in the delta specs:

1. State the requirement text.
2. Locate the implementation that satisfies it in `$CE_WORKTREE` -- exact
   file, function, line range.
3. Verify each acceptance scenario (`#### Scenario:`) against the
   implementation.
   - A checked checkbox is **not** proof. Find the code independently.
   - For `WHEN`/`THEN` scenarios: trace the code path from trigger to
     outcome.
4. Assign a status:
   - `VERIFIED` -- implementation matches the requirement with concrete
     evidence
   - `PARTIALLY VERIFIED` -- partially satisfied; state what is missing
   - `NOT VERIFIED` -- implementation evidence not found or contradicts the
     requirement
   - `BLOCKED` -- cannot verify without access to a dependency (e.g., a
     running service or external credential)

## 6. Audit design commitments

Read the `design.md` Decisions section, if it exists. For each decision:

1. State the decision.
2. Confirm the implementation in `$CE_WORKTREE` reflects it, or note the
   deviation.
3. Classify: `VERIFIED` / `NOT VERIFIED` / `N/A`

## 7. Audit checked tasks (read-only)

Read `tasks.md`. For each `- [x]` checked task:

1. Read the task description.
2. Find independent implementation evidence in `$CE_WORKTREE` that the task
   is actually complete.
3. Mark `VERIFIED` if evidence exists.
4. Mark `UNVERIFIED CHECKBOX` if the box is checked but no implementation
   evidence was found -- this is a finding.

Unchecked tasks (`- [ ]`) are out of scope for verification. List them under
"Gaps and Blockers" as remaining work. **Never check, uncheck, or otherwise
edit `tasks.md` or any other artifact** -- this command only reads and
reports.

## 8. Discover and run verification commands

Verification commands must be **discovered from the repository**, never
assumed. Inspect, in roughly this order, whichever of these exist at the
worktree root and choose the smallest targeted set that validates the
change (typically a test run, a type/lint check if the language has one,
and a build if applicable):

- Package manifests: `package.json` (`scripts` block), `pyproject.toml` /
  `Pipfile`, `Cargo.toml`, `go.mod`, `Gemfile`, etc.
- Task runners / build files: `Makefile`, `Taskfile.yml`, `justfile`,
  `Rakefile`
- Project docs: `AGENTS.md`, `README`, `CONTRIBUTING`, or equivalent, for any
  documented "how to test/lint/build this project" instructions

Do not assume npm, Docker, Prisma, or any other specific stack or tool --
choose whatever the repository itself actually uses, and run each chosen
command with its working directory set to `$CE_WORKTREE`. Record the exact
command line used for each.

If no verification commands can be discovered, or a discovered command
requires an environment/dependency that is not available (e.g. a database,
external service, or credential), mark that check as `BLOCKED` and state the
specific reason. Do not skip -- a `BLOCKED` result in the report is
informative; a missing result is not.

### Environment-mutation safety

Observation is allowed by default: tests, lint, typecheck, build,
`git status`/`log`/`diff`, `docker ps`, schema/code inspection, and
read-only database queries never require approval. Mutation -- a schema
or data migration, a seed/reset, or anything else that changes database
schema/data, infrastructure, external services, or developer
configuration (e.g. `prisma migrate deploy`/`dev`, `prisma db push`,
`prisma db seed`, `drizzle-kit push`, `sequelize db:migrate`,
`rails db:migrate`, `alembic upgrade`, `terraform apply`, `pulumi up`,
`kubectl apply`, or any command that resets/seeds/truncates/writes a
database or mutates a remote service or cloud resource) -- is different.
These are examples of the category, not an exhaustive blacklist: do not
decide "safe" or "unsafe" by matching a command name alone, and do not
assume a nominally "test" command is safe merely because of its name --
if it performs destructive setup, it is still mutation and the rules
below still apply.

This does **not** mean verification commands may never run a migration
-- a migration can be an explicit part of the change being verified.
Before running any command that would mutate state, classify it against
the proposal, design, specs, and tasks already loaded (Step 2) -- never
against the implementation alone:

- **Case A -- the mutation is not part of the change being verified**
  (e.g. tests fail because the local database is out of date, a
  migration is only needed to make the environment usable, or a
  seed/reset would merely prepare local state). Do not perform it
  automatically. Explain what is required and ask the user for explicit
  approval first.
- **Case B -- the mutation is explicitly part of the OpenSpec change**
  (e.g. the change adds a schema migration, acceptance criteria require
  existing rows to be migrated, a task explicitly requires applying an
  index migration, or verification must demonstrate an upgrade path
  succeeds). Then:
  - If the repository already provides an explicitly disposable
    verification environment whose creation and reset is already part
    of the established repository/tooling workflow (e.g. a test
    database/container the test workflow itself creates and resets),
    you may exercise the mutation there without asking, provided
    concrete repo evidence -- not assumption -- shows it cannot affect
    development/shared/production state and that disposal/reset is
    genuinely wired into that workflow. Never infer that an environment
    is disposable merely because its name contains "test".
  - If verification would instead mutate an existing persistent or
    shared environment, ask the user first.
- **Case C -- environment safety cannot be established** from concrete
  repo evidence either way. Do not mutate it. Ask.

When asking for approval (Case A, the persistent/shared branch of Case
B, or Case C), state: the exact command that would run; the specific
environment/resource it would mutate; why the change requires it; and
whether the mutation is reversible or disposable.

If a mutation is required but not authorized, mark the affected check
`BLOCKED` (never `NOT VERIFIED`) and state the specific limitation under
"Gaps and Blockers" -- a withheld mutation is a verification limitation,
not an implementation defect, unless other independent evidence already
shows the requirement fails.

**Handling large output:**
- Always preserve the exact **exit code** of each command -- this is what
  `PASS`/`FAIL`/`BLOCKED` is ultimately based on.
- Always preserve the **final test/check summary line(s) verbatim** (e.g.
  "12 passed, 1 failed", a linter's total-error count, a compiler's final
  diagnostic count).
- Always preserve **every failure/error line, and any surrounding context
  needed to diagnose it** (the failing test's name, the assertion that
  failed, the stack frame that points at your own code).
- Passing-test noise and repetitive successful output (e.g. hundreds of
  identical "✓ passed" lines) may be omitted once the summary line and
  exit code are preserved -- they add no additional evidence.
- If the reduced output is ambiguous -- you cannot tell from the summary
  and preserved failure lines alone whether the command actually passed,
  or a failure's cause is unclear -- retrieve and inspect the full raw
  output before concluding anything. Never guess to avoid re-reading.
- **Never** apply this kind of reduction to Git diffs, `openspec` JSON
  output, merge-base commit SHAs, or any source line you are about to
  cite as evidence -- read and quote those exactly as produced, never
  summarized or reinterpreted.
- Reports must always cite the raw, reproducible evidence itself (the
  exact failing line, the exact exit code, the exact command run) --
  never your own compressed summary of it, and never a compression
  tool's interpretation presented as if it were the original output.

**Optional terminal-output compression (`rtk`):** ce-harness never
installs or configures this -- it is not wired into any hook or plugin,
and it is never on by default. If (and only if) an `rtk` executable
happens to already be on `PATH`, you may explicitly invoke it for the
specific noisy commands above (e.g. `rtk test <cmd>`, `rtk lint`,
`rtk tsc`, `rtk cargo build`, a package install command, `rtk git
status`, or a bounded `rtk git log`) instead of running them directly.
**Never** run the review diff, an `openspec` JSON call, merge-base
resolution, or any command whose output you intend to cite as evidence
through `rtk` -- those must always run unwrapped, exactly as instructed
above. If `rtk`'s output is ambiguous, re-run the same command without
the `rtk` prefix for the full raw output.

## 9. Write the report

Resolve the report destination from `changeRoot` (never construct it by
hand):

```bash
mkdir -p "<changeRoot>/reports"
# write to: <changeRoot>/reports/<YYYY-MM-DD>-verify.md
```

Use today's date in the filename. This directory and file live **only**
inside the external OpenSpec store at `$CE_OPENSPEC_STORE` -- never create a
`reports/` directory, `openspec/` directory, `.opencode/` directory, or any
other file inside the target repository or its Git worktree.

### Report structure

```markdown
# Verification Report: <change-name>

**Date:** YYYY-MM-DD
**Change:** <changeRoot>

## Scope

<what this verification covers: change name, schema, worktree path, commit/diff range examined>

## Evidence Examined

<list of artifacts read (proposal, design, specs, tasks), files inspected in $CE_WORKTREE, and any tools used (semantic code navigation, grep, etc.)>

## Lens Coverage

**Lenses applied:** <comma-separated lens names, in the order applied, or "None">
**Other lenses considered:** <other lens names found in $CE_LENSES_DIR but not selected, or "None found">

| Lens | Selection rationale | Lens checks applied |
|---|---|---|
| <lens name> | <why this one was selected, in 1-3 sentences> | <the "Lens checks" list from this lens's file> |

Or, if none applied: "N/A -- no lens applied."

## Requirement / Scenario Verification

| Requirement | Scenarios | Status | Evidence |
|---|---|---|---|
| <name> | N | VERIFIED / PARTIALLY VERIFIED / NOT VERIFIED / BLOCKED | <file:line> |

## Design Commitment Verification

| Decision | Status | Evidence |
|---|---|---|
| <summary> | VERIFIED / NOT VERIFIED / N/A | <file:line> |

## Task Verification

| Task | Checkbox | Verification | Evidence |
|---|---|---|---|
| <text> | [x] | VERIFIED / UNVERIFIED CHECKBOX | <file:line> |

## Commands Executed and Outcomes

- `<discovered command>`: PASS / FAIL / BLOCKED -- <reason if not PASS>

## Gaps and Blockers

- <unverified/blocked item, unchecked task, or scope limitation, and why>

---

## Overall Verdict

PASS -- all requirements VERIFIED, all design commitments VERIFIED/N/A, all checked tasks VERIFIED, all executed commands PASS.

PASS WITH GAPS -- no NOT VERIFIED requirements, no UNVERIFIED CHECKBOX tasks, and no FAILed commands, but one or more items are BLOCKED or PARTIALLY VERIFIED. List the gaps above.

FAIL -- one or more requirements NOT VERIFIED, tasks UNVERIFIED CHECKBOX, design commitments NOT VERIFIED, or executed commands FAILed. See findings above.
```

## 10. Report back (no automatic fixes)

After writing the report, tell the user its path (inside the external
store) and the overall verdict. You may **suggest** fixes for any findings
in the chat response, but never apply them automatically -- this command
only verifies and reports. If the user wants to act on a finding, that is a
separate, explicit step.

Run `/adversarial-review` next for independent defect hunting.

**Guardrails**
- Every `openspec` command must include `--store "$CE_OPENSPEC_STORE"`.
- Never assume repo-local `openspec/` paths -- always resolve `changeRoot`
  and `artifactPaths` from the CLI's JSON output.
- A checked checkbox is never proof by itself -- always find independent
  implementation evidence in `$CE_WORKTREE`.
- Every conclusion (VERIFIED, NOT VERIFIED, PARTIALLY VERIFIED, or a
  finding) must cite concrete evidence: a file path and line range, a
  command's actual output, or an explicit statement of what is missing.
  Never state a conclusion you don't have evidence for.
- Distinguish implementation defects (the code does not do what the spec
  requires) from verification limitations (you could not check something
  because of a missing dependency, credential, or environment) -- use
  `NOT VERIFIED` for the former and `BLOCKED` for the latter; do not conflate
  them.
- Never modify product/application code. This command verifies; it does not
  implement or fix.
- Never check, uncheck, or otherwise edit `tasks.md` or any other OpenSpec
  artifact.
- Never create `openspec/`, `.opencode/`, `reports/`, or any other
  harness/config file or directory inside the target repository or its Git
  worktree -- the verification report belongs only inside the external store
  at `$CE_OPENSPEC_STORE`. This forbids harness-identity artifacts
  (OpenSpec stores, reports, commands, lenses, runner configuration); it
  does not forbid ephemeral, tool-generated build/analysis artifacts a
  worktree's own tooling produces inside itself (e.g. `node_modules/`,
  build output, or a semantic-code-navigation index) -- those are
  expected, untracked, and removed automatically along with the worktree
  on `ce cleanup`. Never copy such artifacts into the original repository.
- Do not hardcode verification commands to any specific stack (npm, Docker,
  Prisma, or otherwise) -- discover them from the repository itself.
- Mutating database schema/data, infrastructure, external services, or
  developer configuration always requires either a proven disposable
  environment (established by concrete repo evidence, never inferred
  from a name containing "test") or explicit user approval -- see
  "Environment-mutation safety" in Step 8. A withheld mutation is a
  verification limitation (`BLOCKED`), never converted into a defect.
- If evidence is ambiguous, state what was found and why it is insufficient.
  Do not guess.
- Lenses are discovered and read only through `"$CE_LENSES_DIR"` -- never
  hardcode `opencode/agents/` or any other runner-specific path. Never
  rely on the runner's own automatic skill/agent selection; selection is
  an explicit step this command owns.
- A selected lens is loaded as an ordinary reasoning input (like
  `proposal.md` or `tasks.md`) -- never spawned as a subagent and never
  delegated to as a separate conversation.

This command does not implement retrospective, intensity levels, export,
or archive gating -- those remain out of scope for this version.

_See `THIRD_PARTY_NOTICES.md` for this command's provenance and licensing._
