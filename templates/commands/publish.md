---
description: Publish a completed, archived change as a GitHub pull request
agent: build
---

Ship the current workspace's completed, archived change as a normal
GitHub pull request -- a reviewer-ready title and description generated
from the actual shipped product change and its real verification
evidence, with a full preview and explicit confirmation before anything
is pushed or created.

**Input**: Optionally specify a change name after `/publish` (e.g.
`/publish add-user-auth`) to attribute the publish to a specific
archived change instead of letting `ce publish` auto-resolve the most
recently archived one for this workspace.

**Steps**

1. **Generate the publish plan** (no remote mutation yet)
   ```bash
   ce publish
   ```
   (Add `--change "<name>"` if a change name was given as input.) This:
   - fetches the base branch and compares it against this workspace's
     own branch;
   - safely merges the base into the workspace's branch if it advanced
     and the merge is clean -- refuses outright (a thrown error) if that
     would conflict, rather than resolving anything itself;
   - resolves this workspace's most recently archived OpenSpec change
     (or the one explicitly given);
   - computes the exact branch name to expose in the target repository
     (never `ce-harness/*`);
   - reports the exact repository, remote base, branch, included
     commits and files, and any uncommitted changes that will be
     committed on confirm.

   Parse its JSON output. If the command fails (a thrown error, non-zero
   exit code), report the error to the user verbatim and stop -- do not
   attempt to work around it or resolve a conflict yourself.

   If the plan's `warnings` array is non-empty, treat this as a hard
   stop: show the warnings to the user and do not proceed without their
   explicit direction. These flag paths that look like harness/OpenSpec
   internals appearing in the product diff, which must never reach the
   target repository.

2. **Gather real content for the PR** (read-only)

   If the plan's `changeRoot` is non-null, read (all inside the durable
   OpenSpec store, at that exact `changeRoot` path -- never guess or
   construct this path by hand):
   - `proposal.md` and `design.md`, for what changed and why;
   - the most recent `reports/*-verify.md` and
     `reports/*-adversarial-review.md` under `changeRoot` (by filename
     date, most recent wins) -- specifically their own `## Commands
     Executed and Outcomes` section, as the source for the PR's Test
     Plan. **Never invent a test, command, or outcome that isn't listed
     there.** If a report is missing entirely, say so honestly in the
     Test Plan rather than fabricate coverage.

   If `changeRoot` is null (no archived OpenSpec change could be
   resolved for this workspace), derive the summary directly from the
   plan's `includedCommits` subjects and `includedFiles` instead --
   publishing must still work without an OpenSpec change.

3. **Write the PR title and body**

   **Title**: short, imperative, product-focused (e.g. "Add email notes
   to the contacts address book"), exactly like a normal repository
   commit/PR title.

   **Body**: a normal, reviewer-friendly PR description with at minimum
   a Summary (what changed and why, in plain product language) and a
   Test Plan (grounded in step 2's actual evidence: verified
   requirements, the commands that were actually run and their
   outcomes -- state plainly if verification evidence wasn't found
   rather than inventing coverage).

   **Never mention**, anywhere in the title or body: ce-harness,
   OpenSpec, `/explore`, `/enrich`, `/propose`, `/apply`, `/verify`,
   `/adversarial-review`, `/archive`, internal reports, or the workflow
   used to produce this change. Write exactly as a human contributor
   would describe the shipped product change, with no trace of the
   tooling that produced it.

4. **Display the full publish plan and ask for confirmation**

   Show, verbatim, before asking anything:
   ```
   Ready to publish

   Repository: <repoSlug>
   Base: <baseBranch>
   Branch: <publishBranch>
   origin/<baseBranch>: <remoteBaseCommit>

   Update status: <"already current" when updateStatus is
   "already-current", otherwise "safely updated (merged
   origin/<baseBranch> in)">

   Included:
   <one line per includedCommits entry: short sha + subject>
   <includedFiles, as a plain file list>
   <only if uncommittedFiles is non-empty: "N uncommitted file(s) will
   also be committed: <list>">

   PR title:
   <title>

   PR description:
   <full body>
   ```

   Then use the **AskUserQuestion tool** to ask "Create this pull
   request?" with clear yes/no options. **Do not proceed past this point
   without an explicit yes.** If the user declines, stop -- nothing has
   been pushed or created, and they can re-run `/publish` any time.

5. **Confirmed publish** (only after explicit approval)

   Write the PR body to a temporary file (never pass a multi-paragraph
   body as a raw shell argument), then:
   ```bash
   ce publish --confirm \
     --title "<title>" \
     --body-file <path to the temp file> \
     --expected-head "<headCommit from step 1's plan>" \
     --expected-fingerprint "<expectedFingerprint from step 1's plan>"
   ```
   (Include `--change "<name>"` too if it was used in step 1.) Pass
   `headCommit` and `expectedFingerprint` exactly as step 1's plan
   reported them, unmodified -- `ce publish` re-verifies both
   immediately before touching anything, and refuses if either has
   changed (e.g. a file was added or edited in the worktree after the
   plan was shown, even without the branch's commit moving) rather than
   publishing content the user never actually saw approved. This
   commits any still-uncommitted changes (using the approved title as
   the commit message), pushes the branch, and creates the pull
   request -- or, if a PR for this branch is already open, reports its
   existing URL instead of creating a duplicate. **Never merges the PR
   and never enables auto-merge** -- this command has no capability to
   do either.

   If it refuses (e.g. the branch or worktree changed since step 1's plan was
   generated), report the error verbatim and tell the user to re-run
   `/publish` from step 1.

**Output**

On success, report only:
```
Pull request ready: <url>
```
Never claim it was merged -- it wasn't, and never will be by this
command.

**Guardrails**
- Never run step 5 without the user having explicitly approved the plan
  shown in step 4.
- Never merge the pull request or enable auto-merge -- no command in
  this workflow does either.
- Never mention ce-harness, OpenSpec, or any workflow-stage command
  (`/explore`, `/enrich`, `/propose`, `/apply`, `/verify`,
  `/adversarial-review`, `/archive`) in the PR title or body.
- Never invent a test, command, or verification outcome in the Test
  Plan -- only what step 2's actual reports (or their honest absence)
  support.
- If `ce publish`'s `warnings` field is non-empty, stop and surface it
  instead of proceeding.
- Never construct the branch name, repository slug, or base branch by
  hand -- always the exact values `ce publish` reports.
- This applies only to an Implementation workspace with a completed,
  archived change; `ce publish` itself refuses for an Existing PR review
  workspace.
