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
Look around the worktree at `$CE_WORKTREE` (recent `git log`, `git
status`, relevant source files) to understand what this repository does
and where the issue likely lives. Do this for any repository -- nothing
here should assume a specific project structure or language.

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
step 7).

## 6. Explore the codebase (read-only)

Read and search the repository/worktree as needed to gather concrete
evidence: what currently exists, what's missing, relevant files/paths,
and any technical facts later stages will need. Use read-only
tools/commands only (read, grep, `git log`, `git show`, etc.). Do not
write, edit, move, or delete anything in the repository or the worktree.
Do not draft what should change or how -- that is out of scope here.

## 7. Write the findings artifact

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
read in step 6>

## Relevant Locations

<key files/paths/modules, and why each is relevant>

## Open Questions

<anything unclear that /enrich or /propose should pick up -- or "None.">
```

Every claim in it must be grounded in what you actually found in step 6
-- do not invent conclusions you don't have code evidence for, and do
not draft proposed changes, designs, or acceptance criteria here.

**Keep it concise and scoped to this issue.** Cite file paths (and line
ranges where useful) instead of pasting large code excerpts; prefer
short bullet points over prose paragraphs; and record only what's
actually relevant to this issue, not a general survey of the
repository. A short, well-scoped `explore.md` is the goal -- a much
longer file for a small issue is a sign the exploration wandered, not
that more detail is better.

## 8. Report back

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
