# Concepts

How ce-harness works internally — worktree isolation, the durable OpenSpec
store, Project Identity, and the on-disk layout. None of this is required
reading to use ce-harness day to day; see the [README](../README.md) for
that. This is for when you want to understand what's actually happening
under a command, or you're debugging something unexpected.

## Core concepts

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
  prints exactly what's missing and the command to fix it, before the
  coding-agent runner launches. It always suggests the minimum necessary
  action, never defaulting to a full dependency install: if dependencies
  are genuinely never installed (`package.json`/`composer.json` present,
  no `node_modules/`/`vendor/`), it suggests installing them; but if
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
    [`ce migrate-openspec`](cli-reference.md#ce-migrate-openspec) in the
    CLI reference.
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
  pointed at. See the [CLI reference](cli-reference.md).
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
  adapter, never a change to the workflow itself. See [Choosing a
  coding-agent runner](cli-reference.md#choosing-a-coding-agent-runner)
  in the CLI reference.

## Project Identity

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

## Directory layout reference

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
                                     #   .identity.yml -- this project's Project Identity record (see above)
                                     #   the OpenSpec store itself (proposal, design, specs, tasks, reports, archive)
                                     #   reviews/ -- Existing PR review workspaces only: /adversarial-review's
                                     #   dedicated report location, since there is no change to nest reports under
  state/
    active.yml                      # which single workspace is currently active
  library/<project-label>/           # entirely derived -- see below; rebuilt fresh by `ce library` every run
    changes -> openspec/<project-id>/openspec/changes    # symlink
    archive -> openspec/<project-id>/openspec/changes/archive  # symlink
    specs   -> openspec/<project-id>/openspec/specs      # symlink
    reviews -> openspec/<project-id>/reviews             # symlink
```

A workspace created before durable storage existed still has its OpenSpec
store nested at `workspaces/<project>/<issue>/openspec/` instead — see
[`ce migrate-openspec`](cli-reference.md#ce-migrate-openspec) to move it.

`library/` is not a fourth kind of durable storage — it holds no data of
its own at all, only directories of symlinks into `openspec/<project-id>/`
above, organized by each project's current recognizable label instead of
its opaque id. [`ce library`](cli-reference.md#ce-library) wipes and
regenerates the whole thing on every run, which is what makes it safe to
delete at any time and impossible for it to go stale: the durable stores
under `openspec/` remain the only authority, this is purely a human
navigation projection over them.

If CodeGraph (semantic code navigation) is available and used, its index
lives at `<worktree>/.codegraph/` — never inside the workspace directory
above, and never inside your original repository. You'll never see it as
an untracked directory in `git status`: `ce start` adds it to the
repository's own local, never-committed exclude file
(`<git-common-dir>/info/exclude`) automatically, the same mechanism Git
itself provides for exactly this — no manual `.gitignore` entry needed,
and no tracked file is ever touched.
