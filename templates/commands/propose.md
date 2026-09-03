---
description: Propose a new change - create it and generate all artifacts in one step
---

Propose a new change - create the change and generate all artifacts in one step.

I'll create a change with artifacts:
- proposal.md (what & why)
- design.md (how)
- tasks.md (implementation steps)

When ready to implement, run /apply

---

**Store:** This command always operates on this workspace's external OpenSpec
store. If `CE_OPENSPEC_STORE` is empty or unset, stop and tell the user to run
`ce start` first -- there is no store to work with. Every `openspec` command
below includes `--store "$CE_OPENSPEC_STORE"`.

**Input**: The argument after `/propose` is the change name (kebab-case), OR a description of what the user wants to build.

**Steps**

1. **If no input provided, ask what they want to build**

   Use the **AskUserQuestion tool** (open-ended, no preset options) to ask:
   > "What change do you want to work on? Describe what you want to build or fix."

   From their description, derive a kebab-case name (e.g., "add user authentication" → `add-user-auth`).

   **IMPORTANT**: Do NOT proceed without understanding what the user wants to build.

2. **Create the change directory**
   ```bash
   openspec new change "<name>" --store "$CE_OPENSPEC_STORE"
   ```
   This creates a scaffolded change in the external store's planning home with `.openspec.yaml`.

3. **Get the artifact build order**
   ```bash
   openspec status --change "<name>" --store "$CE_OPENSPEC_STORE" --json
   ```
   Parse the JSON to get:
   - `applyRequires`: array of artifact IDs needed before implementation (e.g., `["tasks"]`)
   - `artifacts`: list of all artifacts with their status and dependencies
   - `planningHome`, `changeRoot`, `artifactPaths`, and `actionContext`: path and scope context. Use these instead of assuming repo-local paths -- they always resolve inside the external store, never inside the target repository or its Git worktree.

   **Record this workspace's ownership of the change** (idempotent --
   safe to re-run on every `/propose` invocation for this change, not
   just the first): this is what lets `ce status`/`ce open --change`
   find the right change automatically later, even when other
   workspaces for this project have their own active changes.
   ```bash
   printf 'project: "%s"\nissue: "%s"\n' "$CE_PROJECT" "$CE_ISSUE" > "<changeRoot>/.ce-workspace.yml"
   ```
   Resolve `<changeRoot>` from the JSON above, never construct it by
   hand. This file is **not** one of the `artifacts` listed above, is
   never part of `applyRequires`, and is ce-harness's own bookkeeping --
   never read it, never treat it as a dependency, and never mention it
   in this command's output.

   Also check for `<changeRoot>/explore.md` and `<changeRoot>/enrich.md`
   (resolve `changeRoot` from this same JSON, never construct it by
   hand). Neither is one of the `artifacts` listed above, neither is
   ever part of `applyRequires`, and this command never writes or
   modifies either -- read-only context/requirement input, outside
   OpenSpec's own artifact graph. If a file doesn't exist at all,
   proceed without it for that one -- `/propose` must keep working
   standalone, without a prior `/explore` or `/enrich` run.

   **Before reading either one, gate on its freshness -- stop at the
   earliest invalid stage.** Using their provenance sidecars (written by
   `/explore` and `/enrich` respectively):
   ```bash
   CURRENT_FINGERPRINT=$({
     git -C "$CE_WORKTREE" rev-parse HEAD
     git -C "$CE_WORKTREE" diff HEAD
     git -C "$CE_WORKTREE" ls-files --others --exclude-standard -z | (cd "$CE_WORKTREE" && xargs -0 cat) 2>/dev/null
   } | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-12)
   cat "<changeRoot>/.ce-provenance-explore.yml" 2>/dev/null
   cat "<changeRoot>/.ce-provenance-enrich.yml" 2>/dev/null
   ```
   - If `explore.md` exists and its sidecar is either missing (a legacy
     `explore.md` that predates provenance tracking -- **never treat
     this as fresh**) or its `fingerprint:` differs from
     `$CURRENT_FINGERPRINT` (stale): **stop.** Do not read `explore.md`,
     do not create or update any artifact. Tell the user `explore.md`'s
     provenance is unknown/stale and **direct them to run `/explore`
     again -- the earliest invalid stage -- then `/enrich` (if it had
     already been run) and `/propose` again.**
   - Otherwise, if `enrich.md` exists and its sidecar is either missing
     or stale the same way: **stop.** Tell the user `enrich.md`'s
     provenance is unknown/stale and **direct them to run `/enrich`
     again, then `/propose` again.**
   - Otherwise (each present file's provenance is fresh, or the file is
     absent): read whichever of `explore.md`/`enrich.md` exist now, for
     context -- use it for context, not as content to copy; translate
     only what each artifact needs, never copy sections wholesale.

   If `enrich.md` exists (and passed the freshness gate above), check
   its `**Status:**` line:
   - `needs-clarification` -- **stop here.** Do not create or write any
     artifact. Tell the user `/enrich` found unresolved questions on
     this change, list its Open Questions verbatim, and recommend
     re-running `/enrich` to resolve them before `/propose` continues.
   - `ready` -- continue to step 4. Treat its Clarified Intent,
     Confirmed Acceptance Criteria, Assumptions, Constraints, Edge
     Cases/Error Cases, Conflicts Identified, and Relevant Current/Prior
     Context as requirement input for the artifacts below. Translate
     only the specific facts each artifact needs -- never copy
     `enrich.md`'s sections wholesale into `proposal.md`, `design.md`,
     or `tasks.md`.

