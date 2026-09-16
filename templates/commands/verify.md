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

If `CE_OPENSPEC_STORE` or `CE_WORKTREE` is empty or unset, stop and tell
the user to run `ce start` first -- there is no store or worktree to
verify against. Every `openspec` command below includes
`--store "$CE_OPENSPEC_STORE"`. All code inspection happens only inside
`$CE_WORKTREE`.

If `CE_DIFF_BASE` and `CE_DIFF_HEAD` are both set, this workspace was
created with `ce start --base --head` to review an existing, already-given
commit range (e.g. an external pull request) -- but that alone never
decides whether `/verify` may run: a review workspace can legitimately
transition into real implementation (the reviewer discovers the PR needs
repair, then runs `/explore` -> `/enrich` -> `/propose` -> `/apply`
inside this same workspace). Never guess this from the two environment
variables alone -- run:

```bash
ce diff-scope
```

and read its `reviewTransition` field:

- **`null` or `{"detected": false, ...}`** -- no active change owned by
  this workspace has an implementation-base marker recorded by `/apply`
  (see below). This workspace is still a pure review of the original
  external range, with no implementation to verify. **Stop immediately,
  before running any other command**, and tell the user:

  > This workspace is reviewing an existing commit range
  > (`$CE_DIFF_BASE`..`$CE_DIFF_HEAD`), not an implementation produced
  > from an OpenSpec change. `/verify` checks conformance against the
  > artifacts of an OpenSpec change (proposal, design, specs, tasks) --
  > there is no such implementation here yet to verify (only, at most,
  > auxiliary exploration/review artifacts). If you've started repairing
  > this PR via `/propose` and `/apply` inside this workspace, run
  > `/apply` to completion first, then re-run `/verify`. Otherwise,
  > `/adversarial-review` is the correct command for reviewing the
  > external commit range directly.

  Do not attempt any partial verification in this case -- no `openspec`
  command beyond the check above, no diff inspection, no report. Stop
  entirely and take no further action.
- **`{"detected": true, "changeName": "<name>", ...}`** -- deterministic
  evidence (an implementation-base marker `/apply` itself recorded for
  `<name>` the first time it began implementing -- something only
  `/apply`, and nothing else in the workflow, ever writes) shows this
  workspace has transitioned from review into implementation. Continue exactly as an
  ordinary Implementation workspace for the rest of this command,
  verifying `<name>`. **You already have this invocation's diff-scope
  result from the call above -- reuse it directly in Step 3 rather than
  calling `ce diff-scope` again.** Note the transition in the report's
  Scope (Step 9), so this never looks indistinguishable from a workspace
  that started as an Implementation workspace from the beginning.

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

**Query the Retrieval Contract** for relevant prior project knowledge --
a past decision, a past verify/adversarial-review finding, a past spec
-- before inspecting the implementation yourself:

```bash
ce retrieve --task "<task text, from the proposal/change name>" --paths "<comma-separated paths, if any>" --domain "<domain, if known>" --keywords "<comma-separated terms, if any>"
```

Same discipline as `/enrich`'s own Step 5: open every `"strong"`-confidence
candidate in full; open `"moderate"`-confidence ones too only if there
are fewer than 3 strong ones; never open more than 5 in full; every
other candidate is metadata-only, never opened. A candidate is
additional context, never authoritative over what you actually find in
this worktree -- treat it exactly as advisory as the rest of this
step's reading, never as a reason to skip verifying something yourself.
If `ce retrieve` reports a warning, proceed without that source.

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
  `baseSource`). Diff against it:
  ```bash
  git -C "$CE_WORKTREE" diff "<diffRange>"
  ```
- `"mode": "no-base"` -- no merge base could be resolved. Note the
  returned `scopeLimitation` under "Gaps and Blockers" and fall back to
  inspecting `HEAD` and the uncommitted diff only.

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

