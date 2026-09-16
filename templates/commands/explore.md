---
description: Explore the codebase and record system/context findings for the current issue
agent: build
---
Explore the current issue and record what you find about the system --
where the change likely lives, what currently exists, what's missing --
in this workspace's external OpenSpec store, for `/enrich` and `/propose`
to build on. This command never modifies the target repository or its Git
worktree, and never writes OpenSpec or runner-specific files inside them.

**This command never drafts the change proposal, design, or task
artifacts.** It answers "where does this live and what's actually there
today", not "what should change" -- that's `/propose`'s job.

## 0. Guard

If the `CE_OPENSPEC_STORE` environment variable is empty or unset, stop
and tell the user to run `ce start` first; there is no store to work
with.

## 1. Gather context

Read the injected environment (`CE_PROJECT`, `CE_ISSUE`, `CE_WORKSPACE`,
`CE_WORKTREE`, `CE_OPENSPEC_STORE`) and the user's stated issue/request.

**Confirm you actually know what the task is before exploring the
repository -- not just its name.** `CE_ISSUE` is often only a bare
slug/identifier (e.g. `case-studies-domain-model`, `fix-142`) -- a slug
names a piece of work, it does not describe what that work should do,
where a relevant prior PR/discussion lives, or what "done" looks like.
You have enough context once the user's own message that invoked
`/explore`, or the conversation so far, actually describes the task:
what should exist or change, a referenced PR/issue with real content
already visible, or specific behavior/files the user pointed at. A bare
slug alone, with nothing else said about it, is not enough.

If you don't have enough: **stop here, before looking at the
repository**, and ask the user directly (the AskUserQuestion tool if
available, otherwise plain chat) for the missing task context -- e.g.
"What should `<issue>` actually do?" or "Is there a related PR, issue,
or doc I should start from (e.g. a linked PR number)?". This never
requires a formal issue tracker or GitHub issue -- a short free-form
description is enough to proceed; guessing from the slug alone, or
performing broad, generic exploration to compensate for not knowing the
task, is not. Do not ask when the task is already reasonably clear from
what's already been said -- only when there is genuinely nothing to go
on beyond a name.

Once you know what the task actually is, look around the worktree at
`$CE_WORKTREE` (recent `git log`, `git status`, relevant source files)
to understand what this repository does and where the issue likely
lives. Do this for any repository -- nothing here should assume a
specific project structure or language.

## 2. Derive a change name

Derive a concise kebab-case change name that summarizes the issue (for
example, from `CE_ISSUE`). If it's ambiguous, propose a name and confirm
it with the user before continuing.

## 3. Check for an existing change

List the changes already in this workspace's store before creating
anything new:

```
openspec list --store "$CE_OPENSPEC_STORE" --json
```

If a change with the same (or an equivalent) name already exists, reuse
it instead of creating a duplicate; skip straight to step 5.

## 4. Create the change only if missing

```
openspec new change "<name>" --store "$CE_OPENSPEC_STORE"
```

This only scaffolds the change directory (`.openspec.yaml`) so this
command has somewhere durable to record its findings -- it does not
create or write `proposal.md`, `design.md`, or `tasks.md`. `/propose`
performs this same create-if-missing step independently and reuses the
same change either way.

## 5. Retrieve OpenSpec context and the change root

```
openspec context --store "$CE_OPENSPEC_STORE"
openspec status --change "<name>" --store "$CE_OPENSPEC_STORE" --json
```

Resolve `changeRoot` from the `status` JSON -- never construct it by
hand. This command does not call `openspec instructions proposal`: it
never writes a schema-tracked artifact, only its own findings file (see
step 8).

## 6. Query the Retrieval Contract

Before exploring the repository yourself, check whether relevant prior
project knowledge already exists -- a past decision, a past finding, a
past spec -- so you don't rediscover from scratch what an earlier change
already established. Build one retrieval query from what's known so far
(the task text from step 1, any domain/capability name already implied,
and any keywords/identifiers already in view):

```bash
ce retrieve --task "<task text>" --paths "<comma-separated paths, if any>" --domain "<domain, if known>" --keywords "<comma-separated terms, if any>"
```