4. **Create artifacts in sequence until apply-ready**

   Use the **TodoWrite tool** to track progress through the artifacts.

   **Realigning after a requirement change caught mid-implementation**:
   if `enrich.md` (read in step 3) documents a requirement change found
   on a re-run where implementation was already underway, the artifacts
   it affects need revising even though `openspec status` already marks
   them `done` -- the loop below only walks `ready` artifacts by
   default, so don't let that skip a `done` artifact the change
   actually touches. Revise only what the change affects. In
   `tasks.md` specifically: preserve already-completed (`- [x]`) tasks
   that remain valid under the changed requirement exactly as they are;
   add, modify, or remove only the tasks the change affects -- never
   regenerate the file wholesale, and never uncheck a task the change
   didn't invalidate.

   Loop through artifacts in dependency order (artifacts with no pending dependencies first):

   a. **For each artifact that is `ready` (dependencies satisfied)**:
      - Get instructions:
        ```bash
        openspec instructions <artifact-id> --change "<name>" --store "$CE_OPENSPEC_STORE" --json
        ```
      - The instructions JSON includes:
        - `context`: Project background (constraints for you - do NOT include in output)
        - `rules`: Artifact-specific rules (constraints for you - do NOT include in output)
        - `template`: The structure to use for your output file
        - `instruction`: Schema-specific guidance for this artifact type
        - `resolvedOutputPath`: Resolved path or pattern to write the artifact -- always inside the external store
        - `dependencies`: Completed artifacts to read for context
      - Read any completed dependency files for context, plus `explore.md` and (if its Status is `ready`) `enrich.md` from step 3, if they exist
      - Create the artifact file using `template` as the structure and write it to `resolvedOutputPath`
      - **For `tasks.md` specifically**: write each task so it has exactly
        one clear, independently verifiable success criterion. If a task
        bundles multiple independently completable responsibilities,
        split it into separate tasks. Judge this semantically -- do the
        pieces have separate, independently checkable outcomes? -- never
        mechanically: do not split a task just because its description
        contains "and". Keep tasks useful to whoever implements them,
        not artificially microscopic -- naturally cohesive work (e.g. a
        small field, its migration, and its validation, for one column)
        stays one task.
      - Apply `context` and `rules` as constraints - but do NOT copy them into the file
      - Show brief progress: "Created <artifact-id>"

   b. **Continue until all `applyRequires` artifacts are complete**
      - After creating each artifact, re-run `openspec status --change "<name>" --store "$CE_OPENSPEC_STORE" --json`
      - Check if every artifact ID in `applyRequires` has `status: "done"` in the artifacts array
      - Stop when all `applyRequires` artifacts are done

   c. **If an artifact requires user input** (unclear context):
      - Use **AskUserQuestion tool** to clarify
      - Then continue with creation

   d. **Validate, once every `applyRequires` artifact is done**:
      ```bash
      openspec validate "<name>" --store "$CE_OPENSPEC_STORE"
      ```
      If validation fails, fix the artifacts (still only inside the store) and re-validate until it passes.

5. **Record provenance**, once validation passes. `proposal.md`/
   `design.md`/`tasks.md` are only as trustworthy as the worktree state
   they were designed against -- record it now, the same way `/explore`
   and `/enrich` record theirs, so a much later `/apply` run (this
   durable store outlives any one workspace) can tell whether the plan
   has gone stale:
   ```bash
   COMMIT=$(git -C "$CE_WORKTREE" rev-parse HEAD)
   FINGERPRINT=$({
     git -C "$CE_WORKTREE" rev-parse HEAD
     git -C "$CE_WORKTREE" diff HEAD
     git -C "$CE_WORKTREE" ls-files --others --exclude-standard -z | (cd "$CE_WORKTREE" && xargs -0 cat) 2>/dev/null
   } | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-12)
   RECORDED_AT=$(date -u +%Y-%m-%d)
   printf 'commit: "%s"\nfingerprint: "%s"\nrecordedAt: "%s"\n' "$COMMIT" "$FINGERPRINT" "$RECORDED_AT" \
     > "<changeRoot>/.ce-provenance-propose.yml"
   ```
   A small, ce-harness-owned sidecar -- never one of the `artifacts`
   OpenSpec tracks, never part of `applyRequires`, and never mentioned
   in this command's own output. Write/refresh it unconditionally,
   including when this run only revised existing artifacts rather than
   creating them fresh -- the recorded state must always reflect the
   worktree as of the *most recent* `/propose` run.

