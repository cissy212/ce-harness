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
| `/enrich` | Clarifies and confirms the requirement is actually understood well enough to propose a good technical change — the step between "I looked at the code" and "here's the plan," so `/propose` isn't building on an assumption nobody checked. |
| `/propose` | Creates a new OpenSpec change and generates **all** of its artifacts (proposal, design, tasks) in one step, grounded in what `/explore`/`/enrich` established. |
| `/apply` | Implements the tasks from an OpenSpec change, one at a time, only inside the worktree — marking each task's checkbox as it completes it, and pausing on anything unclear or blocked. |
| `/verify` | Checks the implementation against the change's proposal, design, specs, and tasks — the **conformance baseline**. Runs discovered test/lint/build commands and writes a report into the OpenSpec store. Never fixes code. **Refuses to run in an `Existing PR review` workspace** (there's no OpenSpec-driven implementation to check conformance against) — use `/adversarial-review` there instead. |
| `/adversarial-review` | In an `Implementation` workspace: runs after `/verify` and independently hunts for defects, gaps, and risks the specification itself doesn't describe, challenging `/verify`'s report rather than duplicating it. In an `Existing PR review` workspace: the **only** review step — reviews the commit range directly against the PR description and repository conventions, with no OpenSpec change involved. Never fixes code, either way. |
| `/archive` | Archives a completed change: checks artifact/task completion, offers to sync delta specs into the main specs, and moves the change into the store's archive. |
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

The lenses shipped today:

| Lens | Use when reasoning about... |
|---|---|
| `backend-developer` | Backend/server-side code in any language: module boundaries, data access, dependency management, type safety, error handling, testability, database/query design. |
| `frontend-developer` | Client/UI code in any framework: component boundaries, state ownership, rendering behavior, data-fetching and loading/error states, event handling, DOM/browser behavior. |
| `typescript-engineer` | TypeScript's type system specifically: type soundness, narrowing, generics, discriminated unions, variance, module/declaration boundaries, `any`/`unknown` handling. |
| `accessibility-reviewer` | User-facing markup/UI for accessibility: semantic structure, ARIA usage, keyboard operability, focus management, color/contrast. |
| `security-reviewer` | Security: trust boundaries, input validation, injection, authentication/authorization, secrets handling, dependency/supply-chain risk. |
| `pipeline-data-engineer` | Data pipelines, ingestion jobs, scheduled tasks, ETL/ELT workflows, scraping or enrichment pipelines, synchronization processes, or long-running operational scripts where execution behavior under failure, retry, or concurrency matters. |

They're discovered from `$CE_LENSES_DIR` (a plain directory of `.md`
files inside the workspace — never a runner-specific path), so a
different runner adapter could point its own discovery mechanism at the
same files without ce-harness duplicating anything.

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
  before archiving.
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
