---
description: Archive a completed change in the experimental workflow
---

Archive a completed change in the experimental workflow.

**Store:** This command always operates on this workspace's external OpenSpec
store. If `CE_OPENSPEC_STORE` is empty or unset, stop and tell the user to run
`ce start` first -- there is no store to work with. Every `openspec` command
below includes `--store "$CE_OPENSPEC_STORE"`.

**Input**: Optionally specify a change name after `/archive` (e.g., `/archive add-auth`). If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **If no change name provided, prompt for selection**

   Run `openspec list --store "$CE_OPENSPEC_STORE" --json` to get available changes. Use the **AskUserQuestion tool** to let the user select.

   Show only active changes (not already archived).
   Include the schema used for each change if available.

   **IMPORTANT**: Do NOT guess or auto-select a change. Always let the user choose.

2. **Check artifact completion status**

   Run `openspec status --change "<name>" --store "$CE_OPENSPEC_STORE" --json` to check artifact completion.

   Parse the JSON to understand:
   - `schemaName`: The workflow being used
   - `planningHome`, `changeRoot`, `artifactPaths`, and `actionContext`: path and scope context -- these always resolve inside the external store, never inside the target repository or its Git worktree
   - `artifacts`: List of artifacts with their status (`done` or other)

   **If any artifacts are not `done`:**
   - Display warning listing incomplete artifacts
   - Prompt user for confirmation to continue
   - Proceed if user confirms

3. **Check task completion status**

   Read the tasks file (typically `tasks.md`) to check for incomplete tasks.

   Count tasks marked with `- [ ]` (incomplete) vs `- [x]` (complete).

   **If incomplete tasks found:**
   - Display warning showing count of incomplete tasks
   - Prompt user for confirmation to continue
   - Proceed if user confirms

   **If no tasks file exists:** Proceed without task-related warning.

4. **Check for unresolved review evidence (read-only, informational only)**

   This step never runs `/verify` or `/adversarial-review` itself, never
   requires either to have run, and never modifies any report -- it only
   reads whichever reports already exist and surfaces what they already
   say. This applies only to OpenSpec implementation changes (the only
   kind `/archive` ever operates on); an Existing PR review's reports
   live at a different, unrelated location and are not part of this
   check.

   Look for the most recent report of each kind under `<changeRoot>/reports/`,
   if any:
   - the most recent `*-verify.md` file (by filename date)
   - the most recent `*-adversarial-review.md` file (by filename date)

   For whichever of the two exist, read only their `## Overall Verdict`
   section.

   **If a verify report exists and its verdict is not exactly `PASS`**
   (i.e. `PASS WITH GAPS` or `FAIL` -- which per `/verify`'s own verdict
   rules means at least one requirement is `NOT VERIFIED`, a task is
   `UNVERIFIED CHECKBOX`, a design commitment is `NOT VERIFIED`, or an
   item is `BLOCKED`/`PARTIALLY VERIFIED`): note this as unresolved
   verify evidence.

   **If an adversarial-review report exists and its verdict is `FAIL` or
   `PASS WITH GAPS`:** note this as unresolved adversarial-review
   evidence.

   **If either report shows unresolved evidence:**
   - Display a warning identifying the report file and its exact
     verdict (e.g. "reports/2026-08-10-verify.md: PASS WITH GAPS", or
     "reports/2026-08-10-adversarial-review.md: FAIL").
   - Prompt user for confirmation to continue.
   - Proceed if user confirms.

   **If no such reports exist, or every report found shows a clean
   `PASS` verdict:** proceed without a warning -- archive behavior is
   unchanged from today.

5. **Assess delta spec sync state**

   Use `artifactPaths.specs.existingOutputPaths` from status JSON to check for delta specs. If none exist, proceed without sync prompt.

   **If delta specs exist:**
   - Compare each delta spec with its corresponding main spec at `<planningHome.root>/openspec/specs/<capability>/spec.md` (resolved from the JSON, never a path relative to the current working directory or the target repository)
   - Determine what changes would be applied (adds, modifications, removals, renames)
   - Show a combined summary before prompting

   **Prompt options:**
   - If changes needed: "Sync now (recommended)", "Archive without syncing"
   - If already synced: "Archive now", "Sync anyway", "Cancel"

   If user chooses sync, use Task tool (subagent_type: "general-purpose", prompt: "Use Skill tool to invoke openspec-sync-specs for change '<name>'. Delta spec analysis: <include the analyzed delta spec summary>"). Proceed to archive regardless of choice.