6. **Show final status**
   ```bash
   openspec status --change "<name>" --store "$CE_OPENSPEC_STORE"
   ```

**Output**

After completing all artifacts, summarize concisely -- an artifact
checklist (✓ present, ✗ missing), never the durable store's internal
path, e.g.:

```
Proposal ready.
Artifacts: explore ✓  enrich ✓  proposal ✓  design ✓  tasks ✓
View them with: ce open --change
Next: /apply
```

- Change name, plus the checklist above (include `specs`/`reports` too
  if this change has any)
- What's ready: "All artifacts created! Ready for implementation."
- "View them with: `ce open --change`" -- never recite the internal
  store path
- Prompt: "Run `/apply` to start implementing."

**Artifact Creation Guidelines**

- Follow the `instruction` field from `openspec instructions` for each artifact type
- The schema defines what each artifact should contain - follow it
- Read dependency artifacts for context before creating new ones
- Use `template` as the structure for your output file - fill in its sections
- **IMPORTANT**: `context` and `rules` are constraints for YOU, not content for the file
  - Do NOT copy `<context>`, `<rules>`, `<project_context>` blocks into the artifact
  - These guide what you write, but should never appear in the output

**Guardrails**
- Create ALL artifacts needed for implementation (as defined by schema's `apply.requires`)
- Always read dependency artifacts before creating a new one
- Always write/refresh `<changeRoot>/.ce-workspace.yml` right after resolving `changeRoot` in step 3, recording `$CE_PROJECT`/`$CE_ISSUE` -- it is never one of the schema artifacts, never a dependency, and never mentioned in this command's output
- If `<changeRoot>/explore.md` exists, read it for context before creating artifacts -- it is never one of the schema artifacts and this command never writes or modifies it
- If `<changeRoot>/enrich.md` exists, read it for context before creating artifacts -- it is never one of the schema artifacts and this command never writes or modifies it. If its Status is `needs-clarification`, do not create any artifact; surface its Open Questions and stop instead
- Check `explore.md`'s and `enrich.md`'s provenance sidecars before reading either (step 3) -- and never merely warn about a stale or unrecorded (legacy) result: **stop this command** at the earliest invalid one and direct the user to rerun it. A missing provenance sidecar is never treated as fresh.
- Always write/refresh `<changeRoot>/.ce-provenance-propose.yml` after validation passes (step 5), including on a revision-only run -- never skip it just because artifacts already existed
- Never copy `enrich.md`'s sections verbatim into `proposal.md`, `design.md`, or `tasks.md` -- translate only the requirement facts each artifact needs
- If `enrich.md` documents a requirement change caught after implementation was already underway, revise the `done` artifacts it affects instead of skipping them for being `done` already; in `tasks.md`, preserve already-completed tasks that remain valid and touch only what the change affects -- never regenerate it wholesale
- Realigning `proposal.md`/`design.md`/`tasks.md`/specs on an already-implemented change always invalidates any existing `/verify`/`/adversarial-review` evidence for it -- never suggest `/archive` as a consequence of this command; the next step after realigned tasks are implemented is always `/verify` (see `/apply`'s own completion guidance)
- Each task in `tasks.md` has one clear, independently verifiable success criterion; split a task that bundles independently completable responsibilities -- judge this semantically (separately checkable outcomes), never mechanically (never split solely because a sentence contains "and")
- If context is critically unclear, ask the user - but prefer making reasonable decisions to keep momentum
- If a change with that name already exists, ask if user wants to continue it or create a new one
- Verify each artifact file exists after writing before proceeding to next
- Every `openspec` command must include `--store "$CE_OPENSPEC_STORE"`
- Never create `openspec/`, `.opencode/`, or any other harness/config file or directory inside the target repository or its Git worktree -- all artifacts belong only in the external store at `$CE_OPENSPEC_STORE`
- Never modify product/application code during `/propose` -- this command only creates OpenSpec planning artifacts (proposal, design, tasks); implementation is `/apply`'s job

_See `THIRD_PARTY_NOTICES.md` for this command's provenance and licensing._
