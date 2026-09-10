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

4. **Require durable, fresh, non-blocking evidence from `/verify` and `/adversarial-review` (hard gate)**

   A change cannot be archived as successfully completed unless both
   have produced durable, fresh evidence with nothing unresolved that
   the report itself classifies as `Blocking` -- this step enforces that,
   deterministically, rather than relying on remembering whether an
   earlier command failed. A clean `PASS` always qualifies; a `PASS WITH
   GAPS` report qualifies too, but only when every one of its unresolved
   findings/gaps is explicitly tagged `Merge impact: Non-blocking` --
   never merely because the verdict token isn't `FAIL`. It never runs
   `/verify` or `/adversarial-review` itself, never modifies a report,
   and never reclassifies a finding's Merge impact itself -- it only
   reads whichever reports already exist and gates on what they already
   say. This applies only to OpenSpec implementation changes (the only
   kind `/archive` ever operates on); an Existing PR review's reports
   live at a different, unrelated location and are not part of this
   gate.

   Resolve the current state to compare evidence against -- the same
   two computations `/verify`/`/adversarial-review` themselves run
   before writing a report (see their "Write the report" step); this
   must keep computing the identical result for identical worktree/
   artifact state, since a drifted computation would make every report
   look stale (or fresh) for the wrong reason:
   ```bash
   # Worktree fingerprint -- covers uncommitted implementation changes,
   # not just the commit.
   {
     git -C "$CE_WORKTREE" rev-parse HEAD
     git -C "$CE_WORKTREE" diff HEAD
     git -C "$CE_WORKTREE" ls-files --others --exclude-standard -z | (cd "$CE_WORKTREE" && xargs -0 cat) 2>/dev/null
   } | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-12

   # Artifacts hash -- covers proposal.md/design.md/tasks.md/specs/, not
   # just tasks.md.
   {
     for f in proposal.md design.md tasks.md; do
       [ -f "<changeRoot>/$f" ] && cat "<changeRoot>/$f"
     done
     find "<changeRoot>/specs" -type f 2>/dev/null | sort | xargs cat 2>/dev/null
   } | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-12
   ```

   For **each** of `/verify` and `/adversarial-review`, find the most
   recent report of that kind under `<changeRoot>/reports/` (by filename
   date: `*-verify.md` / `*-adversarial-review.md`). A later report
   always supersedes an earlier one of the same kind -- this is what
   lets a passing rerun overturn an earlier failure without deleting the
   history of either.

   Classify each first by verdict token and freshness, **before** ever
   looking at individual findings/gaps -- freshness is checked
   unconditionally, regardless of which verdict token is present, since
   a stale report must block archive no matter how its findings are
   classified:
   - **Missing** -- no report of that kind exists at all. Required, not
     optional.
   - **Failing** -- its `**Verdict:**` line reads `FAIL`.
   - **Stale** -- its `**Verdict:**` line reads `PASS` or `PASS WITH
     GAPS`, but its `**Verified worktree fingerprint:**`/`**Reviewed
     worktree fingerprint:**` or `**Verified artifacts hash:**`/
     `**Reviewed artifacts hash:**` doesn't match the current values
     resolved above (or it predates those fields existing, so has none
     to compare). Checked identically for both verdict tokens -- a
     `PASS WITH GAPS` report is exactly as capable of going stale as a
     `PASS` one, and an accepted non-blocking gap from a stale report is
     never trustworthy evidence about the current worktree. The
     worktree fingerprint changes on **any** implementation change since
     the report was written -- committed or not, tracked or untracked --
     so this catches uncommitted work-in-progress just as reliably as a
     new commit. The `**Verified/Reviewed worktree commit:**` field is
     never compared here -- it's for human reference only, since two
     different fingerprints can share the same commit (uncommitted
     changes) while an unchanged fingerprint always implies an unchanged
     commit too.
   - **Fresh `PASS`** -- its `**Verdict:**` line reads `PASS`, and both
     recorded values match current. Continue directly to **Good** below
     -- a clean `PASS` has no findings/gaps to inspect.
   - **Fresh `PASS WITH GAPS`** -- its `**Verdict:**` line reads `PASS
     WITH GAPS`, and both recorded values match current. Do not treat
     this as blocking or as safe by itself -- inspect its actual
     findings/gaps next, below.

   **For a Fresh `PASS WITH GAPS` report, read it in full and check
   every unresolved item's own Merge impact** -- never the verdict token
   alone (a `PASS WITH GAPS` verdict, by itself, tells you only that
   *something* remains open, not whether it's safe to archive past):
   - **`/verify`'s report:** every entry under "Gaps and Blockers" must
     carry an explicit `Merge impact: Blocking` or `Non-blocking` tag
     (see that command's own report-writing instructions). Treat any
     entry with **no tag at all** (a legacy report predating this
     convention) as `Blocking` -- never assume an untagged gap is safe.
   - **`/adversarial-review`'s report:** check every row of "Findings
     Affecting This Change" for `Merge impact: Blocking` (its own
     verdict rules already force `FAIL` when one exists, but re-check
     directly here rather than trusting that computation blindly), and
     every entry under **Scope limitations** and **Gaps or inaccessible
     evidence** for an explicit `Merge impact` tag, with the same
     untagged-means-`Blocking` rule as above. "Pre-Existing or Adjacent
     Issues" is never part of this check -- that table never gates
     archive, by that command's own design.
   - **If every unresolved item across both checks is explicitly
     `Non-blocking`:** this report counts as **Good**, same as a clean
     `PASS` -- but record which items were carried forward (report
     name, kind, and the item's own text) for the "Output On Success"
     template's **Carried-forward gaps** section below. Never silently
     present this as if the report had been a clean `PASS`.
   - **If any unresolved item is `Blocking` (or untagged):** this report
     counts as **Blocked by findings** -- see below.

   **If both reports are Good** (whether from a clean `PASS`, or a
   `PASS WITH GAPS` where every unresolved item is explicitly
   `Non-blocking`): proceed to step 5. If either report contributed
   carried-forward gaps, remember them for step 7's output -- do not
   drop this information once the gate passes.

   **If either report is Missing, Failing, Stale, or Blocked by
   findings: stop here.** Do not proceed to step 5 or step 6. This is
   unconditional -- unlike steps 2 and 3's warnings, there is no
   "confirm to continue anyway," and reclassifying a finding's Merge
   impact to force a pass is never this command's decision to make (that
   belongs to `/verify`/`/adversarial-review` themselves, on a rerun).
   Show the "Output On Blocked" template below, telling the user exactly
   what's wrong with each blocking one (missing / failing / stale /
   which specific finding(s) are `Blocking`, its report path if it has
   one) and the exact command to run next (`/verify <name>` and/or
   `/adversarial-review <name>`).

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

   Generate the target name using the current date: `YYYY-MM-DD-<change-name>`.
   **Never infer this date from memory, training data, or any other
   form of model knowledge** -- compute it deterministically from the
   system clock, the same way `/verify` and `/adversarial-review`
   compute their own report dates:
   ```bash
   date -u +%Y-%m-%d
   ```
   Use this command's exact output, verbatim, as `YYYY-MM-DD` below --
   never a remembered, assumed, or estimated date.

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
   - A ready-to-run `ce open --archived <project>/<issue>` command to view the archived artifacts -- never a bare filesystem path (see below)
   - Spec sync status (synced / sync skipped / no delta specs)
   - Note about any warnings (incomplete artifacts/tasks)
   - Any carried-forward, explicitly non-blocking gaps from step 4 -- never
     silently omitted just because they didn't block archiving

