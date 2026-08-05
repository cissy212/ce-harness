---
description: Explore the codebase and draft an OpenSpec change proposal for the current issue
agent: build
---
Explore the current issue and draft an OpenSpec change proposal in this
workspace's external OpenSpec store. This command never modifies the
target repository or its Git worktree, and never writes OpenSpec or
runner-specific files inside them.

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

## 5. Retrieve OpenSpec context and proposal instructions

Both from the same store:

```
openspec context --store "$CE_OPENSPEC_STORE"
openspec instructions proposal --change "<name>" --store "$CE_OPENSPEC_STORE"
```

The `instructions` output tells you the exact file path to write the
proposal artifact to (inside the external store) and the template to
follow.

## 6. Explore the codebase (read-only)

Read and search the repository/worktree as needed to gather concrete
evidence for the proposal: what currently exists, what's missing, what
would need to change and why. Use read-only tools/commands only
(read, grep, `git log`, `git show`, etc.). Do not write, edit, move, or
delete anything in the repository or the worktree.

## 7. Write the proposal artifact

Write the proposal document to the exact path reported in step 5,
inside the external OpenSpec store only, following the retrieved
template. Every claim in it must be grounded in what you actually found
in step 6 -- do not invent conclusions you don't have code evidence for.
If a tool refuses to write outside the worktree/project root, use the
shell (e.g. a `bash` heredoc) to write the file at that path instead.

## 8. Validate

```
openspec validate "<name>" --store "$CE_OPENSPEC_STORE"
```

If validation fails, fix the proposal (still only inside the store) and
re-validate until it passes.

## 9. Report back

Reply in the conversation (not in a file) with a concise summary of:

- **Findings**: what you learned about the current behavior/code.
- **Decisions**: what the proposal concludes should change, and why.
- **Risks**: anything that could go wrong or needs care.
- **Open questions**: anything left for the user to confirm.

## Never

- Never implement the product change itself -- this command only
  explores and proposes; it does not write application/library code.
- Never modify, create, or delete any file inside the target repository
  or its Git worktree, for any reason.
- Never create `openspec/`, `.opencode/`, reports, or any other harness
  or OpenSpec file inside the repository or worktree -- all OpenSpec
  artifacts belong only in the external store at `$CE_OPENSPEC_STORE`.
- Never state a finding, decision, or risk that isn't backed by
  something you actually read in the codebase or were told by the user.
- Never call `openspec` without `--store "$CE_OPENSPEC_STORE"`.
