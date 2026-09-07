# CLI reference

Every `ce` command and flag, plus the coding-agent runner choice, the
macOS desktop experience, and the environment variables ce-harness
injects. See the [README](../README.md) for the two everyday workflows;
this is the complete reference for everything else.

## `ce start <repo> <issue>`

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
- `--from <ref>` — optional; see [Starting from a specific ref](#starting-an-implementation-workspace-from-a-specific-ref) below.
- `--base <ref>` / `--head <ref>` — optional; see
  [Reviewing an existing pull request or commit range](#reviewing-an-existing-pull-request-or-commit-range)
  below. Mutually exclusive with `--from`.
- `--runner <runner>` — optional; `claude` (default) or `opencode`. See
  [Choosing a coding-agent runner](#choosing-a-coding-agent-runner).
- `--project-id <id>` / `--new-project` — optional, and mutually
  exclusive; only needed when ce-harness refuses to auto-resolve this
  repository's Project Identity on its own. See
  [Project Identity](concepts.md#project-identity).

If the runner fails to launch after everything else succeeds, `ce start`
does **not** roll the workspace back — the workspace is still valid and
active, so just run `ce resume` (see [`ce resume`](#ce-resume-workspace)
below) instead of re-running `ce start`.

`ce start` never refuses because another workspace already exists —
including another one for the same project. The new workspace becomes
the default for `ce resume`/`ce open`/`ce status`/`ce cleanup` when run
with no argument; the previous default is left completely untouched, and
`ce start` prints a short note reminding you it's still there and how to
get back to it (`ce resume <project>/<issue>`).

### Starting an Implementation workspace from a specific ref

By default, `ce start` seeds the worktree from the repository's detected
base branch (see [Base branch detection](concepts.md#core-concepts)).
Sometimes that's wrong for the work at hand — e.g. a feature that depends
on another, already-completed feature branch that hasn't merged to
`develop`/`main` yet. Pass `--from <ref>` to start from that ref instead,
while keeping everything else about a normal Implementation workspace
unchanged:

```bash
ce start /path/to/your/repository add-billing-export --from feature/billing-export-prep
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
verdict rules — is identical to the Implementation-workspace flow. See
the full [workflow guide](workflow-guide.md).

## `ce review <repo> <pr-number>`

The convenient way to review a GitHub pull request when all you know is
the local repository path and the PR number:

```bash
ce review /path/to/repo 119

# the runner opens (Claude Code by default)
/adversarial-review

# if it closes
ce resume

# when finished
ce cleanup
```

Resolves the PR's exact base/head commits via the `gh` CLI (installed
and authenticated — see [Prerequisites](installation.md#1-prerequisites)),
fetches only what's needed to make those exact commits available locally
(it never switches your current branch, never touches your working tree,
and never assumes the PR's head branch exists on `origin` — same-repo and
fork PRs both work), and starts the same Existing PR review workspace
`ce start --base --head` would (see above), with the issue identifier
defaulted to `review-pr-<number>` so you never have to name it yourself.
Before the runner launches, it prints a concise summary:

```
GitHub PR #119
Dashboard api wiring contacts

Base: main      9392fe9
Head: dashboard-api-wiring-contacts  8fb7148

Workspace type: Existing PR review
```

- `<repo>` — path to your existing local clone (same requirement as
  `ce start`).
- `<pr-number>` — the PR's number, as a positive integer.
- `--runner <runner>` — optional, same as `ce start`.
- Requires the `gh` CLI installed and authenticated (`gh auth status`).
  `ce start` itself has no GitHub dependency at all — only `ce review`
  does.

If `gh` is missing, unauthenticated, or can't resolve the PR, `ce review`
fails with an actionable error before creating anything persistent —
exactly like every other `ce start`-family pre-flight check, so there's
nothing to clean up afterward.

`ce review` is the convenient, GitHub-specific path. For any other exact
commit range — not from GitHub, or already fetched by some other means —
use `ce start --base --head` directly instead.

## `ce resume [workspace]`

Re-enters a workspace: relaunches whichever runner `ce start` used for
it (see [Choosing a coding-agent runner](#choosing-a-coding-agent-runner))
with exactly the same environment, in the same worktree. Creates
nothing — no new worktree, workspace, OpenSpec store, or CodeGraph index
— and never modifies `workspace.yml`. With no `[workspace]` argument,
re-enters the current default. With `[workspace]` given as
`<project>/<issue>` (e.g. `my-project/130` — see `ce status` for the
exact identity), re-enters that workspace instead **and makes it the new
default** — explicitly resuming a workspace means "work on this now."

Use this any time the runner exits (you closed the terminal, it crashed,
etc.) — the workspace is still there, exactly as `ce start` left it.
Re-running `ce start` with the same repo/issue instead now suggests this
exact command, rather than refusing outright — see [Many preserved
workspaces, one default](concepts.md#core-concepts).

If there's no active workspace, or the recorded worktree/workspace is
missing or its metadata doesn't check out, `ce resume` explains exactly
what's wrong and points you at `ce cleanup --force` rather than guessing
or repairing anything silently.

Reconstructing the launch command by hand is no longer the normal path —
keep it only as a fallback for debugging (e.g. if `ce resume` itself
can't launch the runner, it prints the exact manual command, in the form
`cd "<worktree-path>" && CE_WORKSPACE="..." CE_WORKTREE="..." ... claude`
(or `... opencode` for an OpenCode workspace), which you can copy-paste
directly).

## `ce open [workspace]`

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

`ce open --path <path>` opens one exact file or directory inside this
workspace's OpenSpec store directly — e.g. the exact report `/verify` or
`/adversarial-review` just wrote — without needing to know or navigate
the store's internal path yourself. `<path>` must resolve inside the
workspace's trusted OpenSpec store root; anything else is rejected.
Mutually exclusive with `--change`, which opens a whole change's artifact
directory by name instead of one exact path. `/adversarial-review`
prints a ready-to-run `ce open --path "<report path>"` command as part of
its own final report-back output for exactly this reason — a bare
filesystem path into the external store isn't itself an actionable
handoff (it isn't inside the worktree, isn't a URL, and doesn't
Cmd/Ctrl-click open from a terminal).

## `ce status [workspace]`

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
- **Provenance**, for whichever planning artifacts exist (`explore.md`,
  `enrich.md`, and `/propose`'s `proposal.md`/`design.md`/`tasks.md`
  together) — `fresh` if the worktree hasn't materially changed since
  that stage last ran; `stale` (with the date it was recorded) or
  `unknown` (no provenance recorded — a legacy artifact from before this
  mechanism existed) otherwise, either way naming the command to rerun.
  `ce status` itself is purely informational, but `/enrich`, `/propose`,
  and `/apply` each **gate** on this before trusting a dependency they
  read: the durable store outlives any one workspace, so a much later
  run reusing it could otherwise silently implement against a plan
  written against a codebase snapshot that no longer resembles the
  current one. `/explore`, `/enrich`, and `/propose` each record their
  own worktree fingerprint when they run (the same mechanism
  `/verify`/`/adversarial-review`/`/archive` already use); the template
  that would read a dependency checks it *before* reading it, and stops
  — never merely warns — if it's stale or has no recorded provenance at
  all, directing the user to rerun the invalid stage (and, for
  `/propose`, whichever earlier stage is invalid first). A legacy
  artifact with no sidecar is never treated as fresh.

## `ce cleanup [workspace] [--force]`

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

## `ce migrate-openspec`

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
  [Project Identity](concepts.md#project-identity).

```bash
ce migrate-openspec
```

## `ce publish [workspace] [--change <name>]`

The deterministic half of shipping a completed, archived change as a
normal GitHub pull request — see `/publish` (in the
[workflow guide](workflow-guide.md#the-canonical-workflow-commands)) for
the full, agent-driven flow (reading the archived change's artifacts and
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
[Many preserved workspaces, one default](concepts.md#core-concepts));
publishing still works with no OpenSpec change involved at all.

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

## Choosing a coding-agent runner

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

Both runners see the same canonical workflow: `/explore`, `/enrich`,
`/propose`, `/apply`, `/verify`, `/adversarial-review`, `/archive`,
`/publish`, `/workspace`, and the `openspec-sync-specs` skill are
materialized from the same `templates/` source for either runner — see
the [workflow guide](workflow-guide.md) (it uses OpenCode's terminology,
but the commands and skills themselves are identical for Claude Code).
The only difference is where each runner's config is materialized:

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
  [Environment-mutation safety](workflow-guide.md#environment-mutation-safety))
  — so it never appears as an untracked change and is removed
  automatically by `ce cleanup`. The check is per command file and per
  skill directory, not once against the whole `.claude/` directory: if
  the worktree's base branch already tracks its own command or skill at
  one of those exact paths, only that one is left exactly as the
  repository has it (with a warning printed naming it) — every other
  command and skill still installs alongside it. `.mcp.json` (CodeGraph's
  MCP registration — see below) has no such internal structure, so it
  stays a single file: if the repository already tracks it, ce-harness
  never overwrites it, and a warning is printed instead.

If CodeGraph is available for the workspace (see [Reasoning
lenses](workflow-guide.md#reasoning-lenses) and the [environment
variables reference](#environment-variables-reference) below), its MCP
server is registered per runner too: OpenCode via a workspace-owned
`opencode.json` (`OPENCODE_CONFIG`), Claude Code via
`<worktree>/.mcp.json` (discovered automatically from the launch
directory, with no environment variable needed).

An unsupported `--runner` value fails immediately, before anything is
created, and lists the supported runner ids.

## Desktop experience (macOS + iTerm2)

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

Both panes are titled with the workspace's identity, e.g. `my-project ·
130` for an Implementation workspace or `my-project · review-pr-452` for
a review one — so the tab reads clearly even with several ce workspaces
(or your own unrelated tabs) open side by side.

To recognize a project's tabs at a glance, give a repository its own tab
color with the `ce-harness.tab-color` Git config key — a name (`red`,
`orange`, `yellow`, `green`, `cyan`, `blue`, `purple`, `violet`,
`magenta`, `pink`, `white`, `black`, `gray`) or a hex value (`#8A2BE2` or
`8A2BE2`, `#RGB` shorthand also accepted):

```bash
git config ce-harness.tab-color "blue"
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
`ce-harness.branch-pattern` (see [Configurable branch
naming](concepts.md#core-concepts)) — set to `auto` (the default),
`iterm2` (require it; still falls back gracefully if unavailable), or
`none` (always use the single-terminal behavior):

```bash
git config --global ce-harness.terminal-layout none
```

`CE_TERMINAL_LAYOUT` (same three values) overrides this for a single
invocation.

## Environment variables reference

Injected automatically when `ce start` or `ce resume` launches the
coding-agent runner (Claude Code or OpenCode) — read by the workflow
commands, lenses, and skills, and useful if you ever need to relaunch
manually for debugging (see [`ce resume`](#ce-resume-workspace) above):

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
(defaults to `~/.ce-harness`), `CE_CLAUDE_BIN` / `CE_OPENCODE_BIN` /
`CE_OPENSPEC_BIN` / `CE_GH_BIN` / `CE_DOCKER_BIN` / `CE_OSASCRIPT_BIN` /
`CE_CODEGRAPH_BIN` (default to `claude` / `opencode` / `openspec` / `gh` /
`docker` / `osascript` / `codegraph` on `PATH`, respectively), and
`CE_TEMPLATES_ROOT` (defaults to ce-harness's own bundled `templates/`
directory). Two more are genuinely useful day to day: `CE_EDITOR_BIN`
(defaults to `code` on `PATH`) overrides which editor CLI `ce open`
invokes — set it in your own shell profile if you use a
`code`-compatible fork instead of vanilla VS Code — and
`CE_TERMINAL_LAYOUT` (`auto` / `iterm2` / `none`) overrides the [desktop
experience](#desktop-experience-macos--iterm2) for a single invocation.