**Output On Success**

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** `ce open --archived <project>/<issue>` -- opens the archived artifacts directly
**Specs:** ✓ Synced to main specs / No delta specs / Sync skipped (user chose to skip)

**Warnings:**
- Archived with N incomplete artifacts
- Archived with N incomplete tasks
- Delta spec sync was skipped (user chose to skip)

**Carried-forward gaps (explicitly non-blocking, not required to be fixed before archiving):**
- [/verify] <the gap's own text, verbatim> -- reports/<file>
- [/adversarial-review] <the finding/limitation's own text, verbatim> -- reports/<file>

All artifacts complete. All tasks complete.

Next: /publish
```

Reaching this template at all already means step 4's gate passed --
both `/verify` and `/adversarial-review` evidence was Good, meaning
either a clean `PASS` or a `PASS WITH GAPS` whose every unresolved item
was explicitly `Non-blocking` -- so this never has a *blocking*
review-evidence warning to show; a blocked archive shows the "Output On
Blocked" template below instead and never reaches this point. Show
whichever single **Specs** value actually applies -- never all three.
Include the **Warnings** section, listing only the specific warnings
that actually apply, only when at least one holds (incomplete
artifacts, incomplete tasks, or a skipped sync); omit the section
entirely when none apply. When the **Warnings** section is present,
change the heading to `## Archive Complete (with warnings)` and use
"Review the archive if this was not intentional." as the closing line
instead of "All artifacts complete. All tasks complete." -- either way,
always end with "Next: /publish" on its own line: `/archive` only
closes the development contract, it never pushes or opens a pull
request itself -- `/publish` is the separate, explicit step for that
(see templates/commands/publish.md), and this pointer is what tells the
user it exists.

**Include the "Carried-forward gaps" section whenever step 4 found at
least one explicitly `Non-blocking` item in either report** -- quote
each one's own text verbatim (never paraphrase it into something
vaguer) alongside which command's report it came from and that report's
filename, so a human skimming this output can immediately tell this
wasn't a clean run without opening either report. Omit the section
entirely when both reports were a clean `PASS` with nothing carried
forward. This section is independent of the **Warnings** section above
(artifact/task completeness) and of the heading/closing-line choice --
its presence never changes which heading or closing line is used; it is
simply always shown, on its own, whenever it applies. **Never omit this
section, and never let the surrounding output read as if the result
were a clean `PASS`** when a non-blocking gap was actually carried
forward -- the whole point of this gate change is that the human stays
able to see exactly what was accepted and why.