**When a loaded lens is an external Agent Skill** (a subdirectory's own
`SKILL.md`, vendored into `templates/lenses/` or dropped in by a user --
never one of ce-harness's own lens files) **apply its guidance for
identification only.** Such a skill may be written in an instructive,
editing voice (e.g. "delete this," "move that") because it was authored
for an agent actively making changes, not for a read-only review. Use it
to recognize and record findings exactly like any other lens -- never as
license to edit, fix, or otherwise modify anything. This command's own
guardrail (`/verify` only reads and reports) always wins regardless of
what a loaded skill's own instructions say.

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
assumed -- and discovery must never stop at the worktree root. A
repository-root scope not defining some check (e.g. no root-level
formatter) does **not** mean that check is unavailable or not
applicable -- a changed nested app/package can have its own manifest,
task runner, or CI configuration defining it, even when the root has
nothing. Concluding "not applicable" without inspecting the scopes the
change actually touches is exactly the mistake this step exists to
prevent.

Two distinct concepts, kept separate below -- conflating them is its
own mistake (a component-level `README.md` must never make discovery
stop one directory too early, above the app/package it actually
belongs to):

- **Tooling/execution scope boundary**: a manifest, task runner, or
  build/CI configuration that actually establishes a project/check
  execution context (`package.json`, `pyproject.toml`, `Cargo.toml`,
  a `Makefile`, a CI workflow, etc.). These -- and only these -- stop
  the upward scope search and define the working directory a command
  actually runs from.
- **Instruction evidence**: `AGENTS.md`, `README.md`, `CONTRIBUTING.md`,
  or similar repository guidance. These are read for whatever
  test/lint/build guidance they document, at every level from the
  changed file up through the resolved scope and the root -- but they
  never define an execution scope or a command's working directory by
  themselves, and never stop the tooling-scope search below.

1. **Find every scope the change touches**, using tooling/execution
   boundaries only. Starting from the changed-file list already
   gathered in Step 3 (the three-dot diff against the same range Step 3
   resolved -- `$CE_DIFF_BASE...$CE_DIFF_HEAD` for an explicit review
   range, or `<merge-base>...HEAD` otherwise), find each changed file's
   *nearest* owning scope: walk upward from the file's own directory,
   stopping at the first directory (including possibly the file's own)
   that contains any of the tooling markers below, or at `$CE_WORKTREE`
   itself if none is found first:

   ```bash
   find_scope() {
     local dir
     dir=$(dirname "$1")
     while [ "$dir" != "." ] && [ "$dir" != "/" ]; do
       for marker in package.json pyproject.toml Pipfile Cargo.toml go.mod \
                     Gemfile Makefile Taskfile.yml justfile Rakefile; do
         [ -e "$CE_WORKTREE/$dir/$marker" ] && { echo "$dir"; return; }
       done
       [ -d "$CE_WORKTREE/$dir/.github/workflows" ] && { echo "$dir"; return; }
       dir=$(dirname "$dir")
     done
     echo "."
   }

   git -C "$CE_WORKTREE" diff --name-only <the same diff range Step 3 resolved> \
     | while read -r f; do find_scope "$f"; done \
     | sort -u
   ```

   `README.md`/`AGENTS.md`/`CONTRIBUTING.md` are deliberately **not**
   in this marker list -- a documentation file sitting in some
   intermediate directory (e.g.
   `apps/dashboard/src/components/README.md`) must never make a changed
   file under it (e.g. `.../components/ContactDrawer.vue`) resolve to
   that intermediate directory instead of the real tooling scope above
   it (`apps/dashboard`, where `package.json` actually lives).

   This prints the distinct set of nested scope directories the change
   touches, relative to `$CE_WORKTREE` (no output at all means every
   changed file's nearest scope is the root itself). **The relevant
   scope set is this output plus `$CE_WORKTREE` itself, always** -- a
   repository-wide check can still genuinely apply even once a more
   specific nested scope is also found; finding a nested scope means it
   must *additionally* be inspected, never that the root is skipped.

2. **Gather instruction evidence along the way**, separately from step
   1's scope boundaries. For each changed file, also collect every
   `AGENTS.md`/`README.md`/`CONTRIBUTING.md` found at *any* directory
   level from the file's own directory up through its resolved scope
   and the root -- not just the scope directory itself:

   ```bash
   find_docs() {
     local dir
     dir=$(dirname "$1")
     while :; do
       for doc in AGENTS.md README.md CONTRIBUTING.md; do
         if [ -e "$CE_WORKTREE/$dir/$doc" ]; then
           if [ "$dir" = "." ]; then echo "$doc"; else echo "$dir/$doc"; fi
         fi
       done
       [ "$dir" = "." ] && break
       dir=$(dirname "$dir")
     done
   }
   ```

   Read whatever this finds for documented "how to test/lint/build
   this" guidance. This is purely additive evidence for *what* command
   a scope's tooling might expect -- it never changes *where* (which
   scope/working directory) that command actually runs from; that is
   decided by step 1 alone.

3. **Inspect each relevant scope independently**, exactly as before,
   just rooted at that scope's own directory instead of always at
   `$CE_WORKTREE`. For each scope (root, and every nested one found
   above), inspect, in roughly this order, whichever of these exist
   **inside that scope's own directory**, and choose the smallest
   targeted set that validates the change (typically a test run, a
   type/lint/format check if the language/tooling has one, and a build
   if applicable):

   - Package manifests: `package.json` (`scripts` block), `pyproject.toml` /
     `Pipfile`, `Cargo.toml`, `go.mod`, `Gemfile`, etc.
   - Task runners / build files: `Makefile`, `Taskfile.yml`, `justfile`,
     `Rakefile`
   - CI workflows/configuration (e.g. `.github/workflows/*.yml`):
     read-only, as evidence of which commands the repository itself
     already trusts for this scope -- consulted to discover what to
     run, never executed directly.
   - Instruction evidence gathered in step 2 for this scope (and any
     intermediate directory beneath it), for documented "how to
     test/lint/build this project" guidance.

   Do not assume npm, Docker, Prisma, or any other specific stack or
   tool -- each scope may use a completely different package
   manager/toolchain than the root or any other scope; choose whatever
   *that scope's own evidence* actually shows, never carry an
   assumption over from another scope. Run each chosen command with its
   working directory set to that scope's own directory
   (`$CE_WORKTREE/<scope>`, or `$CE_WORKTREE` itself for the root
   scope) -- never wherever an instruction-evidence doc happens to live,
   and never always `$CE_WORKTREE`, since a nested scope's own tooling
   (e.g. an `npm` script relying on that package's own `node_modules`)
   resolves relative to where it actually lives. Record the exact
   command line used **and the scope directory that justified it** for
   each.

4. **Before declaring any validation category (e.g. "format check",
   "lint", "typecheck", "test", "build") unavailable or not
   applicable, confirm this holds at *every* relevant scope from step 1
   above, not just the root.** A category is only truly
   unavailable/not applicable once no scope's manifests, task runners,
   CI configuration, or gathered instruction evidence define it. Still
   do not run every discovered script in every scope regardless of
   relevance, and do not invent a command no scope's own evidence
   supports -- the same discipline as before, just applied per scope
   instead of only at the root.

If no verification commands can be discovered across any relevant
scope, or a discovered command requires an environment/dependency that
is not available (e.g. a database, external service, or credential),
mark that check as `BLOCKED` and state the specific reason, including
which scope(s) were inspected. Do not skip -- a `BLOCKED` result in the
report is informative; a missing result is not.

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

### Docker safety

Docker carries a risk distinct from the mutation question above: reusing
or colliding with a container, network, or Compose project that belongs
to a *different* checkout entirely -- a stale or unrelated container
reused by mistake can silently corrupt this workspace's environment, or
this workspace's own containers could corrupt someone else's. Before any
discovered verification command starts, reuses, or otherwise interacts
with Docker (e.g. `docker compose up`, a container-backed test
database), verify all three of the following. This is read-only
diagnosis, not mutation -- it always runs, before Environment-mutation
safety's Case A/B/C classification above even applies to the Docker
command itself:

1. **Container ownership.** Never reuse an already-running container by
   name or image alone. For a Compose-managed container, confirm it was
   actually created for `$CE_WORKTREE`:
   ```bash
   docker inspect <container> --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
   ```
   This reports the exact host directory Compose created the container
   from -- it must resolve to `$CE_WORKTREE` or a path inside it. If it
   resolves anywhere else (a different worktree, the original checkout,
   or an unrelated project), that container does not belong to this
   workspace: never reuse, stop, remove, or otherwise touch it. For a
   container not managed by Compose, apply the same principle -- confirm
   via `docker inspect` (mounts, working directory, labels) that it was
   created for this exact worktree before touching it, never from its
   name alone.
2. **Compose project-name collisions.** Compose defaults its project
   name to the basename of the directory containing the compose file --
   for a ce-harness worktree, that is the sanitized issue name, which is
   not guaranteed unique across projects or across a stale leftover from
   a prior run under the same path. Before running `docker compose up`,
   check whether a project by the name Compose would use already exists
   (`docker compose ls`, or `docker ps --filter
   label=com.docker.compose.project=<name>`). If one does, apply the
   ownership check above to it: reuse it only if its `working_dir` label
   resolves inside `$CE_WORKTREE`; otherwise this is a genuine
   collision -- report it, never silently pick a different name or
   proceed. Prefer an explicit `--project-name` (or
   `COMPOSE_PROJECT_NAME`) derived deterministically from `$CE_WORKTREE`
   over relying on the directory-basename default, precisely to avoid
   this collision in the first place.
3. **Port conflicts.** Before starting anything, read the compose
   file(s)' `ports:` mappings (or a Dockerfile's exposed ports, if
   started directly) to learn which host ports would be bound, and check
   whether each is already in use (e.g. `lsof -i :<port>`, `ss -ltnp`, or
   `docker ps` for a container already publishing it) -- before
   attempting startup, not after it fails with a cryptic error. A port
   already in use by something unrelated is a conflict to report, never
   a signal to silently pick a different port than the one the
   repository's own configuration specifies.

If any of the three finds a problem -- an unrelated container, a
project-name collision that doesn't resolve to this worktree, or a port
already in use -- do not start, reuse, or otherwise proceed. Mark the
affected check `BLOCKED` and state exactly what was found (the
container/project name and its actual `working_dir` label, or the
specific port and what already holds it) under "Gaps and Blockers" --
the same diagnostic discipline as any other blocked check, never a
silent work-around. None of this is specific to any one repository's
Docker/Compose setup: the same three checks apply regardless of the
service names, ports, or project names a given repository happens to
define.

**Handling large output:**
- Always preserve the exact **exit code** of each command -- this is what
  `PASS`/`FAIL`/`BLOCKED` is ultimately based on.
- Always preserve the **final test/check summary line(s) verbatim** (e.g.
  "12 passed, 1 failed", a linter's total-error count, a compiler's final
  diagnostic count).
- Always preserve **every failure/error line, and any surrounding context
  needed to diagnose it** (the failing test's name, the assertion that
  failed, the stack frame that points at your own code).
- Always preserve **every warning the tool itself reported, even when the
  command exits 0** (e.g. a compiler/linter warning, a deprecation
  notice, a peer-dependency warning, a framework's own "you should fix
  this" output). A clean exit code means the command did not fail -- it
  never means its output had nothing worth recording. Quote the warning
  verbatim in the report's "Commands Executed and Outcomes" entry for
  that command (see below); do not paraphrase or summarize it away.
- Passing-test noise and repetitive successful output (e.g. hundreds of
  identical "✓ passed" lines) may be omitted once the summary line and
  exit code are preserved -- they add no additional evidence. Never fold
  a tool-reported warning into this "noise" category just because the
  command still exited 0 -- a warning is evidence, the noise this bullet
  allows omitting is not.
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

**Never infer today's date from memory, training data, or any other
form of model knowledge -- always compute it from the system clock:**

```bash
date -u +%Y-%m-%d
```

Use this command's exact output, verbatim, as `<YYYY-MM-DD>` everywhere
below (the filename, and the report's own `**Date:**` field) -- never a
remembered, assumed, or estimated date. This is the same
never-guess-it-yourself discipline the worktree fingerprint and
artifacts hash below already follow for "what state does this
verification cover" -- the report's own date is exactly as
deterministic a fact, and guessing it wrong (e.g. from a stale training
cutoff) has bitten real usage before.

Resolve the report destination from `changeRoot` (never construct it by
hand):

```bash
mkdir -p "<changeRoot>/reports"
# write to: <changeRoot>/reports/<YYYY-MM-DD>-verify.md
```

This directory and file live **only** inside the external OpenSpec
store at `$CE_OPENSPEC_STORE` -- never create a `reports/` directory,
`openspec/` directory, `.opencode/` directory, or any other file inside
the target repository or its Git worktree.

Before writing the report, resolve exactly (never estimate) what state
this verification covers -- `/archive` later uses these three values to
detect whether this evidence has gone stale:

```bash
# Commit -- for human reference only; not itself what /archive compares.
git -C "$CE_WORKTREE" rev-parse HEAD

# Worktree fingerprint -- covers uncommitted implementation changes, not
# just the commit: tracked changes staged or unstaged (git diff HEAD),
# plus the actual content of untracked, non-ignored files (a new or
# edited file nobody `git add`ed yet still changes this). `ls-files`
# prints paths relative to the repo root, not the caller's own cwd, so
# the `cd "$CE_WORKTREE"` subshell before `cat` is required -- without
# it, a caller running this from anywhere else would try to read paths
# relative to its own location and silently miss every untracked file.
{
  git -C "$CE_WORKTREE" rev-parse HEAD
  git -C "$CE_WORKTREE" diff HEAD
  git -C "$CE_WORKTREE" ls-files --others --exclude-standard -z | (cd "$CE_WORKTREE" && xargs -0 cat) 2>/dev/null
} | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-12

# Artifacts hash -- covers the agreed contract this verification actually
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
command.

### Report structure

```markdown
# Verification Report: <change-name>

**Date:** YYYY-MM-DD
**Change:** <changeRoot>
**Verified worktree commit:** <full SHA -- human reference only>
**Verified worktree fingerprint:** <12-char hash covering the commit plus any uncommitted tracked/untracked implementation changes>
**Verified artifacts hash:** <12-char hash covering proposal.md/design.md/tasks.md/specs/, or "N/A -- no artifacts to hash">

## Scope

<what this verification covers: change name, schema, worktree path, commit/diff range examined. If the Guard (Step 0) detected a review-to-implementation transition, say so explicitly here (e.g. "This workspace was created via `ce review` for an external PR and transitioned to implementation of change `<name>` -- verified against the resulting diff, not the original PR range.") -- never let this look indistinguishable from a workspace that started as an Implementation workspace.>

## Evidence Examined

<list of artifacts read (proposal, design, specs, tasks), files inspected in $CE_WORKTREE, and any tools used (semantic code navigation, grep, etc.)>

## Lens Coverage

**Lenses applied:** <comma-separated lens names, in the order applied, or "None">
**Other lenses considered:** <other lens names found in $CE_LENSES_DIR but not selected, or "None found">

| Lens | Selection rationale | Lens checks applied |
|---|---|---|
| <lens name> | <why this one was selected, in 1-3 sentences> | <the lens's own "## Lens checks" list, or -- when the lens has no such section, as with an external Agent Skill -- a 1-2 sentence summary of its `description` frontmatter instead> |

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

- `<discovered command>` (scope: `<scope directory relative to $CE_WORKTREE, or "." for the root>`): PASS / FAIL / BLOCKED -- <reason if not PASS>
  - Warnings: <verbatim warning line(s) the command itself reported, if any -- omit this line entirely for a command with none. A PASS with warnings listed here is still PASS: recording a warning here never by itself changes this command's own PASS/FAIL/BLOCKED status or the Overall Verdict below.>

## Gaps and Blockers

- <unverified/blocked item, unchecked task, or scope limitation, and why> -- **Merge impact:** Blocking / Non-blocking

---

## Overall Verdict

**Verdict:** PASS

<one-line summary of why, referencing the criteria below>
```

Write `**Verdict:**` followed by exactly one of `PASS`, `PASS WITH
GAPS`, or `FAIL` -- nothing else on that line. This is a durable,
machine-checkable field: `/archive` greps it verbatim to decide whether
this evidence is good, so never rename it, reformat it, or leave more
than one token on it.

Every entry under "Gaps and Blockers" must end with an explicit
**Merge impact:** `Blocking` or `Non-blocking` -- the same two labels
`/adversarial-review` uses for its own findings, so `/archive`'s gate
(see `templates/commands/archive.md`) can read both reports the same
way. **`Blocking` is always the default.** Mark a gap `Non-blocking`
only when you can state a concrete reason the requirement is still
adequately supported despite it -- e.g. a live external check that
couldn't run for a stated, verifiable reason (an unavailable
credential/service outside this change's control), where the same
behavior was otherwise confirmed through code inspection, a lower-level
test, or an equivalent check that did run. A gap with no such reason,
or where the missing check is itself the only evidence for the
requirement, stays `Blocking`. An `UNVERIFIED CHECKBOX`, or a
`PARTIALLY VERIFIED` item where what's missing could plausibly mean the
requirement isn't actually met, is always `Blocking` -- never mark one
`Non-blocking` merely to avoid re-running verification. This
classification never changes the verdict token itself (below) -- it
only tells `/archive` which gaps it may treat as accepted and which it
must still block on.

- `PASS` -- all requirements VERIFIED, all design commitments
  VERIFIED/N/A, all checked tasks VERIFIED, all executed commands PASS.
  A command that exits 0 but reported warnings (see "Commands Executed
  and Outcomes" above) still counts as PASS here -- this version only
  guarantees those warnings are recorded and visible in the report,
  never silently dropped; classifying them (e.g. distinguishing one
  introduced by this change from a pre-existing one, or ever escalating
  a warning to `PASS WITH GAPS`/`FAIL` on its own) is deliberately out
  of scope for this version.
- `PASS WITH GAPS` -- no NOT VERIFIED requirements, no UNVERIFIED
  CHECKBOX tasks, and no FAILed commands, but one or more items are
  BLOCKED or PARTIALLY VERIFIED. List the gaps above, each with its
  Merge impact. This verdict token alone does not determine archive
  eligibility -- `/archive`'s own gate reads each gap's Merge impact
  directly, not just this token (see the paragraph above).
- `FAIL` -- one or more requirements NOT VERIFIED, tasks UNVERIFIED
  CHECKBOX, design commitments NOT VERIFIED, or executed commands
  FAILed. See findings above.

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
never a placeholder, and never the store's root or the change's whole
directory -- so the command opens precisely the file just written. This
requires no runner- or editor-specific knowledge in this command (it
delegates to whichever editor `ce open` is already configured for), and
never requires the user to know or copy the store's internal path
themselves. The printed report path remains useful as a reference (e.g.
to paste elsewhere), but must never be the only way offered to reach the
report.

You may **suggest** fixes for any findings
in the chat response, but never apply them automatically -- this command
only verifies and reports. If the user wants to act on a finding, that is a
separate, explicit step.

State the next step based on the verdict -- never `/archive` from this
command either way, that is entirely `/archive`'s own gate to decide:
- `PASS` -- run `/adversarial-review` next for independent defect hunting.
- `PASS WITH GAPS` or `FAIL` -- address the findings above first (via
  `/apply` or a manual fix), then re-run `/verify` -- do not proceed to
  `/adversarial-review` on a report that isn't a clean `PASS`.

**Guardrails**
- Never end Step 10 with only the report's printed filesystem path --
  always also give the user a ready-to-run `ce open --path "<report
  path>"` command for that exact file, since a bare external-store path
  is not itself an actionable handoff. Never substitute a directory, the
  store root, or `ce open --change` for this -- the command must open
  the exact report file just written.
- Never write the report's date (filename or `**Date:**` field) from memory or assumption -- always run `date -u +%Y-%m-%d` and use its exact output.
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
- Never declare a validation category (format/lint/typecheck/test/build)
  unavailable or not applicable after inspecting only the worktree
  root -- always find every scope the changed files touch (Step 8.1)
  first, and confirm the category is undefined at all of them before
  reporting it unavailable.
- A nested scope's tooling may use a completely different package
  manager/toolchain than the root -- never assume one scope's stack
  applies to another; discover each scope's commands from that scope's
  own manifests/task runners/CI config/docs only.
- `AGENTS.md`/`README.md`/`CONTRIBUTING.md` are instruction evidence,
  never a tooling/execution scope boundary -- a doc file in some
  intermediate directory must never stop scope discovery (Step 8.1)
  early or define a command's working directory; only a manifest, task
  runner, or CI/build configuration does either of those.
- Never run every discovered script in every scope "just in case" --
  the smallest targeted set per scope, exactly as at the root.
- Every "Gaps and Blockers" entry must end with an explicit **Merge
  impact: Blocking** or **Non-blocking** tag -- `Blocking` by default;
  `Non-blocking` only with a stated reason the requirement is still
  adequately supported despite the gap. `/archive`'s gate treats any
  entry with no tag at all (a legacy report predating this convention)
  as `Blocking`, never as safe by omission.
- An exit code of 0 is never license to drop a command's warnings --
  quote any warning the tool itself reported (compiler, linter,
  deprecation, peer-dependency, or similar) verbatim in that command's
  "Commands Executed and Outcomes" entry, even though the command still
  counts as PASS. Recording it there never by itself changes that
  command's PASS/FAIL/BLOCKED status or the Overall Verdict -- treating
  warnings as blocking, or distinguishing one introduced by this change
  from a pre-existing one, is future work, not this version's scope.
- Mutating database schema/data, infrastructure, external services, or
  developer configuration always requires either a proven disposable
  environment (established by concrete repo evidence, never inferred
  from a name containing "test") or explicit user approval -- see
  "Environment-mutation safety" in Step 8. A withheld mutation is a
  verification limitation (`BLOCKED`), never converted into a defect.
- Before interacting with Docker, verify container and Compose-project
  ownership and check for port conflicts -- see "Docker safety" in
  Step 8. Never reuse, stop, or otherwise touch a container or Compose
  project whose `working_dir` label doesn't resolve inside
  `$CE_WORKTREE`; report a collision or port conflict as `BLOCKED`,
  never a signal to silently proceed around it.
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