6. **Perform the archive**

   Create an `archive` directory under `planningHome.changesDir` if it doesn't exist:
   ```bash
   mkdir -p "<planningHome.changesDir>/archive"
   ```

   Generate target name using current date: `YYYY-MM-DD-<change-name>`

   **Check if target already exists:**
   - If yes: Fail with error, suggest renaming existing archive or using different date
   - If no: Move `changeRoot` to the archive directory

   ```bash
   mv "<changeRoot>" "<planningHome.changesDir>/archive/YYYY-MM-DD-<name>"
   ```

   Both `<changeRoot>` and `<planningHome.changesDir>` come from the `status --store "$CE_OPENSPEC_STORE" --json` output in step 2 -- always absolute paths inside the external store. Never substitute a repo-local or hand-constructed path.

7. **Display summary**

   Show archive completion summary including:
   - Change name
   - Schema that was used
   - Archive location
   - Spec sync status (synced / sync skipped / no delta specs)
   - Note about any warnings (incomplete artifacts/tasks, unresolved
     review evidence)

**Output On Success**

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** the archive path derived from `planningHome.changesDir`/YYYY-MM-DD-<name>/
**Specs:** ✓ Synced to main specs / No delta specs / Sync skipped (user chose to skip)

**Warnings:**
- Archived with N incomplete artifacts
- Archived with N incomplete tasks
- Delta spec sync was skipped (user chose to skip)
- Unresolved review evidence: <report filename> (<verdict>)

All artifacts complete. All tasks complete.
```

Show whichever single **Specs** value actually applies -- never all
three. Include the **Warnings** section, listing only the specific
warnings that actually apply, only when at least one holds (incomplete
artifacts, incomplete tasks, a skipped sync, or unresolved review
evidence from Step 4); omit the section entirely when none apply. When
the **Warnings** section is present, change the heading to
`## Archive Complete (with warnings)` and use "Review the archive if
this was not intentional." as the closing line instead of "All
artifacts complete. All tasks complete."

**Output On Error (Archive Exists)**

```
## Archive Failed

**Change:** <change-name>
**Target:** the archive path derived from `planningHome.changesDir`/YYYY-MM-DD-<name>/

Target archive directory already exists.

**Options:**
1. Rename the existing archive
2. Delete the existing archive if it's a duplicate
3. Wait until a different date to archive
```

**Guardrails**
- Always prompt for change selection if not provided
- Use artifact graph (openspec status --store "$CE_OPENSPEC_STORE" --json) for completion checking
- Don't block archive on warnings - just inform and confirm
- Preserve .openspec.yaml when moving to archive (it moves with the directory)
- Show clear summary of what happened
- If sync is requested, use the Skill tool to invoke `openspec-sync-specs` (agent-driven)
- If delta specs exist, always run the sync assessment and show the combined summary before prompting
- Every `openspec` command must include `--store "$CE_OPENSPEC_STORE"`
- Never assume repo-local `openspec/` paths -- always use `planningHome`, `changeRoot`, and `artifactPaths` resolved from the CLI's JSON output, which point inside the external store
- Never modify product/application code during `/archive` -- this command only moves OpenSpec planning artifacts within the external store
- Never create `openspec/`, `.opencode/`, reports, or any other harness/config file or directory inside the target repository or its Git worktree -- archiving happens only inside the external store at `$CE_OPENSPEC_STORE`
- This command does not require a prior `/verify` or `/adversarial-review` report to archive -- it archives based on artifact/task completion, plus a passive, read-only surfacing of unresolved evidence from the most recent such reports if they exist (Step 4). It never reruns `/verify` or `/adversarial-review`, never modifies a report, and never blocks archiving on their findings -- only informs and confirms, exactly like the other warnings above.

_See `THIRD_PARTY_NOTICES.md` for this command's provenance and licensing._