**Never print the bare archive filesystem path** (e.g.
`openspec/changes/archive/2026-09-09-case-studies-domain-model/`) as
the way to reach the archived artifacts -- a relative filesystem path
looks clickable in most terminals, and clicking it attempts to open it
as a browser URL instead of doing anything useful. Substitute the
literal `<project>` and `<issue>` (this workspace's actual `$CE_PROJECT`
and `$CE_ISSUE`, e.g. `ce open --archived market-audit-tool/case-
studies-domain-model`) into the **Archived to** line above -- never
print the placeholder text or the raw `$CE_PROJECT`/`$CE_ISSUE` tokens
themselves, and never the internal store path.

**Output On Blocked (Missing/Failing/Stale/Blocking-Finding Verification Evidence)**

```
## Archive Blocked

**Change:** <change-name>

Archiving requires a fresh `/verify` and `/adversarial-review` report
for the current worktree and tasks.md, with nothing unresolved that
either report itself classifies as blocking. This change doesn't have
that yet:

- **verify:** <one of: "Missing -- run `/verify <name>` first." | "reports/<file>: FAIL -- run `/verify <name>` again after addressing its findings." | "reports/<file>: PASS WITH GAPS, but stale (verified against a different commit/tasks.md than the current state) -- run `/verify <name>` again." | "reports/<file>: PASS WITH GAPS with an unresolved Blocking gap -- '<the gap's own text, verbatim>' -- resolve it (or, if this was misclassified, have /verify explicitly mark it Non-blocking with a stated reason on a rerun), then run `/verify <name>` again.">
- **adversarial-review:** <same shapes as above, for `/adversarial-review <name>`, substituting "finding" for "gap" where natural>

Run whichever command(s) are needed above, then `/archive <name>` again.
```

Show a line for both `/verify` and `/adversarial-review` even when only
one is the actual problem -- state plainly that the other is Good
(including whether it carried forward any accepted non-blocking gaps)
so the user isn't left guessing. This gate is unconditional: there is
no option here to proceed anyway, unlike the artifact/task warnings
above, and this command never reclassifies a finding's Merge impact
itself to force a pass -- quote the blocking item's own text so the
user can judge whether it's genuinely blocking or was simply
under-classified, and resolve that on the next `/verify`/
`/adversarial-review` run, not here.

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
- Never write the archive directory's date prefix from memory or assumption -- always run `date -u +%Y-%m-%d` and use its exact output.
- Always prompt for change selection if not provided
- Use artifact graph (openspec status --store "$CE_OPENSPEC_STORE" --json) for completion checking
- Don't block archive on the artifact/task-completion warnings (steps 2-3) - just inform and confirm; step 4's verification-evidence gate is different and is never soft (see below)
- Preserve .openspec.yaml when moving to archive (it moves with the directory)
- Show clear summary of what happened
- If sync is requested, use the Skill tool to invoke `openspec-sync-specs` (agent-driven)
- If delta specs exist, always run the sync assessment and show the combined summary before prompting
- Every `openspec` command must include `--store "$CE_OPENSPEC_STORE"`
- Never assume repo-local `openspec/` paths -- always use `planningHome`, `changeRoot`, and `artifactPaths` resolved from the CLI's JSON output, which point inside the external store
- Never modify product/application code during `/archive` -- this command only moves OpenSpec planning artifacts within the external store
- Never create `openspec/`, `.opencode/`, reports, or any other harness/config file or directory inside the target repository or its Git worktree -- archiving happens only inside the external store at `$CE_OPENSPEC_STORE`
- This command requires a fresh `/verify` and `/adversarial-review` report before archiving (Step 4), with nothing unresolved that either report itself classifies `Blocking`: missing, `FAIL`, stale evidence (verified against a different worktree commit or tasks.md than the current state), or a `PASS WITH GAPS` report containing any unresolved `Blocking` (or untagged) item unconditionally blocks archive -- no confirm-to-continue override, unlike the softer artifact/task-completion warnings in steps 2-3. A `PASS WITH GAPS` report whose every unresolved item is explicitly tagged `Merge impact: Non-blocking` does **not** block -- but its carried-forward gaps must always be surfaced in Step 7's output (never presented as a clean `PASS`). A later passing rerun always supersedes an earlier failure, since the gate only ever looks at the most recent report of each kind. It never reruns `/verify` or `/adversarial-review` itself, never modifies a report, and never reclassifies a finding's Merge impact itself -- it only reads the most recent report of each kind and gates on what it already says.

_See `THIRD_PARTY_NOTICES.md` for this command's provenance and licensing._
