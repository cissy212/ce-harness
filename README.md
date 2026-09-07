# ce-harness

**Delegate more of the software development process to AI without giving up visibility or control.**

ce-harness is a personal, local-only command-line tool that runs a coding
agent — [Claude Code](https://claude.com/claude-code) by default — against
a real Git repository through a structured, step-by-step workflow:
explore the problem, confirm the requirement, plan the change, implement
it, verify it, independently review it, and ship it as a pull request.
Each step is its own command, happens in an isolated copy of your
repository, and stops for you at the moments that matter — instead of one
big, unreviewable "just do it" request.

You don't need to be a software engineer to use it. If you can describe
what you want changed, you can run this workflow and follow along in
plain language at every step.

ce-harness's own code is licensed under the [ISC License](LICENSE).
Bundled workflow templates under `templates/` are adapted from other
projects under their own licenses — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Why

- **Nothing is a black box.** Every stage — exploration, plan,
  implementation, verification, independent review — is its own visible
  step you can read, redirect, or stop, instead of a single opaque
  request you either accept or reject wholesale.
- **Your original repository is never touched.** All work happens in an
  isolated copy of it. Nothing is pushed back until you explicitly
  review and confirm it as a pull request.
- **It runs on your machine, under your account.** ce-harness uses your
  own, already-authenticated Claude Code (or OpenCode) session — there's
  no separate API key, and no data goes anywhere ce-harness itself
  controls.
- **The same structured flow covers both directions of the work**:
  building or fixing something, and reviewing someone else's pull
  request.

## Install

You need:

- **git**
- **Node.js 22.12.0 or later** (`node --version` to check)
- **The [Claude Code](https://claude.com/claude-code) CLI, installed and
  logged in** — the default coding-agent runner (or the
  [OpenCode](https://opencode.ai) CLI instead, if you plan to pass
  `--runner opencode`)
- **The [OpenSpec](https://github.com/Fission-AI/OpenSpec) CLI** —
  `npm install -g @fission-ai/openspec`
- Optional: the [`gh` CLI](https://cli.github.com), logged in (`gh auth
  login`) — only needed for `ce review` and `ce publish --confirm`

Then:

```bash
git clone <repository-url> ce-harness
cd ce-harness
npm install
npm run build
npm link
```

`ce --help` should now print usage text. If something didn't work, see
[Troubleshooting](#troubleshooting) below, or the full step-by-step
walkthrough (with exact commands for every prerequisite) in
[docs/installation.md](docs/installation.md).

## How to use it

Two workflows cover almost everything you'll do: building or fixing
something, and reviewing a pull request. Both run inside your target
repository — pass `.` for "this directory" if you're already in it.

**Feature or task**

```bash
ce start . <issue-or-slug>
```

This creates an isolated copy of your repository and opens Claude Code
inside it. From there, work through:

```
/explore              look at the codebase and record what you find
/enrich                confirm the requirement is actually understood
/propose               write the plan: what will change, and why
/apply                 implement it, one task at a time
/verify                check the implementation against the plan
/adversarial-review    independently hunt for anything /verify missed
/archive                mark the change complete
/publish                open it as a pull request, after you confirm
```

**Reviewing a pull request**

```bash
ce review . <pr-number>
```

```
/adversarial-review    independently review the PR's actual diff
```

A few more commands you'll use often: `ce status` shows what's currently
active, `ce resume` gets you back in if the agent's session closes, and
`ce cleanup` removes the isolated copy when you're done. When you want
to browse everything ce-harness has retained across every project —
without remembering an issue number, a project id, or an archived
change's name — run `ce library`: it opens a folder of your projects, by
name, in your editor. Every command and flag is documented in the [CLI
reference](docs/cli-reference.md); what each workflow step actually does
is documented in the [workflow guide](docs/workflow-guide.md).

## Troubleshooting

- **A version/Node error when running `ce`** — install Node ≥22.12.0
  (with nvm: `nvm install 22 && nvm use 22`), then try again.
- **`ce: command not found`** — after `npm link`, the directory it
  linked into isn't on your `PATH`. Run `npm config get prefix` and make
  sure that path's `bin` subdirectory is in `$PATH`.
- **`claude`, `opencode`, or `openspec: command not found`** — that CLI
  isn't installed yet, or isn't on your `PATH`. See [Install](#install)
  above.
- **`ce start` refuses with "has uncommitted or untracked changes"** —
  commit or stash your changes in the target repository first; `ce
  start` never runs against a dirty clone.
- **`ce review` fails with a `gh` error** — install and authenticate the
  `gh` CLI (`gh auth login`), then try again.

Anything else: the full list is in
[docs/troubleshooting.md](docs/troubleshooting.md).

## Documentation

- [docs/installation.md](docs/installation.md) — the complete, step-by-step install walkthrough
- [docs/cli-reference.md](docs/cli-reference.md) — every command and flag, the coding-agent runner choice, the macOS desktop experience, environment variables
- [docs/workflow-guide.md](docs/workflow-guide.md) — what each workflow step does, reasoning lenses, mutation/Docker safety
- [docs/concepts.md](docs/concepts.md) — how ce-harness works internally: worktree isolation, the durable OpenSpec store, Project Identity
- [docs/troubleshooting.md](docs/troubleshooting.md) — the complete troubleshooting list
