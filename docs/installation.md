# Installation

A complete, step-by-step walkthrough for someone who has never used
ce-harness before. Follow it in order. Every command below can be
copy-pasted as-is (commands containing a placeholder like
`<repository-url>` are called out explicitly). For the short version, see
the [README](../README.md#install).

## 1. Prerequisites

You need all four of the following installed before you start:

- **git** — to clone this repository and for ce-harness to manage worktrees.
- **Node.js and npm** — to install and build ce-harness. See the exact
  supported version in the next section.
- **The [Claude Code](https://claude.com/claude-code) CLI (`claude`), installed
  and authenticated** — the coding-agent runner `ce start`/`ce review`
  launch by default (no `--runner` flag needed; using your own
  authenticated CLI session, never the Anthropic API, and no API key is
  ever read or required). See [Choosing a coding-agent
  runner](cli-reference.md#choosing-a-coding-agent-runner) for what it
  needs to be logged in to, and how to switch to the other supported
  runner instead.
- **The OpenSpec CLI** — the tool ce-harness uses to manage specs for each
  change. Always required, regardless of which coding-agent runner you use.

Optionally:

- **The OpenCode CLI** — only needed if you plan to use `--runner
  opencode` instead of the default. Skip this if you're staying with
  the default Claude Code runner.
- **The [`gh` CLI](https://cli.github.com)**, installed and authenticated
  (`gh auth login`) — needed for `ce review` and for `ce publish
  --confirm` (see the [CLI reference](cli-reference.md)). Every other
  command, including `ce start --base --head` and `ce publish` without
  `--confirm`, has no GitHub dependency at all.

The next sections install each of these one at a time.

## 2. Supported Node version

ce-harness requires **Node.js 22.12.0 or later**. This is not an arbitrary
choice — it's the exact minimum required by ce-harness's own dependencies
(the `commander` package, which ce-harness's command-line parsing depends
on directly, requires Node ≥22.12.0). Running an older Node version will
not work: ce-harness detects this itself and refuses to start with a
clear error message (rather than an unrelated crash) — see
[Troubleshooting](troubleshooting.md) if you hit this.

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

## 3. Get the ce-harness source code

Clone the repository (replace `<repository-url>` with the actual URL you
were given for this repository):

```bash
git clone <repository-url> ce-harness
cd ce-harness
```

Every command from this point on assumes your terminal's current
directory is this `ce-harness` folder.

## 4. Install ce-harness's own dependencies

```bash
npm install
```

This downloads ce-harness's own dependencies (`commander`, `execa`,
`yaml`, `zod`) into a local `node_modules` folder. It does not install
Claude Code, OpenSpec, or OpenCode — those are separate tools, installed
in the next steps.

## 5. Install the Claude Code CLI

This is the coding-agent runner `ce start`/`ce review` launch by default,
so install and log in to it now unless you already have. Follow the
installation instructions at [claude.com/claude-code](https://claude.com/claude-code)
for your platform, then authenticate:

```bash
claude
```

Follow its own login flow if prompted. Once authenticated, confirm it's
on your `PATH`:

```bash
claude --version
```

This should print a version number with no errors. If it prints "command
not found" instead, see [Troubleshooting](troubleshooting.md). (If you
plan to use `--runner opencode` instead and never the default, you can
skip this step and install the OpenCode CLI in step 7 instead — see
[Choosing a coding-agent runner](cli-reference.md#choosing-a-coding-agent-runner).)

## 6. Install the OpenSpec CLI

```bash
npm install -g @fission-ai/openspec
```

Confirm it installed correctly and check its version:

```bash
openspec --version
```

This should print a version number (for example `1.6.0`) with no
errors. If it prints "command not found" instead, see
[Troubleshooting](troubleshooting.md).

## 7. (Optional) Install the OpenCode CLI

Only needed if you plan to use `--runner opencode` instead of the
default Claude Code runner — skip this step otherwise.

```bash
npm install -g opencode-ai
```

Confirm it installed correctly and check its version:

```bash
opencode --version
```

This should print a version number (for example `1.18.13`) with no
errors. If it prints "command not found" instead, see
[Troubleshooting](troubleshooting.md).

## 8. Build ce-harness

```bash
npm run build
```

This compiles ce-harness's TypeScript source into a runnable
`dist/cli.js`, and marks that file as executable automatically — you do
not need to run `chmod` or any other permission command yourself. The
command should finish with no error output.

## 9. Link the `ce` command globally

```bash
npm link
```

This makes the `ce` command available everywhere on your system,
pointing at the `dist/cli.js` you just built. `npm link` may print
information about the packages it audited — that is normal.

**If you already have ce-harness linked from a different checkout on
this machine** (e.g. an older clone, or a separate clone you're
evaluating side by side with this one), this `npm link` **repoints the
global `ce` command to this checkout instead** — it does not create a
second, independent `ce`. Only one checkout can be the one `ce` resolves
to at a time; whichever one you last ran `npm link` in wins. This is
ordinary `npm link` behavior, not specific to ce-harness.

## 10. Verify the installation

Confirm your shell can find the `ce` command:

```bash
command -v ce
```

This should print a file path (for example
`/usr/local/bin/ce` or a path inside your nvm installation directory)
with no error. If it prints nothing at all, see
[Troubleshooting](troubleshooting.md).

Then confirm the command actually runs:

```bash
ce --help
```

This should print ce-harness's usage text, including a description of
the `start`, `resume`, `status`, and `cleanup` commands. If you see a
"permission denied" error or any other error instead of the usage text,
see [Troubleshooting](troubleshooting.md).

## 11. First `ce` command to run

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

**If you've used ce-harness before on this machine — from any checkout,
not just this one — `ce status` may instead immediately show an existing
active workspace, or `ce cleanup --force`/`ce migrate-openspec` may see
projects you don't recognize from this specific clone.** This is
expected, not a sign anything went wrong: `~/.ce-harness` (worktrees,
workspaces, the durable OpenSpec store, and which workspace is active)
is persistent state shared by every ce-harness checkout/installation on
this machine, not something scoped to whichever checkout happens to be
linked as `ce` right now. Linking a new or different checkout with `npm
link` changes which copy of the `ce` code runs; it does not reset or
isolate `~/.ce-harness`. A genuinely clean, from-scratch state would mean
also removing `~/.ce-harness` itself, which is never done automatically.

When you're ready to use ce-harness for real, see the [README](../README.md#how-to-use-it)
for the two everyday workflows.
