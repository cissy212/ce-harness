# ce-harness

Personal, local-only developer harness for working on Git repositories.
`ce start` creates an isolated Git worktree plus a workspace directory
under `~/.ce-harness`, provisions an external [OpenSpec](https://github.com/Fission-AI/OpenSpec)
store for it, and launches [OpenCode](https://opencode.ai) inside that
worktree. The target repository itself is never modified with any
harness/OpenSpec files — everything ce-harness creates lives outside of
it.

This document is a complete, step-by-step installation guide for someone
who has never used ce-harness before. Follow it in order. Every command
below can be copy-pasted as-is (commands containing a placeholder like
`<repository-url>` are called out explicitly).

## Installation

### 1. Prerequisites

You need all four of the following installed before you start:

- **git** — to clone this repository and for ce-harness to manage worktrees.
- **Node.js and npm** — to install and build ce-harness. See the exact
  supported version in the next section.
- **The OpenCode CLI** — the tool ce-harness launches inside each worktree.
- **The OpenSpec CLI** — the tool ce-harness uses to manage specs for each
  change.

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
the `start`, `status`, and `cleanup` commands. If you see a "permission
denied" error or any other error instead of the usage text, see
"Troubleshooting" below.

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
