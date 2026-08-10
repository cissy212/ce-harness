# ce-harness

Personal, local-only developer harness for working on Git repositories.
`ce start` creates an isolated Git worktree plus a workspace directory
under `~/.ce-harness`, provisions an external [OpenSpec](https://github.com/Fission-AI/OpenSpec)
store for it, and launches [OpenCode](https://opencode.ai) inside that
worktree. The target repository itself is never modified with any
harness/OpenSpec files — everything ce-harness creates lives outside of
it.

This document is a complete, step-by-step installation guide for someone
who has never used ce-harness before, followed by a full user guide
covering every command, workflow stage, and concept. Follow the
installation section in order. Every command below can be copy-pasted
as-is (commands containing a placeholder like `<repository-url>` are
called out explicitly).

**Contents**
- [Installation](#installation)
- [User Guide](#user-guide)
  - [Core concepts](#core-concepts)
  - [Quick start](#quick-start)
  - [`ce` command reference](#ce-command-reference)
  - [Reviewing a GitHub pull request](#reviewing-a-github-pull-request)
  - [Reviewing an existing pull request or commit range](#reviewing-an-existing-pull-request-or-commit-range)
  - [Resuming a session](#resuming-a-session)
  - [The workflow inside OpenCode](#the-workflow-inside-opencode)
  - [Reasoning lenses](#reasoning-lenses)
  - [Environment-mutation safety](#environment-mutation-safety)
  - [Skills](#skills)
  - [Environment variables reference](#environment-variables-reference)
  - [Directory layout reference](#directory-layout-reference)
- [Troubleshooting](#troubleshooting)

## Installation

### 1. Prerequisites

You need all four of the following installed before you start:

- **git** — to clone this repository and for ce-harness to manage worktrees.
- **Node.js and npm** — to install and build ce-harness. See the exact
  supported version in the next section.
- **The OpenCode CLI** — the tool ce-harness launches inside each worktree.
- **The OpenSpec CLI** — the tool ce-harness uses to manage specs for each
  change.

Optionally, if you want to use `ce review` (see
[Reviewing a GitHub pull request](#reviewing-a-github-pull-request)):

- **The [`gh` CLI](https://cli.github.com)**, installed and authenticated
  (`gh auth login`). Every other command, including `ce start --base
  --head`, has no GitHub dependency at all.

The next sections install each of these one at a time.

### 2. Supported Node version

ce-harness requires **Node.js 22.12.0 or later**. This is not an arbitrary
choice — it's the exact minimum required by ce-harness's own dependencies
(the `commander` package, which ce-harness's command-line parsing depends
on directly, requires Node ≥22.12.0). Running an older Node version will
not work: ce-harness detects this itself and refuses to start with a
clear error message (rather than an unrelated crash) — see
"Troubleshooting" below if you hit this.

Check your current Node version:

```bash
node --version
```

If the output is `v22.12.0` or higher (for example `v22.12.0`, `v22.14.3`,
or `v24.0.0`), you're fine — skip to step 3.

If it's lower than `v22.12.0`, or if `node --version` fails because
`node` isn't installed at all, install a supported version:

**If you use [nvm](https://github.com/nvm-sh/nvm) (recommended):**

```bash
nvm install 22
nvm use 22
node --version
```

**If you don't use nvm:** download and install the current LTS release
from [https://nodejs.org/](https://nodejs.org/), then open a new
terminal and run `node --version` again to confirm.

npm is installed automatically together with Node — you do not need to
install it separately. Confirm it's present:

```bash
npm --version
```

### 3. Get the ce-harness source code

Clone the repository (replace `<repository-url>` with the actual URL you
were given for this repository):

```bash
git clone <repository-url> ce-harness
cd ce-harness
```

Every command from this point on assumes your terminal's current
directory is this `ce-harness` folder.

### 4. Install ce-harness's own dependencies

```bash
npm install
```

This downloads ce-harness's own dependencies (`commander`, `execa`,
`yaml`, `zod`) into a local `node_modules` folder. It does not install
OpenCode or OpenSpec — those are separate tools, installed in the next
two steps.

### 5. Install the OpenCode CLI

```bash
npm install -g opencode-ai
```

Confirm it installed correctly and check its version:

```bash
opencode --version
```

This should print a version number (for example `1.18.13`) with no
errors. If it prints "command not found" instead, see "Troubleshooting"
below.

### 6. Install the OpenSpec CLI

```bash
npm install -g @fission-ai/openspec
```

Confirm it installed correctly and check its version:

```bash
openspec --version
```

This should print a version number (for example `1.6.0`) with no
errors. If it prints "command not found" instead, see "Troubleshooting"
below.

### 7. Build ce-harness

```bash
npm run build
```

This compiles ce-harness's TypeScript source into a runnable
`dist/cli.js`, and marks that file as executable automatically — you do
not need to run `chmod` or any other permission command yourself. The
command should finish with no error output.

### 8. Link the `ce` command globally

```bash
npm link
```

This makes the `ce` command available everywhere on your system,
pointing at the `dist/cli.js` you just built. `npm link` may print
information about the packages it audited — that is normal.

### 9. Verify the installation

Confirm your shell can find the `ce` command:

```bash
command -v ce
```

This should print a file path (for example
`/usr/local/bin/ce` or a path inside your nvm installation directory)
with no error. If it prints nothing at all, see "Troubleshooting" below.

Then confirm the command actually runs:

```bash
ce --help
```

This should print ce-harness's usage text, including a description of
the `start`, `resume`, `status`, and `cleanup` commands. If you see a
"permission denied" error or any other error instead of the usage text,
see "Troubleshooting" below.

### 10. First `ce` command to run

`ce status` is the safest first command to run — it never modifies
anything and works whether or not you've started any ce-harness
workspace yet:

```bash
ce status
```

If no workspace is active, this prints exactly:

```
No active workspace.
```

That confirms ce-harness itself is fully working.

When you're ready to use ce-harness for real, point `ce start` at any
Git repository you already have a local, clean (no uncommitted changes)
clone of, together with a short identifier for the issue or task you're
working on:

```bash
ce start /path/to/your/repository your-issue-name
```

This creates an isolated worktree and workspace for that issue and
launches OpenCode inside it. Replace `/path/to/your/repository` with the
real path to a Git repository on your machine, and `your-issue-name`
with a short, filesystem-safe name for what you're working on (for
example `fix-login-bug` or `issue-42`).

## User Guide

### Core concepts

- **Worktree isolation.** `ce start` creates a separate [Git
  worktree](https://git-scm.com/docs/git-worktree) for each issue, under
  `~/.ce-harness/worktrees/<project>/<issue>` — a real, independent
  working directory on its own branch (`ce-harness/<issue>`), checked out
  from your repository's `main`/`master` tip by default. Your original
  clone is never touched: ce-harness refuses to even start if it has
  uncommitted or untracked changes, and all product-code changes happen
  only inside the worktree.
- **Workspace directory.** Alongside the worktree, `ce start` creates a
  workspace directory under `~/.ce-harness/workspaces/<project>/<issue>`.
  This holds everything ce-harness itself owns for that issue: the
  external OpenSpec store, the runner's configuration (commands, skills,
  reasoning lenses), and `workspace.yml` metadata. Nothing under here is
  ever written inside your repository or worktree either.
- **External OpenSpec store.** ce-harness uses
  [OpenSpec](https://github.com/Fission-AI/OpenSpec) for spec-driven
  development (proposal → design → tasks → implementation → verification
  → archive), but the spec files themselves live entirely inside the
  workspace directory, registered globally with OpenSpec under a
  deterministic id (`ce-<project>-<issue>-<hash>`) — never as an
  `openspec/` folder inside your repository.
- **One active workspace at a time.** ce-harness tracks a single active
  workspace. `ce start` refuses to run if one is already active; run
  `ce cleanup` first to finish or discard it before starting another.
  This is a deliberate simplicity constraint, not a technical limit of
  Git worktrees themselves.
- **Runner-agnostic by design.** ce-harness launches
  [OpenCode](https://opencode.ai) today, but the workflow commands,
  skills, and reasoning lenses are written to make no runner-specific
  assumptions (e.g. they never hardcode an OpenCode-specific path) —
  everything is wired together through plain files and environment
  variables, in case a different runner is used later.

### Quick start

```bash
ce start /path/to/your/repository fix-login-bug
```

This validates the repository, creates the worktree and workspace,
provisions the OpenSpec store, and launches OpenCode inside the worktree
with everything wired up. From there, work through the
[workflow inside OpenCode](#the-workflow-inside-opencode): `/explore` or
`/propose` to plan, `/apply` to implement, `/verify` and
`/adversarial-review` to check the work, `/archive` to finish.

When you're done (or want to abandon the attempt):

```bash
ce cleanup
```

This removes the worktree, its branch, and the workspace directory, and
unregisters the OpenSpec store. Use `ce status` any time in between to
see what's currently active. If OpenCode ever exits before you're done
(closed the terminal, crashed, etc.), `ce resume` gets you straight back
into the same workspace — see [Resuming a session](#resuming-a-session).

### `ce` command reference

#### `ce start <repo> <issue>`

Creates the worktree and workspace for `<issue>` against the Git
repository at `<repo>`, provisions its OpenSpec store, and launches
OpenCode inside the worktree.

- `<repo>` — path to your existing local clone. It must be clean (no
  uncommitted or untracked changes); commit, stash, or discard changes
  first.
- `<issue>` — a short identifier for what you're working on (an issue
  number or a slug like `fix-login-bug`). It's sanitized into a
  filesystem- and branch-safe form internally.
- `--base <ref>` / `--head <ref>` — optional; see
  [Reviewing an existing pull request or commit range](#reviewing-an-existing-pull-request-or-commit-range).

If OpenCode fails to launch after everything else succeeds, `ce start`
does **not** roll the workspace back — the workspace is still valid and
active, so just run `ce resume` (see [Resuming a session](#resuming-a-session))
instead of re-running `ce start`.

#### `ce review <repo> <pr-number>`

The convenient way to review a GitHub pull request when all you know is
the local repository path and the PR number — see
[Reviewing a GitHub pull request](#reviewing-a-github-pull-request).
Resolves the PR's exact base/head commits via the `gh` CLI, fetches only
what's needed to make them available locally, and starts the same
Existing PR review workspace `ce start --base --head` would, with the
issue identifier defaulted to `review-pr-<number>`.

- `<repo>` — path to your existing local clone (same requirement as
  `ce start`).
- `<pr-number>` — the PR's number, as a positive integer.
- Requires the `gh` CLI installed and authenticated (`gh auth status`).
  `ce start` itself has no GitHub dependency at all — only `ce review`
  does.

#### `ce resume`

Re-enters the active workspace: relaunches OpenCode with exactly the
same environment `ce start` used, in the same worktree. Requires an
active workspace and creates nothing — no new worktree, workspace,
OpenSpec store, or CodeGraph index — and never modifies `workspace.yml`.
See [Resuming a session](#resuming-a-session).

#### `ce status`

Read-only; safe to run any time, including with no active workspace (it
prints `No active workspace.` and exits). With an active workspace, it
reports:

- Project, issue, workspace type (`Implementation` or `Existing PR
  review` — derived from whether `--base`/`--head` were used, never a
  separate piece of state), repository path, base branch, internal branch
- Review base/head/merge-base commits (only shown for an explicit
  `--base`/`--head` range)
- Worktree and workspace paths, creation time
- Whether the worktree/branch still exist on disk, and whether the
  worktree is clean or has changed files
- The OpenCode config directory and whether it exists
- The reasoning-lenses directory and whether it exists
- The OpenSpec store id, root path, and health check result

#### `ce cleanup [--force]`

Removes the active workspace's worktree, its Git branch, and the
workspace directory, and unregisters its OpenSpec store first. Refuses
(without `--force`) if:

- the worktree has tracked or untracked changes (to avoid silently
  discarding work), or
- your current shell directory is inside the worktree being removed (to
  avoid leaving your shell in a directory that no longer exists) — `cd`
  out of it first, or
- the OpenSpec store can't be unregistered because the `openspec`
  executable isn't available.

`--force` proceeds through the first and third of these anyway (discards
worktree changes; removes harness-owned files even if unregistering the
store failed). It never bypasses the "your shell is inside the worktree"
check — always `cd` elsewhere first.

### Reviewing a GitHub pull request

The quickest way to review a GitHub PR when all you know is the local
repository path and the PR number:

```bash
ce review /path/to/repo 119

# OpenCode opens
/adversarial-review

# if OpenCode closes
ce resume

# when finished
ce cleanup
```

`ce review` resolves the PR's exact base/head commits via the `gh` CLI
(installed and authenticated — see [Prerequisites](#1-prerequisites)),
fetches only what's needed to make those exact commits available
locally (it never switches your current branch, never touches your
working tree, and never assumes the PR's head branch exists on
`origin` — same-repo and fork PRs both work), and starts the same
Existing PR review workspace described below, with the issue
identifier defaulted to `review-pr-<number>` so you never have to name
it yourself. Before OpenCode launches, it prints a concise summary:

```
GitHub PR #119
Dashboard api wiring contacts

Base: main      9392fe9
Head: dashboard-api-wiring-contacts  8fb7148

Workspace type: Existing PR review
```

If `gh` is missing, unauthenticated, or can't resolve the PR, `ce
review` fails with an actionable error before creating anything
persistent — exactly like every other `ce start`-family pre-flight
check.

`ce review` is the convenient, GitHub-specific path. For any other exact
commit range — not from GitHub, or already fetched by some other means
— use the generic, manual path below instead.

### Reviewing an existing pull request or commit range

`ce start --base --head` is the generic, exact-commit-range workflow
underneath `ce review` (and the only option for a non-GitHub commit
range). By default, `ce start` reviews "whatever changes on top of
`main`/`master`" — the normal in-progress-work case. To instead review
an **exact, already-existing commit range** (for example, an open or
already-merged pull request) yourself, pass both `--base` and `--head`: 

```bash
ce start /path/to/your/repository review-pr-123 --base main --head feature-branch
```

- Both refs must already exist **locally** — ce-harness never fetches
  automatically. Make sure you've pulled/fetched the branch or commits
  you want to review first.
- `--base` and `--head` must be given together; either one alone is
  rejected before anything is created.
- `base` does not need to be an ancestor of `head` — only that they
  share some common history (a merge base) — so this works correctly
  even for a PR whose base branch has since moved forward.
- The worktree is checked out at the resolved `head` commit, and the
  resolved SHAs are recorded in `workspace.yml` and shown by `ce status`.
- `/verify` and `/adversarial-review` detect this automatically (via the
  `CE_DIFF_BASE`/`CE_DIFF_HEAD` environment variables) and review exactly
  that commit range using three-dot diff semantics, instead of
  auto-detecting a base branch.

This is a first-class workflow, not an improvised fallback: `/verify`
refuses to run entirely (there is no OpenSpec-driven implementation to
check conformance against), and `/adversarial-review` runs an explicit,
dedicated **Existing PR review** mode instead of its usual
Implementation-workspace one —

- it never tries to resolve, require, or invent an OpenSpec change, and
  never performs proposal/design/tasks/spec conformance checks;
- its review baseline is the PR description, the target repository's own
  conventions/documentation, and the commit range itself, instead of
  OpenSpec artifacts;
- its report is written to an official, dedicated location inside the
  OpenSpec store (`<store root>/reviews/<date>-adversarial-review.md`)
  rather than a change's `reports/` directory, since there is no change.

Everything else about the review — the mindset, the mandatory baseline
pass, lens selection, the four-axis finding classification, and the
verdict rules — is identical to the Implementation-workspace flow.

### Resuming a session

If OpenCode exits (you closed the terminal, it crashed, etc.) but you
haven't run `ce cleanup`, the workspace is still active — re-running
`ce start` will refuse ("a workspace is already active"). Get back into
it with:

```bash
ce resume
```

This relaunches OpenCode with exactly the same environment `ce start`
used the first time, in the same worktree. It requires an active
workspace and never creates, registers, or initializes anything — no new
worktree, no new workspace, no OpenSpec store, no CodeGraph index — and
it never modifies `workspace.yml`. If there's no active workspace, or the
recorded worktree/workspace is missing or its metadata doesn't check out,
it explains exactly what's wrong and points you at `ce cleanup --force`
rather than guessing or repairing anything silently.

Reconstructing the launch command by hand is no longer the normal path —
keep it only as a fallback for debugging (e.g. if `ce resume` itself
can't launch OpenCode, it prints the exact manual command, in the form
`cd "<worktree-path>" && CE_WORKSPACE="..." CE_WORKTREE="..." ... opencode`,
which you can copy-paste directly).

### The workflow inside OpenCode

Once OpenCode is launched inside the worktree, these slash commands are
available (in `opencode/commands/` inside the workspace's OpenCode
config, wired up automatically):

| Command | What it does |
|---|---|
| `/workspace` | Shows the current workspace's context in plain language: project, issue, workspace type, worktree/workspace paths, OpenSpec store id, lenses directory. A safe first command in any session. |
| `/explore` | Explores the codebase read-only and drafts an OpenSpec change proposal grounded in what it actually finds — use when you want to investigate before committing to a plan. |
| `/propose` | Creates a new OpenSpec change and generates **all** of its artifacts (proposal, design, tasks) in one step — use when you already know roughly what you want built and want to move straight to planning. |
| `/apply` | Implements the tasks from an OpenSpec change, one at a time, only inside the worktree — marking each task's checkbox as it completes it, and pausing on anything unclear or blocked. |
| `/verify` | Checks the implementation against the change's proposal, design, specs, and tasks — the **conformance baseline**. Runs discovered test/lint/build commands and writes a report into the OpenSpec store. Never fixes code. **Refuses to run in an `Existing PR review` workspace** (there's no OpenSpec-driven implementation to check conformance against) — use `/adversarial-review` there instead. |
| `/adversarial-review` | In an `Implementation` workspace: runs after `/verify` and independently hunts for defects, gaps, and risks the specification itself doesn't describe, challenging `/verify`'s report rather than duplicating it. In an `Existing PR review` workspace: the **only** review step — reviews the commit range directly against the PR description and repository conventions, with no OpenSpec change involved. Never fixes code, either way. |
| `/archive` | Archives a completed change: checks artifact/task completion, offers to sync delta specs into the main specs, and moves the change into the store's archive. |

In an **Implementation** workspace, the typical order is: `/explore` or
`/propose` → `/apply` (repeat as needed) → `/verify` → `/adversarial-review`
→ `/archive`. In an **Existing PR review** workspace, `/adversarial-review`
is the whole workflow — run it directly, no other command is needed or
applicable. None of these commands ever write OpenSpec files, reports, or
harness config inside your actual repository or worktree — only inside
the external OpenSpec store, and (for `/apply`) actual code changes
inside the worktree itself.

### Reasoning lenses

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

### Environment-mutation safety

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

### Skills

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
  `THIRD_PARTY_NOTICES.md` for its provenance and license.

### Environment variables reference

Injected automatically when `ce start` or `ce resume` launches OpenCode —
read by the workflow commands, lenses, and skills, and useful if you ever
need to relaunch manually for debugging (see
[Resuming a session](#resuming-a-session)):

| Variable | Meaning |
|---|---|
| `CE_PROJECT` | The project name, derived from the repository path. |
| `CE_ISSUE` | The issue identifier you passed to `ce start`. |
| `CE_WORKSPACE` | Absolute path to this issue's workspace directory. |
| `CE_WORKTREE` | Absolute path to this issue's Git worktree — where all code changes happen. |
| `CE_OPENSPEC_STORE` | The registered OpenSpec store id for this workspace. Every `openspec` command the workflow runs includes `--store` with this value. |
| `CE_LENSES_DIR` | Absolute path to the canonical, runner-agnostic reasoning-lens directory for this workspace. |
| `OPENCODE_CONFIG_DIR` | Absolute path to this workspace's OpenCode config (`commands/`, `skills/`, `agents/`). |
| `CE_DIFF_BASE` / `CE_DIFF_HEAD` | Only present when `ce start` was given `--base`/`--head`; the resolved commit SHAs of the exact range being reviewed. |

A few more exist purely to override ce-harness's own defaults (mainly
useful for development/testing, not day-to-day use): `CE_HARNESS_HOME`
(defaults to `~/.ce-harness`), `CE_OPENCODE_BIN` / `CE_OPENSPEC_BIN`
(defaults to `opencode` / `openspec` on `PATH`), and `CE_TEMPLATES_ROOT`
(defaults to ce-harness's own bundled `templates/` directory).

### Directory layout reference

```
~/.ce-harness/
  worktrees/<project>/<issue>/       # the Git worktree -- your code changes live here
  workspaces/<project>/<issue>/
    workspace.yml                    # metadata: paths, branch, OpenSpec store id, review range (if any)
    openspec/                        # the external OpenSpec store (proposal, design, specs, tasks, reports, archive)
                                     #   reviews/ -- Existing PR review workspaces only: /adversarial-review's
                                     #   dedicated report location, since there is no change to nest reports under
    lenses/                          # canonical reasoning-lens files
    opencode/
      commands/                     # the /workspace, /explore, /propose, /apply, /verify, /adversarial-review, /archive templates
      skills/                       # openspec-sync-specs, composition-patterns
      agents/                       # OpenCode-specific mirror of the lens files
  state/
    active.yml                      # which single workspace is currently active
```

## Troubleshooting

Work through these in order — most installation problems are one of the
first three.

### `ce --help` fails with "Node.js requires..." or a version error

This is ce-harness's own version check, not a bug — see step 2 above.
Follow the instructions printed in the error message itself (install
Node ≥22.12.0, then open a new terminal and try again).

### `command -v ce` prints nothing, or your shell says `ce: command not found`

This means `ce` was linked, but the directory it was linked into isn't
on your shell's `PATH`. Find out where npm linked it:

```bash
npm config get prefix
```

The `ce` command lives inside a `bin` subdirectory of that path. Confirm
that directory is on your `PATH`:

```bash
echo $PATH
```

If the prefix directory (with `/bin` appended) is not listed, add it —
for example, if you use nvm, this is normally handled automatically, so
this situation most often means you have more than one Node installation
and `npm link` used a different one than your shell's default `node`.
Run `which node` and `npm config get prefix` together, and make sure
they refer to the same Node installation; if not, switch to a single
Node version manager (nvm is recommended) and re-run steps 4, 7, and 8.

### `ce --help` fails with a permission error

If you built with `npm run build` from this repository (step 7), this
should not happen — the build step marks `dist/cli.js` executable
automatically. If you still see a permission error, confirm the file's
permissions directly:

```bash
ls -l dist/cli.js
```

The permissions column should look like `-rwxr-xr-x` (note the `x`
letters). If it does not, re-run `npm run build` and check again before
doing anything else.

### `opencode: command not found` or `openspec: command not found`

One of the two CLIs from steps 5–6 either failed to install or isn't on
your `PATH`. Re-run the relevant install command and watch for errors:

```bash
npm install -g opencode-ai
npm install -g @fission-ai/openspec
```

Then re-run `opencode --version` and `openspec --version`. If the
install command itself reports a permissions error, you likely have npm
configured to install global packages into a system directory your user
account can't write to — using nvm (which owns its own, user-writable
install directory) avoids this entirely.

### `ce start` fails with "The 'openspec' executable is not installed or could not be run"

This means `openspec` (step 6) is not on the `PATH` that `ce` itself
sees when it runs, even if it works when you type `openspec` directly.
Confirm with `command -v openspec` in the same terminal you're running
`ce` from, and reinstall if needed.

### `ce start` fails with "Repository ... has uncommitted or untracked changes"

`ce start` refuses to run against a Git repository that isn't clean, to
avoid mixing your in-progress changes with the isolated worktree it
creates. Commit, stash, or discard your changes in that repository, then
run `ce start` again.

### `ce start` fails with "Neither 'main' nor 'master' branch exists"

`ce start` needs a `main` or `master` branch to create its worktree
from. Create one of those branches in the target repository (or check
out the branch you want under one of those names) and try again.

### `ce start` fails with "A workspace is already active..."

Only one workspace can be active at a time. Run `ce status` to see what
it is. If that's the workspace you meant to keep working in, run
`ce resume` to get back into it — no need to start a new one. If you're
actually done with it, run `ce cleanup` (see
[`ce cleanup`](#ce-cleanup---force)) first, then start the new one.

### `ce start --base ... --head ...` fails to resolve a ref, or reports no shared history

`--base`/`--head` never fetch automatically — both refs must already
exist in your local clone. Run `git fetch` (or pull the branch you need)
in the target repository first, then try again. If it reports the two
refs share no common history at all, double-check you passed the
branches/commits you actually intended to compare.

### `ce review` fails with a `gh`-related error

- **"not installed or could not be run"** — the `gh` CLI isn't on the
  `PATH` `ce` sees. Confirm with `command -v gh`, then install it from
  <https://cli.github.com>.
- **"not authenticated"** — run `gh auth login`, then try again.
- **"Could not resolve pull request #..."** — double-check the PR number
  and that `<repo>`'s `origin` remote actually points at that PR's
  repository; `gh`'s own error message (included in the output) usually
  says exactly what went wrong.
- **"could not be found" after a successful fetch** — rare: the PR was
  updated (e.g. force-pushed) between resolution and fetch. Just run
  `ce review` again.

None of these leave anything behind to clean up — every check above
happens before `ce review` creates any worktree, workspace, or branch.
