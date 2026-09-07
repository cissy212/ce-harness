# Troubleshooting

The complete troubleshooting list. See the [README](../README.md#troubleshooting)
for the short version covering the most common first-use failures. Step
numbers below refer to [Installation](installation.md).

Work through these in order — most installation problems are one of the
first three.

## `ce --help` fails with "Node.js requires..." or a version error

This is ce-harness's own version check, not a bug — see step 2 of
[Installation](installation.md). Follow the instructions printed in the
error message itself (install Node ≥22.12.0, then open a new terminal
and try again).

## `command -v ce` prints nothing, or your shell says `ce: command not found`

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
Node version manager (nvm is recommended) and re-run steps 4, 8, and 9
of [Installation](installation.md).

## `ce --help` fails with a permission error

If you built with `npm run build` from this repository (step 8), this
should not happen — the build step marks `dist/cli.js` executable
automatically. If you still see a permission error, confirm the file's
permissions directly:

```bash
ls -l dist/cli.js
```

The permissions column should look like `-rwxr-xr-x` (note the `x`
letters). If it does not, re-run `npm run build` and check again before
doing anything else.

## `claude: command not found`

The Claude Code CLI (step 5) either failed to install or isn't on your
`PATH`. Follow the installation instructions at
[claude.com/claude-code](https://claude.com/claude-code) again and watch
for errors, then re-run `claude --version`. If you're deliberately using
`--runner opencode` and never the default, you don't need `claude`
installed at all — see [Choosing a coding-agent
runner](cli-reference.md#choosing-a-coding-agent-runner).

## `opencode: command not found` or `openspec: command not found`

One of these two CLIs either failed to install or isn't on your `PATH`.
Re-run the relevant install command and watch for errors:

```bash
npm install -g opencode-ai
npm install -g @fission-ai/openspec
```

Then re-run `opencode --version` and `openspec --version`. If the
install command itself reports a permissions error, you likely have npm
configured to install global packages into a system directory your user
account can't write to — using nvm (which owns its own, user-writable
install directory) avoids this entirely. (`opencode` is only needed at
all if you use `--runner opencode` — see step 7 of
[Installation](installation.md).)

## `ce start` fails with "The 'openspec' executable is not installed or could not be run"

This means `openspec` (step 6) is not on the `PATH` that `ce` itself
sees when it runs, even if it works when you type `openspec` directly.
Confirm with `command -v openspec` in the same terminal you're running
`ce` from, and reinstall if needed.

## `ce start`/`ce review` fails to launch Claude Code, or the right-hand iTerm2 pane shows "command not found: claude"

This means the `claude` CLI (step 5) isn't installed, isn't authenticated,
or isn't on the `PATH` `ce` itself sees. Outside of macOS+iTerm2, `ce
start` reports this itself as "Failed to launch Claude Code: ...". On
macOS with iTerm2, the two-pane tab still opens (the left shell pane is
unaffected) and `ce start` prints its normal success output regardless —
check the right pane directly, since a shell command failing there isn't
something `ce start` can observe. Either way, confirm with `command -v
claude` and `claude --version` in the same terminal you're running `ce`
from, then re-run `ce resume`. If you'd rather not install Claude Code
at all, use `--runner opencode` instead (see [Choosing a coding-agent
runner](cli-reference.md#choosing-a-coding-agent-runner)).

## `ce start` fails with "Repository ... has uncommitted or untracked changes"

`ce start` refuses to run against a Git repository that isn't clean, to
avoid mixing your in-progress changes with the isolated worktree it
creates. Commit, stash, or discard your changes in that repository, then
run `ce start` again.

## `ce start` fails with "Neither 'main' nor 'master' branch exists"

This only happens for a **local-only repository with no remote at all**
(see [Base branch detection](concepts.md#core-concepts) — every other
repository is detected from its remote, regardless of the branch name it
actually uses). Create a `main` or `master` branch in the target
repository (or check out the branch you want under one of those names),
or add a remote with a default branch, and try again.

## `ce start` fails with "Could not fetch ... to establish the current remote base"

`ce start`'s default (auto-detected) base-branch flow always fetches the
repository's detected default branch (e.g. `origin/develop`) fresh before
seeding the new workspace from it — a new workspace must start from the
remote's *current* state, never a same-named local branch that might not
have been fetched in a while. This error means that fetch itself
failed — typically no network access, or the remote is unreachable.
Either restore connectivity and try again, or, if you intend to work from
an existing local ref instead, use `ce start ... --from <ref>` (never
fetched, works fully offline against whatever already exists locally).

## `ce start` fails with "... reports ... as its default branch, but ... is still not resolvable after fetching it"

Rare: `ce start` fetched the remote's reported default branch
successfully, but it still didn't resolve locally afterward (e.g. a race
where the branch was renamed or deleted on the remote between detection
and fetch). Confirm the branch genuinely exists on the remote, then run
`ce start` again.

## `ce start` fails with "... does not include the '{issue}' placeholder"

Your configured `ce-harness.branch-pattern` (see [Configurable branch
naming](concepts.md#core-concepts)) doesn't contain `{issue}` — every
workspace for this repository would otherwise render to the exact same
branch name. Fix the pattern (`git config ce-harness.branch-pattern
"feature/{issue}"`), or remove the override entirely (`git config
--unset ce-harness.branch-pattern`) to use the default.

## `ce start` fails with "Worktree/Workspace/Branch already exists..."

You already ran `ce start` for this exact `<repo>`/`<issue>` pair
(possibly not as the current default, if you've since started or
resumed something else — see [Many preserved workspaces, one
default](concepts.md#core-concepts)). The error itself names the exact
command to run: `ce resume <project>/<issue>` to continue it, or `ce
cleanup <project>/<issue>` (see [`ce
cleanup`](cli-reference.md#ce-cleanup-workspace---force)) to remove it
first if you want a genuinely fresh start. This never requires cleaning
up or disturbing any *other* workspace — starting a new one for a
different issue always just works, with no prerequisite `ce cleanup` at
all.

## `ce start --base ... --head ...` fails to resolve a ref, or reports no shared history

`--base`/`--head` never fetch automatically — both refs must already
exist in your local clone. Run `git fetch` (or pull the branch you need)
in the target repository first, then try again. If it reports the two
refs share no common history at all, double-check you passed the
branches/commits you actually intended to compare.

## `ce review` fails with a `gh`-related error

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

## `ce start` printed "This repository needs local setup before normal use"

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
