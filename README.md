# ce-harness

Personal, local-only developer harness for working on Git repositories.
`ce start` creates an isolated Git worktree plus a workspace directory
under `~/.ce-harness`, provisions this project's durable
[OpenSpec](https://github.com/Fission-AI/OpenSpec) store for it, and
launches a coding-agent runner — [Claude Code](https://claude.com/claude-code)
by default, or [OpenCode](https://opencode.ai) via
`--runner opencode` — inside that worktree. The target repository itself is
never modified with any harness/OpenSpec files — everything ce-harness
creates lives outside of it. The OpenSpec store is *durable*: it lives at
`~/.ce-harness/openspec/<project-id>`, keyed by a stable, ce-harness-minted
**Project Identity** rather than a hash of the repository's current path
(see [Project Identity](#project-identity)), outside every ephemeral
workspace/worktree `ce cleanup` ever deletes, so it survives cleanup and
every later workspace for the same project reuses it — synced main specs
and archived changes included — instead of starting from empty. `ce status`
shows the active OpenSpec change and which of its artifacts exist; `ce open
--change` opens them directly — neither requires knowing this internal path.

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
  - [Choosing a coding-agent runner](#choosing-a-coding-agent-runner)
  - [Desktop experience (macOS + iTerm2)](#desktop-experience-macos--iterm2)
  - [Reviewing a GitHub pull request](#reviewing-a-github-pull-request)
  - [Starting an Implementation workspace from a specific ref](#starting-an-implementation-workspace-from-a-specific-ref)
  - [Reviewing an existing pull request or commit range](#reviewing-an-existing-pull-request-or-commit-range)
  - [Resuming a session](#resuming-a-session)
  - [The workflow inside OpenCode](#the-workflow-inside-opencode)
  - [Reasoning lenses](#reasoning-lenses)
  - [Environment-mutation safety](#environment-mutation-safety)
  - [Docker safety](#docker-safety)
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
  working directory on its own branch (`ce-harness/<issue>` by default —
  see "Configurable branch naming" below), checked out from your
  repository's detected base branch by default (see "Base branch
  detection" below — never hardcoded to `main`). Your original clone is
  never touched: ce-harness refuses to even start if it has uncommitted
  or untracked changes, and all product-code changes happen only inside
  the worktree.
- **Configurable branch naming.** The internal branch `ce start` creates
  defaults to `ce-harness/<issue>`, but different repositories use
  different conventions. Set the `ce-harness.branch-pattern` Git config
  key — locally, for one repository (`git config ce-harness.branch-pattern
  "feature/{issue}"`), or globally, as your own personal default across
  every repository (`git config --global ce-harness.branch-pattern
  "feature/{issue}"`) — to any pattern containing the `{issue}`
  placeholder (e.g. `feature/{issue}`, `bugfix/{issue}`, `review/{issue}`,
  or just `{issue}` with no prefix at all). Git's own local-overrides-
  global resolution applies as usual. No pattern is hardcoded to any one
  repository's convention; the default is simply what an unconfigured
  repository gets.
- **Base branch detection.** `ce start` never assumes `main`. It
  determines the repository's actual base branch, preferring automatic,
  repository-agnostic detection: (1) a live, read-only query of the
  `origin` remote's current default branch (`git ls-remote --symref`,
  which downloads no objects and updates no local refs — this is what
  makes a repository using `develop`, `trunk`, or any other name work
  correctly, with no per-project configuration); (2) if that's
  unavailable (offline, no such remote), the locally-cached remote
  default from a prior clone/fetch; (3) only if there is no remote at
  all (a local-only repository) does it fall back to the `main`/`master`
  convention names, as a last resort. Once a remote names a branch (step
  1 or 2), `ce start` **fetches it fresh from the remote** and always
  seeds the new workspace from `origin/<branch>` — a deliberate, narrow
  exception to "ce-harness never fetches automatically" (every other ref
  a command accepts — `--from`, `--base`/`--head` — must already exist
  locally and is never fetched). This exists specifically so a new
  workspace is always established from the base branch's *current*
  remote state, never a same-named local branch that hasn't been fetched
  in a while and could be silently stale — with no signal anything was
  wrong. If that fetch itself fails (offline, unreachable remote), `ce
  start` fails with an actionable error rather than silently falling
  back to whatever local state happens to exist; use `--from <ref>` to
  work from an existing local ref instead, which stays fully
  offline-capable. The resolved branch name and its exact (freshly
  fetched) commit are recorded in `workspace.yml` and shown by `ce
  status`.
- **Bootstrap detection.** A successful worktree isn't necessarily a
  development-ready one — declared dependencies (`node_modules/`,
  `vendor/`, etc.) are never shared across worktrees, since they're
  untracked. Immediately after creating the worktree, `ce start`
  inspects it (read-only — it never installs anything or runs any
  repository script) for common, repository-agnostic conventions and
  prints exactly what's missing and the command to fix it, before
  OpenCode launches. It always suggests the minimum necessary action,
  never defaulting to a full dependency install: if dependencies are
  genuinely never installed (`package.json`/`composer.json` present, no
  `node_modules/`/`vendor/`), it suggests installing them; but if
  they're already installed and only a declared `"prepare"` script's
  own local side effect never ran (e.g. Husky's Git hooks — detected via
  its own `.husky/` marker, never guessed), it suggests re-running just
  that script instead, since a full reinstall would be needless and can
  rewrite a lockfile. Whenever a suggested command genuinely can't avoid
  a side effect like that, it's named explicitly as a warning right
  next to the command — never left for you to discover afterward.
  Running any of this is always your own explicit decision; `ce status`
  shows the same result (including any warning) again later.
- **Workspace directory.** Alongside the worktree, `ce start` creates a
  workspace directory under `~/.ce-harness/workspaces/<project>/<issue>`.
  This holds everything ce-harness owns for that issue *specifically*: the
  runner's configuration (commands, skills, reasoning lenses) and
  `workspace.yml` metadata. `ce cleanup` deletes this directory entirely —
  which is why the OpenSpec store (below) deliberately does **not** live
  here. Nothing under this directory is ever written inside your
  repository or worktree either.
- **Durable, project-scoped OpenSpec store.** ce-harness uses
  [OpenSpec](https://github.com/Fission-AI/OpenSpec) for spec-driven
  development (proposal → design → tasks → implementation → verification
  → archive). The store lives at `~/.ce-harness/openspec/<project-id>` —
  a sibling of the worktrees/workspaces directories, never nested under
  either — registered globally with OpenSpec under a deterministic id
  (`ce-<project-id>`, no issue in it). `<project-id>` is this project's
  **Project Identity** — see [Project Identity](#project-identity) below
  for what it is and why it's not just a hash of the repository's path.
  This means:
  - It **survives `ce cleanup`**: cleanup only ever deletes paths under
    `worktrees/`/`workspaces/`, so the store is structurally out of reach,
    not just skipped by a conditional check.
  - It is **shared across every workspace for the same project**: a
    second `ce start` for the same repository (any issue, and — thanks to
    Project Identity — even from a different clone or path of the same
    repository) reuses the exact same store — including specs synced by
    `/archive` and any past `/verify`/`/adversarial-review` reports —
    instead of starting from an empty store.
  - It is **never** an `openspec/` folder inside your repository.
  - A workspace created before durable storage existed keeps its old,
    workspace-scoped store (the pre-existing behavior: `ce cleanup`
    unregisters it, and its files are deleted along with the workspace
    directory) until you explicitly move it — see
    [`ce migrate-openspec`](#ce-migrate-openspec) below.
  - Because the store now persists across issues, it can end up holding
    an **in-progress, unarchived change** left behind by a workspace that
    was cleaned up before running `/archive` (nothing is lost — that's
    the point — but it's still sitting there). If a later workspace for
    the same project proposes a change with the same name, this is an
    OpenSpec-level name collision, not something ce-harness mediates.
    OpenSpec's own `/archive` step is confirmed to refuse (rather than
    silently overwrite) a colliding archive-date folder; run `/explore`
    first in a reused workspace if you want to see what's already there
    before proposing a new change.
- **Many preserved workspaces, one default.** Every workspace is fully
  isolated and addressable by its own `<project>/<issue>` (the same
  identity `ce status` displays), independent of any other workspace —
  including another one for the same project. ce-harness additionally
  tracks which *one* is the current **default** for `ce resume`/`ce
  open`/`ce status`/`ce cleanup` when run with no argument. `ce start`
  never refuses because another workspace exists; the new workspace
  simply becomes the default, and the previous one is left completely
  untouched — reach it any time with `ce resume <project>/<issue>`
  (which also switches the default back to it, since resuming means
  "work on this now"; `ce open`/`ce status` with an explicit workspace
  never change the default — they're read-only). `ce cleanup` is never
  required just to switch which workspace you're working on; run `ce
  cleanup <project>/<issue>` when you actually want to remove one — the
  default pointer only changes if the workspace removed was the one it
  pointed at. See [`ce` command reference](#ce-command-reference).
  `/propose` durably associates the OpenSpec change it creates with the
  workspace that created it, so `ce open --change`/`ce status` resolve
  the right change for each workspace automatically even when several
  workspaces for the same project each have their own active change —
  a change created before this association existed just falls back to
  today's "the sole active change, or ask" behavior.
- **Runner-agnostic by design.** ce-harness supports
  [Claude Code](https://claude.com/claude-code) (the default) and
  [OpenCode](https://opencode.ai) via `--runner`, and the
  workflow commands, skills, and reasoning lenses are written to make no
  runner-specific assumptions (e.g. they never hardcode an OpenCode- or
  Claude-specific path) — everything is wired together through plain
  files and environment variables, so a different runner is a new
  adapter, never a change to the workflow itself. See
  [Choosing a coding-agent runner](#choosing-a-coding-agent-runner).

### Project Identity

Every project's durable OpenSpec store is keyed by a **Project
Identity**: a stable, ce-harness-minted id (`<project-id>` above), not a
hash of the repository's current path. `ce start` resolves it
automatically, and you'll only ever see it directly in `ce status`'s
output or a store's `.identity.yml` file.

The reason this exists: a project's local checkout path changes all the
time — a fresh clone lands in a differently-named folder, a repository
gets renamed or moved, a fork is cloned somewhere else entirely. Keying
the durable store to the path (or a hash of it, as ce-harness did before
Project Identity) means every one of those ordinary events would silently
start a brand-new, empty store instead of recognizing the project's
existing one.

Project Identity fixes this by treating the id itself as independent of
the repository — Git signals (the normalized `origin` remote URL, and the
repository's root commit) are only ever **evidence** used to recognize an
id already minted, never something the id is derived from or changes in
response to. On each `ce start`, ce-harness reads those two signals and
compares them against every known project's recorded evidence:

- **Both signals agree with one recorded snapshot** → the existing
  project id is reused automatically.
- **Only one signal agrees** (e.g. the origin URL matches but the root
  commit doesn't, or vice versa) → ce-harness refuses rather than
  guessing, since this could be a coincidence or a genuine repository
  transfer/history rewrite, and attaching the wrong project's history is
  worse than not finding it. The error names the candidate project id;
  confirm it explicitly with `--project-id <id>` if it really is the same
  project, or start a separate identity with `--new-project`.
- **Signals point at more than one known project** → ce-harness refuses
  the same way, listing every conflicting id.
- **Nothing matches** (including a brand-new repository with no prior
  history at all) → a fresh project id is minted.

A repository with no remote configured at all is still recognized
correctly across a rename or a different local path, purely by its root
commit — the origin signal simply contributes no evidence either way in
that case, rather than blocking recognition. A shallow clone can't
provide root-commit evidence at all (see `resolveRootCommit`), so it
relies on the origin URL alone.

This only decides *which durable store belongs to this repository* — it
has nothing to do with picking a scope inside a monorepo, which remains
a separate, unsolved problem.

### Quick start

```bash
ce start /path/to/your/repository 130
# or, with no ticket at all -- any short slug works just as well:
ce start /path/to/your/repository fix-contact-empty-state
```

The second argument is just an identifier for what you're working on —
an issue number or a short slug, whichever you have. Neither is a
special case: both are sanitized into a filesystem- and branch-safe form
the same way, and produce an ordinary Implementation workspace either
way. (Reviewing a PR is a different intent with its own command — see
[Reviewing a GitHub pull request](#reviewing-a-github-pull-request).)

This validates the repository, creates the worktree and workspace,
provisions this project's durable OpenSpec store (reusing it unchanged if
an earlier workspace for this repository already created it), and
launches the configured coding-agent runner inside the worktree with
everything wired up — on macOS with iTerm2, in a two-pane tab it opens
for you automatically; see
[Desktop experience](#desktop-experience-macos--iterm2). Before the
runner launches, it prints a concise summary of what to do next:

```
Workspace ready.

Worktree
~/.ce-harness/worktrees/your-repository/130

Open in VS Code
code ~/.ce-harness/worktrees/your-repository/130

Next suggested step
/explore

Opened iTerm2 tab "your-repository · 130": left = shell, right = Claude Code, both in "~/.ce-harness/worktrees/your-repository/130".
```

(If the repository needs local setup first, a "Bootstrap needed" section
appears between "Open in VS Code" and "Next suggested step" — see
"Bootstrap detection" under [Core concepts](#core-concepts). The
suggested next step is `/adversarial-review` instead, for an Existing PR
review workspace — see
[Reviewing a GitHub pull request](#reviewing-a-github-pull-request). The
final "Opened iTerm2 tab" line only appears on macOS with iTerm2
available — see [Desktop experience](#desktop-experience-macos--iterm2)
for what happens otherwise, including how the tab's title is chosen.)

Opening that worktree in your editor later — after OpenCode has already
launched, or in a second terminal — is a single command too, no need to
copy the path shown above:

```bash
ce open
```

From there, work through the
[workflow inside OpenCode](#the-workflow-inside-opencode): `/explore` or
`/propose` to plan, `/apply` to implement, `/verify` and
`/adversarial-review` to check the work, `/archive` to finish.

When you're done (or want to abandon the attempt):

```bash
ce cleanup
```

This removes the worktree, its branch, and the workspace directory. The
project's durable OpenSpec store is left registered and untouched — it
lives outside the workspace directory entirely, so cleanup structurally
cannot reach it, and the next `ce start` for this repository reuses it.
Use `ce status` any time in between to see what's currently active. If
OpenCode ever exits before you're done
(closed the terminal, crashed, etc.), `ce resume` gets you straight back
into the same workspace — see [Resuming a session](#resuming-a-session).

### `ce` command reference

#### `ce start <repo> <issue>`

Creates the worktree and workspace for `<issue>` against the Git
repository at `<repo>`, provisions this project's durable OpenSpec store
(created on first use, reused unchanged after that), and launches a
coding-agent runner inside the worktree.

- `<repo>` — path to your existing local clone. It must be clean (no
  uncommitted or untracked changes); commit, stash, or discard changes
  first.
- `<issue>` — a short identifier for what you're working on (an issue
  number or a slug like `fix-login-bug`). It's sanitized into a
  filesystem- and branch-safe form internally.
- `--from <ref>` — optional; see
  [Starting an Implementation workspace from a specific ref](#starting-an-implementation-workspace-from-a-specific-ref).
- `--base <ref>` / `--head <ref>` — optional; see
  [Reviewing an existing pull request or commit range](#reviewing-an-existing-pull-request-or-commit-range).
  Mutually exclusive with `--from`.
- `--runner <runner>` — optional; `claude` (default) or `opencode`. See
  [Choosing a coding-agent runner](#choosing-a-coding-agent-runner).
- `--project-id <id>` / `--new-project` — optional, and mutually
  exclusive; only needed when ce-harness refuses to auto-resolve this
  repository's Project Identity on its own. See
  [Project Identity](#project-identity) below.

If the runner fails to launch after everything else succeeds, `ce start`
does **not** roll the workspace back — the workspace is still valid and
active, so just run `ce resume` (see [Resuming a session](#resuming-a-session))
instead of re-running `ce start`.

`ce start` never refuses because another workspace already exists —
including another one for the same project. The new workspace becomes
the default for `ce resume`/`ce open`/`ce status`/`ce cleanup` when run
with no argument; the previous default is left completely untouched, and
`ce start` prints a short note reminding you it's still there and how to
get back to it (`ce resume <project>/<issue>`).

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
- `--runner <runner>` — optional, same as `ce start`.
- Requires the `gh` CLI installed and authenticated (`gh auth status`).
  `ce start` itself has no GitHub dependency at all — only `ce review`
  does.

#### `ce resume [workspace]`

Re-enters a workspace: relaunches whichever runner `ce start` used for
it (see [Choosing a coding-agent runner](#choosing-a-coding-agent-runner))
with exactly the same environment, in the same worktree. Creates
nothing — no new worktree, workspace, OpenSpec store, or CodeGraph index
— and never modifies `workspace.yml`. With no `[workspace]` argument,
re-enters the current default. With `[workspace]` given as
`<project>/<issue>` (e.g. `market-audit-tool/130` — see `ce status` for
the exact identity), re-enters that workspace instead **and makes it the
new default** — explicitly resuming a workspace means "work on this
now." See [Resuming a session](#resuming-a-session).

#### `ce open [workspace]`

Opens a workspace's worktree directly in an editor (VS Code by default —
`code <worktree-path>`), so you never have to remember or copy the path
`ce start`/`ce status` printed. Creates nothing. With no `[workspace]`
argument, opens the current default; with `[workspace]` (as
`<project>/<issue>`), opens that one instead — purely a read, like `ce
status`: it never changes which workspace is the default, even given
explicitly. Override the editor CLI with `CE_EDITOR_BIN` (any
`code`-compatible fork — VSCodium, Cursor's own `cursor` CLI, etc. — works
today with no code change, since they accept the same `<binary> <path>`
invocation).

#### `ce status [workspace]`

Read-only; safe to run any time, including with no default workspace set
(it prints `No active workspace.` and exits). With no `[workspace]`
argument, reports on the current default; with `[workspace]` (as
`<project>/<issue>`), reports on that one instead, without changing the
default. Either way it reports:

- Project, issue, workspace type (`Implementation` or `Existing PR
  review` — derived from whether `--base`/`--head` were used, never a
  separate piece of state), repository path, base branch, internal branch
- The base branch's exact resolved commit, and whether it was
  auto-detected or given explicitly via `--from` (shown for a normal
  Implementation workspace either way — an explicit `--base`/`--head`
  range already shows its exact commits via the next line instead)
- Review base/head/merge-base commits (only shown for an explicit
  `--base`/`--head` range)
- Worktree and workspace paths, creation time
- Whether the worktree/branch still exist on disk, and whether the
  worktree is clean or has changed files
- The OpenCode config directory and whether it exists
- The reasoning-lenses directory and whether it exists
- Whether the repository needs bootstrapping (dependencies installed,
  etc.), and if so, the exact commands to fix it
- **Other workspaces:** every other workspace preserved on disk, as
  `<project>/<issue>`, whenever more than one exists — so one not being
  the default never leaves you wondering whether it's still there
- The OpenSpec store id, root path, whether it's durable (survives `ce
  cleanup`) or a legacy, workspace-scoped store, and its health check
  result
- The active OpenSpec change(s) for this workspace and their artifact
  checklist — narrowed to the change(s) `/propose` associated with this
  specific workspace when more than one exists for the project, falling
  back to every active change in the store for changes created before
  that association existed

#### `ce cleanup [workspace] [--force]`

Removes a workspace's worktree, its Git branch, and the workspace
directory. With no `[workspace]` argument, removes the current default;
with `[workspace]` (as `<project>/<issue>`), removes that one instead.
The default pointer is only ever updated if the workspace just removed
is the one it currently pointed at — cleaning up a non-default workspace
never disturbs the default, and never requires `ce cleanup` at all just
to start or resume working on something else. What happens to the
OpenSpec store depends on its kind:

- **Durable, project-scoped store** (the default since this workspace's
  `ce start`): left registered and untouched. It lives outside the
  workspace directory entirely, so this is structural, not a skipped
  step.
- **Legacy, workspace-scoped store** (a workspace created before durable
  storage existed, or never migrated — see `ce migrate-openspec` below):
  unregistered first, exactly as before this feature existed, and its
  files are deleted along with the workspace directory.

Refuses (without `--force`) if:

- the worktree has tracked or untracked changes (to avoid silently
  discarding work), or
- your current shell directory is inside the worktree being removed (to
  avoid leaving your shell in a directory that no longer exists) — `cd`
  out of it first, or
- the workspace has a legacy store and it can't be unregistered because
  the `openspec` executable isn't available (a durable store never
  triggers this check at all, since cleanup never touches it).

`--force` proceeds through the first and third of these anyway (discards
worktree changes; removes harness-owned files even if unregistering a
legacy store failed). It never bypasses the "your shell is inside the
worktree" check — always `cd` elsewhere first.

#### `ce migrate-openspec`

Explicitly, safely moves the active workspace's OpenSpec store onto the
current, Project-Identity-keyed durable store, so it survives `ce
cleanup` and is recognized again across future clones/renames of this
repository. Never runs automatically — an existing workspace never
changes storage behavior just because the CLI was upgraded underneath
it; you decide when to migrate. Two source shapes are recognized and
both migrate the same way from here on: a legacy, workspace-scoped store
(pre-durable-storage), and a durable store still on the older,
path-hash-keyed shape (`~/.ce-harness/openspec/<project>/<repo-hash>` —
predates Project Identity).

- If the workspace already uses the current scheme, this is a no-op.
- The old store's files are never deleted, moved, or modified — only
  read and copied. After a successful migration, remove the old store
  yourself once you've confirmed the migrated data looks correct (the
  command prints the exact path).
- If this project's durable store already exists and its content
  conflicts with the store being migrated (differing files, or files the
  durable store is missing), it refuses with an itemized description of
  the conflict rather than overwriting or merging — resolve it manually,
  then re-run.
- Idempotent: running it again after a successful migration, or on a
  workspace that already has an identical durable store, is a safe no-op.
- `--project-id <id>` / `--new-project` — optional, and mutually
  exclusive; same meaning as `ce start`'s — see
  [Project Identity](#project-identity).

```bash
ce migrate-openspec
```

#### `ce publish [workspace] [--change <name>]`

The deterministic half of shipping a completed, archived change as a
normal GitHub pull request — see `/publish` (in
[The workflow inside OpenCode](#the-workflow-inside-opencode)) for the
full, agent-driven flow (reading the archived change's artifacts and
real verification evidence to write the PR title/body, showing the full
plan, and requiring explicit confirmation). This CLI command is the
plumbing `/publish` calls; running it directly is mostly useful for
inspecting the plan.

With no `--confirm` (the default): entirely local, plus one `git fetch`
of the base branch — never pushes, never creates a PR. It fetches the
base branch, compares it against the workspace's own internal branch,
and safely merges the base in if it advanced and the merge is clean
(refuses with a clear error on any conflict — it never resolves one
itself). Prints a JSON plan: exact repository (`repoSlug`, derived from
the `origin` remote — GitHub only), base branch, the branch name that
will be exposed to the target repository (never `ce-harness/*` — a
separate, independently configurable pattern from the workspace's own
internal branch, defaulting to `feature/{issue}-{change}` or
`feature/{issue}` — see below), included commits and files, and any
uncommitted changes that will be committed on `--confirm`.

With `--confirm --title <text> --body-file <path> --expected-head <sha>
--expected-fingerprint <hash>`: commits any still-uncommitted changes
(using `--title` as the commit message), pushes the branch, and creates
the pull request — or, if one is already open for that branch, reports
its existing URL instead of creating a duplicate. Both `--expected-head`
(the branch's commit) and `--expected-fingerprint` (a hash covering
HEAD plus every staged/unstaged tracked change and untracked file —
from the plan's `expectedFingerprint`, computed the same way `/verify`/
`/adversarial-review`/`/archive` already fingerprint a worktree) must
still match, checked immediately before anything is committed or
pushed, or this refuses. `--expected-head` alone isn't sufficient: a
file can be added or modified in the worktree *without* the branch's
commit moving at all, which is exactly the gap `--expected-fingerprint`
closes — so the content actually pushed is always exactly what the
approved plan showed, never something that changed in between. **Never
merges the pull request, and never enables auto-merge** — there is no
option or code path that does either.

`--change <name>` attributes the publish to a specific OpenSpec change
instead of letting it auto-resolve the workspace's most recently
archived one (via the same `.ce-workspace.yml` ownership sidecar `ce
status`/`ce open --change` use — see
[Many preserved workspaces, one default](#core-concepts)); publishing
still works with no OpenSpec change involved at all.

Refuses outright for an Existing PR review workspace (there's no
OpenSpec-driven implementation of its own to publish), and requires the
`gh` CLI installed and authenticated.

**Publish-branch naming**: configurable the same way as `ce
start`'s own internal branch pattern, via a separate Git config key —
the workspace's internal `ce-harness/{issue}` branch itself is never
pushed or exposed anywhere:

```bash
git config ce-harness.publish-branch-pattern "release/{issue}"
```

### Choosing a coding-agent runner

```bash
ce start /path/to/your/repository fix-login-bug
# or, explicitly:
ce start /path/to/your/repository fix-login-bug --runner claude
# or the other supported runner:
ce start /path/to/your/repository fix-login-bug --runner opencode
```

`--runner` selects which coding agent `ce start` launches inside the
worktree: `claude` (the default) — using your locally installed,
authenticated [Claude Code](https://claude.com/claude-code) CLI (`claude`)
— never the Anthropic API, and no API key is ever read or required — or
`opencode`. The choice is persisted in the workspace's `workspace.yml`, so
`ce resume` always relaunches the same runner the workspace was started
with, with no need to pass `--runner` again. Workspaces created before
this option existed have no persisted runner and are treated as
`opencode` workspaces, exactly as they always have been — `ce start`'s
own default only changed for brand-new workspaces.

Both runners see the same canonical workflow: `/explore`, `/propose`,
`/apply`, `/verify`, `/adversarial-review`, `/archive`, `/workspace`,
and the `openspec-sync-specs` skill are materialized from the same
`templates/` source for either runner — see
[The workflow inside OpenCode](#the-workflow-inside-opencode) (the
walkthrough uses OpenCode's terminology, but the commands and skills
themselves are identical for Claude Code). The only difference is where
each runner's config is materialized:

- **OpenCode** — an external config directory at
  `<workspace>/opencode/{commands,skills,agents,prompts}`, entirely
  outside the worktree, referenced via `OPENCODE_CONFIG_DIR`.
- **Claude Code** — `<worktree>/.claude/{commands,skills}`. Claude Code
  only discovers project-scoped commands/skills relative to its working
  directory, with no environment-variable override, so this is placed
  inside the isolated, ce-harness-owned worktree instead (never your
  original repository) and each command file/skill directory ce-harness
  actually writes is added individually to Git's local, never-committed
  exclude file — the same treatment `.codegraph/` already gets (see
  [Environment-mutation safety](#environment-mutation-safety)) — so it
  never appears as an untracked change and is removed automatically by
  `ce cleanup`. The check is per command file and per skill directory,
  not once against the whole `.claude/` directory: if the worktree's
  base branch already tracks its own command or skill at one of those
  exact paths, only that one is left exactly as the repository has it
  (with a warning printed naming it) — every other command and skill
  still installs alongside it. `.mcp.json` (CodeGraph's MCP registration
  — see below) has no such internal structure, so it stays a single
  file: if the repository already tracks it, ce-harness never overwrites
  it, and a warning is printed instead.

If CodeGraph is available for the workspace (see
[Reasoning lenses](#reasoning-lenses) and the environment variables
reference below), its MCP server is registered per runner too: OpenCode
via a workspace-owned `opencode.json` (`OPENCODE_CONFIG`), Claude Code
via `<worktree>/.mcp.json` (discovered automatically from the launch
directory, with no environment variable needed).

An unsupported `--runner` value fails immediately, before anything is
created, and lists the supported runner ids.

### Desktop experience (macOS + iTerm2)

On macOS with [iTerm2](https://iterm2.com) installed, `ce start`, `ce
review`, and `ce resume` prepare your whole working environment
automatically: instead of launching the runner in the terminal you typed
the command in, they open a new iTerm2 **tab**, split into two panes —

- **left** — a plain interactive shell, already `cd`'d into the worktree
  with the workspace's environment variables exported. This is where you
  run `ce status`, `ce open`, `ce open --change`, `git status`, `npm`
  commands, or any manual inspection.
- **right** — the configured coding-agent runner, already launched in
  that same worktree. This is where you run `/explore`, `/enrich`,
  `/propose`, `/apply`, `/verify`, `/adversarial-review`, `/archive` as
  appropriate for the workspace.

This never opens a second iTerm2 *window* just because another one is
already open: if any iTerm2 window exists, the new tab is added to the
frontmost one; only when no iTerm2 window exists at all is a new window
created (using its initial tab). An existing tab of yours is never
reused or split — the ce workspace always gets its own, dedicated new
tab. No flag is needed — this is the default (`auto`) behavior whenever
iTerm2 is available. The terminal you ran the command from prints the
usual startup summary, then a one-line confirmation, and is not one of
the two panes.

Both panes are titled with the workspace's identity, e.g. `MAT · 130`
for an Implementation workspace or `MAT · review-pr-452` for a review
one — so the tab reads clearly even with several ce workspaces (or your
own unrelated tabs) open side by side.

To recognize a project's tabs at a glance, give a repository its own tab
color with the `ce-harness.tab-color` Git config key — a name (`red`,
`orange`, `yellow`, `green`, `cyan`, `blue`, `purple`, `violet`,
`magenta`, `pink`, `white`, `black`, `gray`) or a hex value (`#8A2BE2` or
`8A2BE2`, `#RGB` shorthand also accepted):

```bash
git config ce-harness.tab-color "blue"    # e.g. in your market-audit-tool repo
git config ce-harness.tab-color "green"   # e.g. in your Oz repo
git config ce-harness.tab-color "violet"  # e.g. in this repo
```

This never creates or maintains an iTerm2 profile — no profile picker,
nothing to keep in sync — it just colors the new tab directly. With no
color configured, the tab keeps iTerm2's normal appearance. An
unrecognized value is ignored with a warning, never blocking the launch.

Everywhere this can't happen — Linux, macOS without iTerm2, or iTerm2's
Automation permission not yet granted (System Settings → Privacy &
Security → Automation) — `ce` falls back to exactly the single-terminal
behavior it has always had: the runner launches directly in the terminal
you're in, with the worktree path and the exact command to relaunch the
runner later also printed for reference. A workspace is never rolled
back just because presentation failed; terminal layout is convenience,
never correctness.

Configure whether this is attempted at all with the
`ce-harness.terminal-layout` Git config key — the same mechanism as
`ce-harness.branch-pattern` (see "Configurable branch naming" above) —
set to `auto` (the default), `iterm2` (require it; still falls back
gracefully if unavailable), or `none` (always use the single-terminal
behavior):

```bash
git config --global ce-harness.terminal-layout none
```

`CE_TERMINAL_LAYOUT` (same three values) overrides this for a single
invocation.

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

### Starting an Implementation workspace from a specific ref

By default, `ce start` seeds the worktree from the repository's detected
base branch (see "Base branch detection" above). Sometimes that's wrong
for the work at hand — e.g. a feature that depends on another,
already-completed feature branch that hasn't merged to `develop`/`main`
yet. Pass `--from <ref>` to start from that ref instead, while keeping
everything else about a normal Implementation workspace unchanged:

```bash
ce start /path/to/your/repository scv-ai-dev-deployment --from feature/scv-ai-jano-auth
```

- `<ref>` can be a local branch, an `origin/<branch>` remote-tracking
  ref, a tag, or a raw commit — anything `ce-harness` can resolve
  **locally**; it never fetches automatically, and fails with a clear
  error if the ref doesn't already exist locally.
- The workspace is still `workspaceType: Implementation` — `/verify` and
  `/adversarial-review` run their normal OpenSpec-conformance workflow,
  not the Existing-PR-review one. `--from` only changes *where the
  worktree starts*, never *what kind of workspace this is*.
- `--from` is mutually exclusive with `--base`/`--head`: combining them
  is rejected before anything is created. Use `--from` to pick a
  starting point for new work; use `--base`/`--head` to review an
  already-existing, fixed commit range (see below).
- The exact ref you passed and its resolved commit are recorded in
  `workspace.yml` and shown by `ce status` (marked `(explicit, via
  --from)` to distinguish it from the auto-detected case), and `/verify`/
  `/adversarial-review` use it as the base for their diff scope (via
  `CE_BASE_BRANCH`) instead of falling back to the repository's default
  branch.
- The source ref itself is never modified, moved, or fetched — only read
  to resolve its current commit, exactly like `--base`/`--head`.

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

If OpenCode exits (you closed the terminal, it crashed, etc.), the
workspace is still there, exactly as `ce start` left it — get back into
it with:

```bash
ce resume
```

(Re-running `ce start` with the same repo/issue instead now suggests
this exact command, rather than refusing outright — see [Many preserved
workspaces, one default](#core-concepts) above.)

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
| `/publish` | Ships the completed, archived change as a normal GitHub pull request: fetches and safely updates against the current base branch, shows the exact repository/branch/included commits/PR title/PR description, and only pushes and opens the PR after explicit confirmation. Never merges, never enables auto-merge. |

In an **Implementation** workspace, the typical order is: `/explore` or
`/propose` → `/apply` (repeat as needed) → `/verify` → `/adversarial-review`
→ `/archive` → `/publish`. In an **Existing PR review** workspace,
`/adversarial-review` is the whole workflow — run it directly, no other
command is needed or applicable (`/publish` refuses there too, for the
same reason `/verify` does: there's no OpenSpec-driven implementation of
its own to publish). None of these commands ever write OpenSpec files,
reports, or harness config inside your actual repository or worktree —
only inside the external OpenSpec store, and (for `/apply`) actual code
changes inside the worktree itself; `/publish` is the one exception that
also reaches an external service (GitHub), and only after you explicitly
confirm its preview.

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

### Docker safety

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
| `CE_OPENSPEC_STORE` | The registered OpenSpec store id for this workspace -- this project's durable store for any workspace created after durable storage existed, or a legacy workspace-scoped id otherwise. Every `openspec` command the workflow runs includes `--store` with this value. |
| `CE_LENSES_DIR` | Absolute path to the canonical, runner-agnostic reasoning-lens directory for this workspace. |
| `OPENCODE_CONFIG_DIR` | Absolute path to this workspace's OpenCode config (`commands/`, `skills/`, `agents/`). |
| `CE_DIFF_BASE` / `CE_DIFF_HEAD` | Only present when `ce start` was given `--base`/`--head`; the resolved commit SHAs of the exact range being reviewed. |

A few more exist purely to override ce-harness's own defaults (mainly
useful for development/testing, not day-to-day use): `CE_HARNESS_HOME`
(defaults to `~/.ce-harness`), `CE_OPENCODE_BIN` / `CE_OPENSPEC_BIN`
(defaults to `opencode` / `openspec` on `PATH`), and `CE_TEMPLATES_ROOT`
(defaults to ce-harness's own bundled `templates/` directory). Two more
are genuinely useful day to day: `CE_EDITOR_BIN` (defaults to `code` on
`PATH`) overrides which editor CLI `ce open` invokes — set it in your own
shell profile if you use a `code`-compatible fork instead of vanilla VS
Code — and `CE_TERMINAL_LAYOUT` (`auto` / `iterm2` / `none`) overrides
the [desktop experience](#desktop-experience-macos--iterm2) for a single
invocation.

### Directory layout reference

```
~/.ce-harness/
  worktrees/<project>/<issue>/       # the Git worktree -- your code changes live here
  workspaces/<project>/<issue>/      # ephemeral -- deleted whole by `ce cleanup`
    workspace.yml                    # metadata: paths, branch, OpenSpec store id, review range (if any)
    lenses/                          # canonical reasoning-lens files
    opencode/
      commands/                     # the /workspace, /explore, /propose, /apply, /verify, /adversarial-review, /archive templates
      skills/                       # openspec-sync-specs, composition-patterns
      agents/                       # OpenCode-specific mirror of the lens files
  openspec/<project-id>/             # durable -- survives `ce cleanup`, shared by every workspace for this project
                                     #   .identity.yml -- this project's Project Identity record (see below)
                                     #   the OpenSpec store itself (proposal, design, specs, tasks, reports, archive)
                                     #   reviews/ -- Existing PR review workspaces only: /adversarial-review's
                                     #   dedicated report location, since there is no change to nest reports under
  state/
    active.yml                      # which single workspace is currently active
```

A workspace created before durable storage existed still has its OpenSpec
store nested at `workspaces/<project>/<issue>/openspec/` instead -- see
`ce migrate-openspec` above to move it.

If CodeGraph (semantic code navigation) is available and used, its index
lives at `<worktree>/.codegraph/` — never inside the workspace directory
above, and never inside your original repository. You'll never see it as
an untracked directory in `git status`: `ce start` adds it to the
repository's own local, never-committed exclude file
(`<git-common-dir>/info/exclude`) automatically, the same mechanism Git
itself provides for exactly this — no manual `.gitignore` entry needed,
and no tracked file is ever touched.

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

This only happens for a **local-only repository with no remote at all**
(see "Base branch detection" above — every other repository is detected
from its remote, regardless of the branch name it actually uses). Create
a `main` or `master` branch in the target repository (or check out the
branch you want under one of those names), or add a remote with a
default branch, and try again.

### `ce start` fails with "Could not fetch ... to establish the current remote base"

`ce start`'s default (auto-detected) base-branch flow always fetches the
repository's detected default branch (e.g. `origin/develop`) fresh before
seeding the new workspace from it — a new workspace must start from the
remote's *current* state, never a same-named local branch that might not
have been fetched in a while. This error means that fetch itself
failed — typically no network access, or the remote is unreachable.
Either restore connectivity and try again, or, if you intend to work from
an existing local ref instead, use `ce start ... --from <ref>` (never
fetched, works fully offline against whatever already exists locally).

### `ce start` fails with "... reports ... as its default branch, but ... is still not resolvable after fetching it"

Rare: `ce start` fetched the remote's reported default branch
successfully, but it still didn't resolve locally afterward (e.g. a race
where the branch was renamed or deleted on the remote between detection
and fetch). Confirm the branch genuinely exists on the remote, then run
`ce start` again.

### `ce start` fails with "... does not include the '{issue}' placeholder"

Your configured `ce-harness.branch-pattern` (see "Configurable branch
naming" above) doesn't contain `{issue}` — every workspace for this
repository would otherwise render to the exact same branch name. Fix the
pattern (`git config ce-harness.branch-pattern "feature/{issue}"`), or
remove the override entirely (`git config --unset
ce-harness.branch-pattern`) to use the default.

### `ce start` fails with "Worktree/Workspace/Branch already exists..."

You already ran `ce start` for this exact `<repo>`/`<issue>` pair
(possibly not as the current default, if you've since started or
resumed something else — see [Many preserved workspaces, one
default](#core-concepts)). The error itself names the exact command to
run: `ce resume <project>/<issue>` to continue it, or `ce cleanup
<project>/<issue>` (see [`ce cleanup`](#ce-cleanup-workspace---force))
to remove it first if you want a genuinely fresh start. This never
requires cleaning up or disturbing any *other* workspace — starting a
new one for a different issue always just works, with no prerequisite
`ce cleanup` at all.

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

### `ce start` printed "This repository needs local setup before normal use"

This is expected the first time you work on a repository whose
dependencies aren't installed yet in this brand-new worktree (worktrees
never share `node_modules/`, `vendor/`, etc. with each other or with
your original clone). Run the exact command(s) printed — ce-harness
never runs them for you, since they can have side effects — inside the
worktree path shown, then continue as normal. `ce status` shows the
same information again if you need a reminder later.

The suggested command is always the minimum necessary one: if
dependencies are already installed and only a declared `"prepare"`
script's own setup (e.g. Husky's Git hooks) never ran, it suggests
re-running just that script (`npm run prepare`) rather than a full
reinstall. If a `Warning:` line follows the command, that specific
command can't avoid a side effect (most commonly a full install
rewriting a lockfile) — read it before deciding whether to run it.
