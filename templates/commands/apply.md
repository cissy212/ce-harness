---
description: Implement tasks from an OpenSpec change (Experimental)
---

Implement tasks from an OpenSpec change.

**Store:** This command always operates on this workspace's external OpenSpec
store. If `CE_OPENSPEC_STORE` is empty or unset, stop and tell the user to run
`ce start` first -- there is no store to work with. Every `openspec` command
below includes `--store "$CE_OPENSPEC_STORE"`.

**Input**: Optionally specify a change name (e.g., `/apply add-auth`). If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **Select the change**

   - If a name is provided, use it and skip straight to step 2.
   - Otherwise, **prefer this exact workspace's own already-associated
     active change over any project-wide discovery** -- never re-ask
     or re-select something the harness already knows:
     ```bash
     ce status "$CE_PROJECT/$CE_ISSUE"
     ```
     Read its `Active change:` line(s) -- narrowed to the change(s)
     durably associated with *this exact workspace* (via its
     `.ce-workspace.yml` ownership sidecar), never a change belonging
     to a different preserved workspace even when the project has
     several active at once (e.g. multiple workspaces for the same
     project, each with its own change).
     - **Exactly one line, with a real name** -- use it automatically.
       Do not ask the user anything.
     - **More than one line** (rare -- this workspace has several of
       its own active changes) -- list them and use the
       **AskUserQuestion tool** to let the user pick, rather than
       guessing.
     - **`Active change:    (none)`** -- this workspace has no
       associated active change recorded. Only now fall back to
       broader, project-wide discovery, for backward compatibility
       with a change that predates the ownership sidecar:
       - Infer from conversation context if the user mentioned a change
       - Auto-select if only one active change exists (`openspec list --store "$CE_OPENSPEC_STORE" --json`)
       - If still ambiguous, use the **AskUserQuestion tool** to let the user select

   Always announce: "Using change: <name>" and how to override (e.g., `/apply <other>`).

2. **Check status to understand the schema**
   ```bash
   openspec status --change "<name>" --store "$CE_OPENSPEC_STORE" --json
   ```
   Parse the JSON to understand:
   - `schemaName`: The workflow being used (e.g., "spec-driven")
   - `planningHome`, `changeRoot`, and `actionContext`: planning scope and edit constraints -- these always resolve inside the external store, never inside the target repository or its Git worktree
   - Which artifact contains the tasks (typically "tasks" for spec-driven, check status for others)

3. **Get apply instructions**

   ```bash
   openspec instructions apply --change "<name>" --store "$CE_OPENSPEC_STORE" --json
   ```

   This returns:
   - `contextFiles`: artifact ID -> array of concrete file paths (varies by schema) -- always inside the external store
   - Progress (total, complete, remaining)
   - Task list with status
   - Dynamic instruction based on current state

   **Handle states:**
   - If `state: "blocked"` (missing artifacts): show message, suggest using `/continue`
   - If `state: "all_done"`: congratulate, suggest `/verify` next -- never `/archive` directly; implementation only just completed, so there is no fresh verification evidence yet for `/archive`'s own gate to accept
   - Otherwise: proceed to implementation