This prints a small ranked JSON list of candidates (never full artifact
bodies) from this project's durable OpenSpec store and Git history,
strictly scoped to this project. Parse it and inspect only materially
relevant candidates, the same discipline `/enrich`'s own Step 5 uses:
open every `"strong"`-confidence candidate in full; open
`"moderate"`-confidence ones too only if there are fewer than 3 strong
ones; never open more than 5 in full regardless of confidence; every
other candidate is referenced by its metadata only, never opened. A
candidate is context for your own exploration below, never a substitute
for it -- it may be outdated, and confirming or updating it against what
you actually find in step 7 is exactly this command's job. If `ce
retrieve` reports a warning (no durable store yet, or Git history
couldn't be read), proceed without that source -- ordinary state for a
new project, not a failure.

## 7. Explore the codebase (read-only)

Read and search the repository/worktree as needed to gather concrete
evidence: what currently exists, what's missing, relevant files/paths,
and any technical facts later stages will need. Use read-only
tools/commands only (read, grep, `git log`, `git show`, etc.). Do not
write, edit, move, or delete anything in the repository or the worktree.
Do not draft what should change or how -- that is out of scope here.

## 8. Write the findings artifact

Write your findings directly to `<changeRoot>/explore.md` (resolve
`changeRoot` from step 5's `status` JSON -- never construct it by hand).
This file is **not** an OpenSpec schema artifact -- it is never created
via `openspec instructions`, never validated by `openspec validate`, and
never tracked by `applyRequires`/artifact-completion status, exactly
like `/verify`'s and `/adversarial-review`'s `reports/` files. If a tool
refuses to write outside the worktree/project root, use the shell (e.g.
a `bash` heredoc) to write the file at that path instead.

Structure:

```markdown
# Exploration: <change-name>

**Date:** YYYY-MM-DD

## Findings

<what currently exists, what's missing, grounded in what you actually
read in step 7>

## Relevant Locations

<key files/paths/modules, and why each is relevant>

## Open Questions

<anything unclear that /enrich or /propose should pick up -- or "None.">
```

Every claim in it must be grounded in what you actually found in step 7
-- do not invent conclusions you don't have code evidence for, and do
not draft proposed changes, designs, or acceptance criteria here.

**Keep it concise and scoped to this issue.** Cite file paths (and line
ranges where useful) instead of pasting large code excerpts; prefer
short bullet points over prose paragraphs; and record only what's
actually relevant to this issue, not a general survey of the
repository. A short, well-scoped `explore.md` is the goal -- a much
longer file for a small issue is a sign the exploration wandered, not
that more detail is better.

## 9. Record provenance

`explore.md`'s findings are only as trustworthy as the worktree state
they were drawn from -- and this durable store outlives any one
workspace, so a much later `/enrich`/`/propose` run (reusing the same
store, potentially long after this one) needs a way to tell whether the
repository has materially changed since this file was written. Record
that state now, the same worktree fingerprint `/verify` and
`/adversarial-review` already compute (never infer the date from memory
-- see below):

```bash
COMMIT=$(git -C "$CE_WORKTREE" rev-parse HEAD)
FINGERPRINT=$({
  git -C "$CE_WORKTREE" rev-parse HEAD
  git -C "$CE_WORKTREE" diff HEAD
  git -C "$CE_WORKTREE" ls-files --others --exclude-standard -z | (cd "$CE_WORKTREE" && xargs -0 cat) 2>/dev/null
} | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-12)
RECORDED_AT=$(date -u +%Y-%m-%d)
printf 'commit: "%s"\nfingerprint: "%s"\nrecordedAt: "%s"\n' "$COMMIT" "$FINGERPRINT" "$RECORDED_AT" \
  > "<changeRoot>/.ce-provenance-explore.yml"
```

This is a small sidecar file (not one of the `artifacts` OpenSpec
tracks, and never part of `applyRequires`) -- never mentioned in this
command's own output. Write/refresh it unconditionally after writing
`explore.md`, even on a re-run.

## 10. Report back

Reply in the conversation (not only in the file) with a concise summary
of:

- **Findings**: what you learned about the current behavior/code.
- **Relevant locations**: the key files/paths involved.
- **Open questions**: anything left unclear for a later stage.

State that `<changeRoot>/explore.md` was written, and that `ce open
--change` opens it (and any other artifacts already on this change) in
an editor -- no internal path needed. Note that `/enrich` (or `/propose`
directly) is the next step.

## Never

- Never perform broad, generic repository exploration to compensate for
  not actually knowing the task -- when `CE_ISSUE` is only a bare slug
  and nothing else has been said about it, stop and ask the user what
  the task actually is (step 1) before reading the repository. Never
  require a formal issue tracker or GitHub issue for this -- a short
  free-form answer is enough. Never ask when the task is already
  reasonably clear from what's already been said.
- Never skip step 9 (recording provenance) -- write/refresh
  `.ce-provenance-explore.yml` every time `explore.md` is written,
  never only on first creation.
- Never draft or write `proposal.md`, `design.md`, `tasks.md`, or any
  other OpenSpec-schema-tracked artifact -- creating and writing those
  is `/propose`'s responsibility, not this command's.
- Never conclude what should change or how -- this command only
  explores; it does not propose or design.
- Never implement the product change itself -- this command does not
  write application/library code.
- Never modify, create, or delete any file inside the target repository
  or its Git worktree, for any reason.
- Never create `openspec/`, `.opencode/`, reports, or any other harness
  or OpenSpec file inside the repository or worktree -- all OpenSpec
  and harness artifacts belong only in the external store at
  `$CE_OPENSPEC_STORE`.
- Never state a finding that isn't backed by something you actually
  read in the codebase or were told by the user.
- Never call `openspec` without `--store "$CE_OPENSPEC_STORE"`.
