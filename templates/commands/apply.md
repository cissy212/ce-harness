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

   If a name is provided, use it. Otherwise:
   - Infer from conversation context if the user mentioned a change
   - Auto-select if only one active change exists
   - If ambiguous, run `openspec list --store "$CE_OPENSPEC_STORE" --json` to get available changes and use the **AskUserQuestion tool** to let the user select

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

4. **Read context files**

   Read every file path listed under `contextFiles` from the apply instructions output.
   The files depend on the schema being used:
   - **spec-driven**: proposal, specs, design, tasks
   - Other schemas: follow the contextFiles from CLI output

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
   - The human says something that changes or adds to the agreed
     requirement/scope -- not an implementation detail discovered while
     coding, not a bug fix needed to satisfy the existing spec, and not
     a clarification that leaves agreed behavior unchanged, but a real
     change to what was agreed → **stop before writing any code for the
     changed/new part.** Do not fold it in silently. Tell the user
     plainly what changed, that continuing would mean implementing
     against a stale agreed contract, and recommend: run `/enrich
     <change>` to capture the new intent durably (it already detects
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
   - If all done: suggest `/verify` next, never `/archive` -- the worktree just changed, so any prior verify/adversarial-review evidence (if this was a re-run after realigning artifacts, or after fixing adversarial-review findings) is now stale regardless
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

All tasks complete! Run `/verify` next -- the worktree just changed, so
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
- Keep going through tasks until done or blocked
- Always read context files before starting (from the apply instructions output)
- If task is ambiguous, pause and ask before implementing
- If a task obviously bundles multiple independently completable responsibilities (more than one separately checkable success criterion), pause instead of silently implementing it as one lump -- judge this semantically, never by mechanically splitting on "and" -- and recommend re-running `/propose` to split it
- Never implement against a known-stale agreed contract: if the human changes or adds to the requirement/scope (not an implementation detail, a spec-conforming bug fix, or a non-material clarification), stop before coding the changed/new part and recommend `/enrich` then `/propose` to realign the artifacts before resuming `/apply`
- If implementation reveals issues, pause and suggest artifact updates
- Keep code changes minimal and scoped to each task
- Update task checkbox immediately after completing each task
- Never suggest `/archive` as the next step, for any reason -- completing implementation (whether from the normal task list, after realigning artifacts, or after fixing an adversarial-review finding) always means the next step is `/verify`, since the worktree just changed and any prior verify/adversarial-review evidence is now stale
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