4. **Gate on the plan's freshness before reading anything, or implementing**

   Using `<changeRoot>/.ce-provenance-propose.yml` (written by
   `/propose`, covering `proposal.md`/`design.md`/`tasks.md` together),
   compare the plan's recorded state against the worktree's current one:
   ```bash
   CURRENT_FINGERPRINT=$({
     git -C "$CE_WORKTREE" rev-parse HEAD
     git -C "$CE_WORKTREE" diff HEAD
     git -C "$CE_WORKTREE" ls-files --others --exclude-standard -z | (cd "$CE_WORKTREE" && xargs -0 cat) 2>/dev/null
   } | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-12)
   cat "<changeRoot>/.ce-provenance-propose.yml" 2>/dev/null
   ```
   If there is no sidecar at all (a legacy plan that predates provenance
   tracking -- **never treat this as fresh**) or its `fingerprint:`
   differs from `$CURRENT_FINGERPRINT` (stale): **stop.** Do not read
   the context files below and do not implement any task. Tell the user
   the plan's provenance is unknown/stale (the repository has changed
   since `/propose` last ran, or was never recorded) and **direct them
   to run `/propose` again before resuming `/apply`.**

   Only once the sidecar exists and matches (fresh), **read context
   files**: read every file path listed under `contextFiles` from the
   apply instructions output. The files depend on the schema being used:
   - **spec-driven**: proposal, specs, design, tasks
   - Other schemas: follow the contextFiles from CLI output

   **Record the implementation base, once, if not already recorded.**
   This is the *only* deterministic evidence that this change actually
   entered implementation through the harness -- something
   `/verify`/`/adversarial-review` rely on to tell a real `/apply` run
   apart from, say, a hand-edited file after `/propose` (see
   `templates/commands/verify.md`'s Guard). Check whether
   `<changeRoot>/.ce-implementation-base.yml` already exists:
   - **If it already exists**, leave it completely untouched -- it
     records this change's true implementation starting point from the
     very first time `/apply` reached this step. Never overwrite it on
     a later resume: doing so would silently narrow what a later
     `/verify`/`/adversarial-review` reviews, hiding tasks already
     implemented in an earlier session.
   - **If it does not exist yet**, this is the first time `/apply` has
     reached this point for this change. Record the worktree's current
     `HEAD` -- **before implementing a single task below** -- as the
     implementation base:
     ```bash
     BASE_COMMIT=$(git -C "$CE_WORKTREE" rev-parse HEAD)
     RECORDED_AT=$(date -u +%Y-%m-%d)
     printf 'baseCommit: "%s"\nrecordedAt: "%s"\n' "$BASE_COMMIT" "$RECORDED_AT" \
       > "<changeRoot>/.ce-implementation-base.yml"
     ```
     This is exactly `$CE_WORKTREE`'s own current commit at this
     moment -- never the workspace's original `$CE_DIFF_BASE` (if this
     workspace started as a review of an external PR): the worktree may
     already be on a completely different branch/history by the time
     `/apply` runs (e.g. reset to a fresh branch off the target
     repository's current trunk before implementing), and a later
     transitioned-workspace diff must be scoped from *here*, not from
     wherever the original review happened to start. A small,
     ce-harness-owned sidecar -- never one of the `artifacts` OpenSpec
     tracks, never part of `applyRequires`, and never mentioned in this
     command's own output.

5. **Show current progress**

   Display:
   - Schema being used
   - Progress: "N/M tasks complete"
   - Remaining tasks overview
   - Dynamic instruction from CLI

6. **Implement tasks (loop until done or blocked)**

   For each pending task:
   - Show which task is being worked on
   - Make the code changes required, only inside `$CE_WORKTREE` -- never inside the external OpenSpec store, and never inside `$CE_REPOSITORY` if that variable is set (`$CE_WORKTREE` is a separate Git worktree from the original checkout)
   - Keep changes minimal and focused
   - Mark task complete in the tasks file: `- [ ]` → `- [x]` (this file lives in the external store; use the path from `contextFiles`, never a repo-local guess)
   - Continue to next task

   **Pause if:**
   - Task is unclear → ask for clarification
   - Task obviously bundles multiple independently completable
     responsibilities (more than one separately checkable success
     criterion, not just a description containing "and") → do not
     silently implement it as one lump or half-implement part of it;
     tell the user which task and why, and recommend re-running
     `/propose` to split it in `tasks.md`
   - The agreed requirement/scope changed or was found to rest on a
     wrong assumption -- not an implementation detail discovered while
     coding, not a bug fix needed to satisfy the existing spec, and not
     a clarification that leaves agreed behavior unchanged, but a real
     change to what was agreed. Two shapes of this count equally:
     - **the human says something** that changes or adds to the agreed
       requirement/scope; or
     - **investigation (yours or the human's) revealed that a review
       finding's own assumption about intended behavior was incorrect,
       or that the actual behavior differs from what was previously
       understood** -- e.g. you're implementing a fix for an
       adversarial-review finding and, while investigating it (possibly
       because the human challenged it), found evidence -- an existing
       test, a comment, prior code -- that contradicts what the finding
       (or the original plan) assumed. This is a change to the agreed
       contract exactly the same as the human explicitly saying so, even
       though no one stated it in those words.

     Either way → **stop before writing any code for the changed/new
     part.** Do not fold it in silently. Tell the user plainly what
     changed (or what evidence was found and what it contradicts), that
     continuing would mean implementing against a stale agreed contract,
     and recommend: run `/enrich <change>` to capture the new
     understanding and its evidence durably (it already detects
     in-progress implementation and treats this as blocking), then
     `/propose <change>` to realign `proposal.md`/`design.md`/
     `tasks.md`, then `/apply` again to resume -- already-completed
     tasks that remain valid are preserved, not redone.
   - Implementation reveals a design issue → suggest updating artifacts
   - Error or blocker encountered → report and wait for guidance
   - User interrupts

7. **On completion or pause, show status**

   Display:
   - Tasks completed this session
   - Overall progress: "N/M tasks complete"
   - If all done: suggest `ce open` to review the implementation, then `/verify` next -- never `/archive` -- the worktree just changed, so any prior verify/adversarial-review evidence (if this was a re-run after realigning artifacts, or after fixing adversarial-review findings) is now stale regardless
   - If paused: explain why and wait for guidance

**Output During Implementation**

```
## Implementing: <change-name> (schema: <schema-name>)

Working on task 3/7: <task description>
[...implementation happening...]
✓ Task complete

Working on task 4/7: <task description>
[...implementation happening...]
✓ Task complete
```

**Output On Completion**

```
## Implementation Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 7/7 tasks complete ✓

### Completed This Session
- [x] Task 1
- [x] Task 2
...

All tasks complete! Review the changes with `ce open` (opens the worktree
in your editor), then run `/verify` next -- the worktree just changed, so
any existing verify/adversarial-review evidence is now stale.
`/archive` isn't available yet: it requires a fresh, clean `PASS` from
both `/verify` and `/adversarial-review`.
```

**Output On Pause (Issue Encountered)**

```
## Implementation Paused

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 4/7 tasks complete

### Issue Encountered
<description of the issue>

**Options:**
1. <option 1>
2. <option 2>
3. Other approach

What would you like to do?
```

**Guardrails**
- Never select a change via project-wide discovery (`openspec list`) before checking `ce status "$CE_PROJECT/$CE_ISSUE"` (step 1) for this exact workspace's own already-associated active change -- and never ask the user to pick when it reports exactly one. Project-wide discovery is a backward-compatibility fallback only, for a change that predates the ownership sidecar.
- Keep going through tasks until done or blocked
- Always read context files before starting (from the apply instructions output)
- Always check `.ce-provenance-propose.yml`'s freshness in step 4, before reading any context file or implementing -- and never merely warn on a stale or unrecorded (legacy) result: **stop this command** and direct the user to rerun `/propose` first. A missing provenance sidecar is never treated as fresh.
- Record `<changeRoot>/.ce-implementation-base.yml` once, in step 4, the first time it's reached for a given change (the worktree's current `HEAD`, before any task's code changes) -- never write it if step 4's freshness gate didn't pass, and never overwrite it on a later resume. This is the only deterministic evidence a later `/verify`/`/adversarial-review` can trust that this change actually entered implementation through `/apply` itself -- never infer implementation from an OpenSpec change merely existing, from `/propose` having validated a plan, or from the worktree merely differing from some earlier state.
- If task is ambiguous, pause and ask before implementing
- If a task obviously bundles multiple independently completable responsibilities (more than one separately checkable success criterion), pause instead of silently implementing it as one lump -- judge this semantically, never by mechanically splitting on "and" -- and recommend re-running `/propose` to split it
- Never implement against a known-stale agreed contract: if the human changes or adds to the requirement/scope, or investigation reveals a review finding's own assumption was wrong (not an implementation detail, a spec-conforming bug fix, or a non-material clarification), stop before coding the changed/new part and recommend `/enrich` then `/propose` to realign the artifacts before resuming `/apply`
- If implementation reveals issues, pause and suggest artifact updates
- Keep code changes minimal and scoped to each task
- Update task checkbox immediately after completing each task
- Never suggest `/archive` as the next step, for any reason -- completing implementation (whether from the normal task list, after realigning artifacts, or after fixing an adversarial-review finding) always means the next step is `/verify`, since the worktree just changed and any prior verify/adversarial-review evidence is now stale
- On completion, always suggest `ce open` alongside `/verify` -- reviewing the implementation and moving to the next stage should both be immediately actionable from the same handoff, never `/verify` on its own
- Pause on errors, blockers, or unclear requirements - don't guess
- Use contextFiles from CLI output, don't assume specific file names
- Every `openspec` command must include `--store "$CE_OPENSPEC_STORE"`
- Product-code changes are only allowed inside `$CE_WORKTREE`; never write application/library code anywhere else, including the external OpenSpec store
- Never modify any file under `$CE_REPOSITORY` if that variable is set -- it is the original repository checkout, not the isolated worktree this command implements into
- Never create `openspec/`, `.opencode/`, reports, or any other harness/config file or directory inside the target repository or its Git worktree -- all OpenSpec artifacts and task-file updates belong only in the external store at `$CE_OPENSPEC_STORE`

**Fluid Workflow Integration**

This skill supports the "actions on a change" model:

- **Can be invoked anytime**: Before all artifacts are done (if tasks exist), after partial implementation, interleaved with other actions
- **Allows artifact updates**: If implementation reveals design issues, suggest updating artifacts - not phase-locked, work fluidly

_See `THIRD_PARTY_NOTICES.md` for this command's provenance and licensing._
