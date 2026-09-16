# Workflow guide

What each slash command in the workflow actually does, how reasoning
lenses work, and the safety behavior `/verify`/`/adversarial-review` use
around mutating commands and Docker. See the [README](../README.md) for
the two workflows at a glance; this is the detailed version.

## The canonical workflow commands

The commands below are the same canonical workflow for either runner —
materialized from the same `templates/` source (see [Choosing a
coding-agent runner](cli-reference.md#choosing-a-coding-agent-runner) in
the CLI reference) — this section just uses OpenCode's terminology and
directory layout to describe it concretely; substitute Claude Code's
`.claude/commands/` if that's what you're using instead. Once the runner
is launched inside the worktree, these slash commands are available (in
`opencode/commands/` inside the workspace's OpenCode config, wired up
automatically):

| Command | What it does |
|---|---|
| `/workspace` | Shows the current workspace's context in plain language: project, issue, workspace type, worktree/workspace paths, OpenSpec store id, lenses directory. A safe first command in any session. |
| `/explore` | Explores the codebase read-only and records findings about the problem and the existing system — use when you want to investigate before committing to a plan. |
| `/enrich` | Clarifies and confirms the requirement is actually understood well enough to propose a good technical change — the step between "I looked at the code" and "here's the plan," so `/propose` isn't building on an assumption nobody checked. Also consults the [Retrieval Contract](#retrieval-contract-and-project-local-knowledge) for relevant prior context, and may record a new, evidence-backed observation to the project's shared `knowledge.md` when it reaches one worth keeping. |
| `/propose` | Creates a new OpenSpec change and generates **all** of its artifacts (proposal, design, tasks) in one step, grounded in what `/explore`/`/enrich` established. |
| `/apply` | Implements the tasks from an OpenSpec change, one at a time, only inside the worktree — marking each task's checkbox as it completes it, and pausing on anything unclear or blocked. |
| `/verify` | Checks the implementation against the change's proposal, design, specs, and tasks — the **conformance baseline**. Runs discovered test/lint/build commands and writes a report into the OpenSpec store. Never fixes code. **Refuses to run in an `Existing PR review` workspace** (there's no OpenSpec-driven implementation to check conformance against) — use `/adversarial-review` there instead. |
| `/adversarial-review` | In an `Implementation` workspace: runs after `/verify` and independently hunts for defects, gaps, and risks the specification itself doesn't describe, challenging `/verify`'s report rather than duplicating it. In an `Existing PR review` workspace: the **only** review step — reviews the commit range directly against the PR description and repository conventions, with no OpenSpec change involved. Detects on its own whether this is a **follow-up review** of a workspace it already reviewed before (see [Follow-up PR reviews](cli-reference.md#follow-up-pr-reviews)), and if so, verifies each previous finding against the new code before looking for anything new. Never fixes code, either way. When a follow-up review's reconciliation confirms a finding's own assumption was wrong, with fresh evidence, it may record that observation to the project's shared `knowledge.md` — see [Retrieval Contract](#retrieval-contract-and-project-local-knowledge). Its actual judgment runs in a fresh, delegated subagent context whenever possible, isolated from this conversation's own discussion of the implementation — see [Reviewer context isolation](#reviewer-context-isolation). |
| `/archive` | Archives a completed change: checks artifact/task completion, runs a **Knowledge check** that reads (never writes) the project's shared `knowledge.md` and may recommend — never silently apply — a canonical-documentation update (see [Retrieval Contract](#retrieval-contract-and-project-local-knowledge)), offers to sync delta specs into the main specs, and moves the change into the store's archive. |
| `/publish` | Ships the completed, archived change as a normal GitHub pull request: fetches and safely updates against the current base branch, shows the exact repository/branch/included commits/PR title/PR description, and only pushes and opens the PR after explicit confirmation. Never merges, never enables auto-merge. |

In an **Implementation** workspace, the canonical order is: `/explore` →
`/enrich` → `/propose` → `/apply` (repeat as needed) → `/verify` →
`/adversarial-review` → `/archive` → `/publish`. In an **Existing PR
review** workspace, `/adversarial-review` is the whole workflow — run it
directly, no other command is needed or applicable (`/publish` refuses
there too, for the same reason `/verify` does: there's no
OpenSpec-driven implementation of its own to publish). None of these
commands ever write OpenSpec files, reports, or harness config inside
your actual repository or worktree — only inside the external OpenSpec
store, and (for `/apply`) actual code changes inside the worktree
itself; `/publish` is the one exception that also reaches an external
service (GitHub), and only after you explicitly confirm its preview.

## Retrieval Contract and project-local knowledge

`/explore`, `/enrich`, `/propose`, `/verify`, and `/adversarial-review`
each consult the **Retrieval Contract** (`ce retrieve`) for relevant
prior context before doing their own work: current specs (this
project's actual, present-day source of truth), archived OpenSpec
changes, Existing PR review reports, and the project's shared
`knowledge.md` (below) — plus repository Git history. Matching is
deterministic (path/keyword/domain/identifier matching against the
durable store and Git history), never embeddings or a learned model, so
every result is explainable.

**Every result is advisory and historical, never authoritative.** A
result only ever carries a `status: "historical"` tag (a current spec is
the one exception, tagged `"current"`) and a date — retrieval itself
never judges whether something is still true. Each command's own
instructions require re-checking a retrieved result against the current
repository before relying on it; the current repository, its specs, its
docs, and its tests always win over anything retrieved. This is
something each command is instructed to do — it's not a runtime check
ce-harness enforces in code, the same way whether a review finding is
genuinely `Blocking` is a judgment call, not a computed value.

**Project-local learned knowledge** (`<durable store>/knowledge.md`,
[Directory layout reference](concepts.md#directory-layout-reference)) is
a small, shared, per-project file of evidence-backed conclusions —
things ce-harness confirmed while working on this repository that may
be useful to a *different*, later change in the same project, without
that later change needing to know which earlier change or review
discovered them. Every entry cites concrete evidence from the repository
at the time it was recorded (a file/line, a test, a spec) and a date —
it's explicitly historical/advisory, exactly like every other retrieval
result, and can go stale the same way an old report can. Only `/enrich`
and `/adversarial-review`'s reconciliation step write to it, and only
after checking a conservative bar: the observation must be specific and
reusable (not scoped to just this one change), backed by evidence from
the *current* repository state (never a citation of what an older
report merely claimed), genuinely demonstrated rather than merely
plausible, a settled conclusion rather than a hypothesis or
recommendation, and not already stated in the repository's own
documentation. `/archive` reads it (as part of its own Knowledge check,
below) but never writes it.

If later evidence contradicts or narrows an existing entry, a **new**,
separately dated entry is appended saying so — the older entry is never
edited or deleted, since it may genuinely have been correct for the
repository state it was recorded against. Retrieval can therefore return
both an older and a newer observation about the same thing; that's
intentional, not a bug — read the dates, and trust the current
repository over either one.

**The Knowledge check** runs at the end of an Implementation workspace's
`/archive` and at the end of an Existing PR review's `/adversarial-review`
run. It asks whether the change/review just produced something durably
reusable that the repository's own canonical documentation (an ADR,
`AGENTS.md`, `CONTRIBUTING.md`, an API spec, ...) doesn't already say.
When it finds something, it only ever *recommends*: `/archive` may pause
to let you incorporate a small, obvious edit before archiving;
`/adversarial-review` only ever prints the recommendation in its review
output. **Neither ever edits your repository's documentation itself** —
promoting something from advisory knowledge into canonical documentation
always stays your explicit decision.

**Existing PR review workspaces never archive**, but their reports are
still retrievable: `ce retrieve` reads a project's `reviews/*.md`
directly, so a past PR review's findings remain discoverable from a
later, unrelated workspace even though there's no archive step to move
them through.

**Known limitation:** a discovery that happens entirely in free-form
conversation — never captured by `/enrich` writing `enrich.md`, or by
`/adversarial-review`'s reconciliation step re-checking a prior finding
— isn't automatically written to `knowledge.md`. Nothing currently
prompts for that case; it's lost unless you explicitly ask for it to be
recorded.

## Reviewer context isolation

`/adversarial-review`'s actual judgment — reconciling prior findings,
the baseline pass, and the adversarial pass itself — is delegated to a
fresh subagent context whenever the runner supports it (both do today).
This exists specifically for the case where `/adversarial-review` runs
in the same conversation as an earlier `/apply` (an Implementation
workspace's normal order): without isolation, the review would inherit
everything that conversation already discussed about the implementation
— including the implementer's own self-justification — which is exactly
what an adversarial review is supposed to check independently of, not
defer to.

This conversation (never the delegated subagent) still does everything
that needs access outside the worktree or a human's input: loading
proposal/design/specs/tasks, locating prior reports, running `ce
retrieve`, and [lens selection](#reasoning-lenses) below — including the
same interactive prompt when several lenses match, completely unchanged.
It then hands the delegated reviewer only verbatim artifacts, evidence,
and review criteria — never its own account of what `/apply` did or why
— and the reviewer independently inspects the current worktree and diff
itself before returning its findings as data, never as a file it wrote.
This conversation persists that data using the same
reporting/reconciliation/`knowledge.md` mechanics described
[above](#retrieval-contract-and-project-local-knowledge), unchanged.
Handing over data rather than file paths is deliberate, not just
cautious: OpenCode subagents in particular cannot reach paths outside
the worktree at all (see [Directory layout
reference](concepts.md#directory-layout-reference) and the note on
OpenCode's `external_directory` permission there), so the durable
OpenSpec store, `CE_LENSES_DIR`, and any prior report are never
something the delegated reviewer is asked to go read itself.

**If delegation is unavailable or fails, the review still runs** —
inline, in this conversation, exactly as it would without this
mechanism — but ce-harness tells you so explicitly, since the review's
independence guarantee didn't hold for that run. It never fails the
review outright, and never falls back silently.

The delegation itself uses each runner's own stock, general-purpose
subagent (Claude Code: `Task`/`subagent_type: "general-purpose"`;
OpenCode: `general`) — the same primitive `/archive` already uses to
invoke `openspec-sync-specs` (see [Skills](#skills) below) — never a
custom, ce-harness-defined agent, so this stays part of the same
single-source `templates/` this command family already is.

## Reasoning lenses

A **reasoning lens** is a domain-specific set of questions and failure
modes that `/verify` and `/adversarial-review` can load as extra context
— for example, a lens sharpens a review's attention toward database/query
design, or toward accessibility, without replacing the review's own
baseline checks. Lenses are additive, not mutually exclusive: more than
one may apply to the same change. Lens selection is owned by ce-harness
itself (never the runner's own automatic skill/agent matching): each
command compares every available lens's description against the change,
using an operational/runtime-vs-structural tie-break only to decide what
counts as a match. If exactly one lens matches, it's applied
automatically; if none match, the review continues without one; if
several match, ce-harness asks you explicitly which to apply — you can
pick one, several, all, or none, and you can always override the
selection up front by naming lenses yourself. A lens (or several) is
always an additional layer on top of the review's own single baseline
pass, never a substitute for it and never a reason to repeat that
baseline — each is loaded as an ordinary document to read, never spawned
as a separate agent.

**A follow-up PR review never re-asks about a lens a human already
approved** — it recovers the previous review's own applied-lens list as
settled context — but it also never just assumes that list still covers
everything: it independently re-runs the same matching pass against the
new delta specifically, and only asks (or auto-applies, if there's
exactly one) about lenses that turn up newly there. A delta that's
mostly comment or dead-code cleanup, for example, can newly match a
lens the original, UI-focused diff never would have, entirely
independent of whether the files that matched originally are still
present elsewhere in the cumulative diff.

The lenses shipped today:

| Lens | Use when reasoning about... |
|---|---|
| `backend-developer` | Backend/server-side code in any language: module boundaries, data access, dependency management, type safety, error handling, testability, database/query design. |
| `frontend-developer` | Client/UI code in any framework: component boundaries, state ownership, rendering behavior, data-fetching and loading/error states, event handling, DOM/browser behavior. |
| `typescript-engineer` | TypeScript's type system specifically: type soundness, narrowing, generics, discriminated unions, variance, module/declaration boundaries, `any`/`unknown` handling. |
| `accessibility-reviewer` | User-facing markup/UI for accessibility: semantic structure, ARIA usage, keyboard operability, focus management, color/contrast. |
| `security-reviewer` | Security: trust boundaries, input validation, injection, authentication/authorization, secrets handling, dependency/supply-chain risk. |
| `pipeline-data-engineer` | Data pipelines, ingestion jobs, scheduled tasks, ETL/ELT workflows, scraping or enrichment pipelines, synchronization processes, or long-running operational scripts where execution behavior under failure, retry, or concurrency matters. |
| `comment-cleanup` (external Agent Skill) | Comment hygiene: redundant/stale/commented-out comments, edit-history narration, misplaced end-of-line comments — vendored unmodified from [motlin/claude-code-plugins](https://github.com/motlin/claude-code-plugins), see `THIRD_PARTY_NOTICES.md`. |

They're discovered from `$CE_LENSES_DIR` (a plain directory inside the
workspace — never a runner-specific path): either a `.md` file directly
inside it (a native ce-harness lens), or an immediate subdirectory's own
`SKILL.md` — a vendored or user-provided [Agent
Skill](https://agentskills.io/specification), consumed as external
expertise rather than something ce-harness has to author and maintain
itself. Both are discovered and selected the same way, by the same
description-matching algorithm. A different runner adapter could point
its own discovery mechanism at the same files without ce-harness
duplicating anything.

Because an Agent Skill may be written in an instructive, editing voice
(it wasn't authored for a read-only review), `/verify` and
`/adversarial-review` apply one for identification only — recognizing
and recording findings exactly like any other lens, never as license to
edit or fix anything. Each command's own reviews-only guardrail always
wins over what a loaded skill's own instructions say.

**CodeGraph** (referenced elsewhere as "semantic code navigation") is an
entirely optional, separate tool for faster codebase exploration during a
review. ce-harness never installs it and never requires it: at `ce
start`, it's auto-detected (a `codegraph` binary on `PATH`, overridable
with `CE_CODEGRAPH_BIN`) and wired up opportunistically when present,
with no configuration of your own needed either way — if it's not
installed, every command falls back to ordinary Grep/Read with no loss
of functionality. When used, its index lives at `<worktree>/.codegraph/`
(see [Directory layout reference](concepts.md#directory-layout-reference))
and is never something you need to install to use ce-harness.

## Environment-mutation safety

Both review commands treat observation (tests, lint, typecheck, build,
read-only queries, etc.) as allowed by default, and mutation (schema/data
migrations, seeds, resets, `terraform apply`, `kubectl apply`, and
similar) as requiring either a proven disposable environment or explicit
approval — never inferred from a name containing "test". They differ in
how much latitude they have:

- `/verify` is a conformance workflow, so it may exercise a migration or
  other state-changing behavior when the proposal/design/specs/tasks
  explicitly require it — but only in an already-established, genuinely
  disposable verification environment, or after asking. Mutation that
  isn't part of the change (e.g. a stale local database) always requires
  approval first.
- `/adversarial-review` is observational and more conservative: it never
  independently mutates database schema/data, infrastructure, external
  services, or developer configuration. It prefers challenging a prior
  `/verify` report's mutation evidence over re-running the mutation, and
  asks first if further mutation is genuinely needed to investigate a
  finding — in both the `Implementation` and `Existing PR review` modes.

A withheld mutation is reported as a verification limitation (`BLOCKED`,
or an explicit uncertainty), never silently converted into a defect.

## Docker safety

If a discovered verification command starts, reuses, or depends on
Docker (e.g. `docker compose up`, a container-backed test database),
`/verify` verifies three things first — read-only diagnosis, so it
always runs, before the mutation classification above even applies to
the Docker command itself:

- **Container ownership** — never reuse an already-running container by
  name alone. For a Compose-managed container, its
  `com.docker.compose.project.working_dir` label must resolve inside
  `$CE_WORKTREE`; if it resolves anywhere else, that container belongs
  to a different checkout and must never be reused, stopped, or removed.
- **Compose project-name collisions** — Compose defaults its project
  name to the worktree's directory name, which isn't guaranteed unique.
  If a project by that name already exists, the same ownership check
  applies to it before reuse; otherwise it's a genuine collision to
  report, never a reason to silently pick a different name.
- **Port conflicts** — host ports a compose file would bind are checked
  for existing use *before* startup is attempted, not discovered only
  after a cryptic failure.

Any problem found here is reported (`BLOCKED`) rather than worked
around silently. `/adversarial-review` relies on the same checks rather
than re-deriving them.

## Skills

ce-harness also ships two [Agent Skills](https://agentskills.io)
(`opencode/skills/` inside the workspace's OpenCode config):

- **`openspec-sync-specs`** — an internal workflow skill. `/archive`
  invokes it (as a subagent, keeping it out of your main conversation)
  when you choose to sync a change's delta specs into the main specs
  before archiving. `/adversarial-review` uses the same underlying
  subagent-delegation primitive for a different reason — see [Reviewer
  context isolation](#reviewer-context-isolation) above.
- **`composition-patterns`** — a vendored, third-party reference skill
  (React/TypeScript composition patterns: avoiding boolean-prop
  proliferation, compound components, context-based state design, React
  19 API changes), sourced from
  [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)
  via [skills.sh](https://skills.sh). It's unrelated to the OpenSpec
  workflow above — the runner discovers and applies it on its own,
  whenever your actual coding task matches its description. See
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) for its
  provenance and license.
