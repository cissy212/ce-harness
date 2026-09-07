# Third-Party Notices

This file records the provenance of ce-harness templates adapted or
methodologically inspired by other projects. It replaces per-file
history/provenance prose that previously lived inside the executable
templates themselves (removed to reduce token cost on every load).

## Provenance correction (2026-09-07)

An earlier version of this file listed `templates/commands/verify.md`,
`templates/lenses/backend-developer.md`, `templates/lenses/pipeline-data-engineer.md`,
and part of `templates/commands/adversarial-review.md` as adapted from
MAT (market-audit-tool), a private/internal repository, and flagged all
four as requiring permission or a clean-room rewrite before public
publication.

That premise was wrong. ce-harness's author wrote this content
themselves, in a personal draft branch of MAT -- MAT was the workspace
the drafting happened in, not a pre-existing third-party source that was
copied from. MAT is not, and never was, a copyright source for any
ce-harness content, and no material from MAT/SCV was ever copied into
this project. The entries below have been corrected accordingly:

- `templates/commands/verify.md`, `templates/lenses/backend-developer.md`,
  and `templates/lenses/pipeline-data-engineer.md` are the author's own
  original work. A direct comparison against `lidr-specboot` (the one
  concretely identifiable methodology reference in this project's
  history -- see below) found no matching content in any of the three;
  their entries have been removed. No permission or rewrite is needed
  for these files.
- `templates/commands/adversarial-review.md` does contain genuine
  third-party expression -- from `lidr-specboot`, not MAT -- and it is
  larger than this file previously recorded (it previously listed only
  two verbatim sentences). Its entry below has been corrected and
  expanded to describe the actual extent of that content. It was
  already, and remains, fully covered by `lidr-specboot`'s confirmed MIT
  license; no permission or rewrite is needed for it either.

No file in this project currently requires permission or a clean-room
rewrite before publication.

---

## templates/commands/propose.md
- Upstream project: OpenSpec (`@fission-ai/openspec`)
- Source: `.opencode/commands/opsx-propose.md` + `.opencode/skills/openspec-propose/SKILL.md`, generated via `openspec init <dir> --tools opencode`
- Upstream version: 1.6.0
- License: MIT (confirmed)
- Relationship: Adapted -- workflow, artifact ordering, and behavior preserved from upstream; `CE_OPENSPEC_STORE` made mandatory, `--store` added to every invocation, guardrails added against repo-local artifacts and product-code changes; now reads `<changeRoot>/explore.md` (a ce-harness-owned, non-schema findings file -- see `templates/commands/explore.md`) for context before creating artifacts, and validates the change after creating artifacts (moved here from `/explore`, which no longer drafts or validates schema artifacts); each `tasks.md` task must now have one clear, independently verifiable success criterion, split semantically (never by mechanically breaking on "and") when it bundles independently completable responsibilities. When `enrich.md` documents a requirement change caught after implementation was already underway, `/propose` now revises the `done` artifacts it affects (instead of skipping them for being `done`), preserving already-completed, still-valid `tasks.md` entries rather than regenerating the file wholesale. A guardrail now states explicitly that realigning artifacts on an already-implemented change invalidates existing `/verify`/`/adversarial-review` evidence -- this command never suggests `/archive`. Right after `changeRoot` is resolved, this command now writes a small ce-harness-owned `.ce-workspace.yml` sidecar recording the workspace's project/issue, so `ce status`/`ce open --change` can durably associate a change with the workspace that created it instead of guessing across every active change in the project's shared durable store. Before reading `explore.md`/`enrich.md`, this command now gates on their ce-harness-owned provenance sidecars (a worktree fingerprint recorded by `/explore`/`/enrich`): if either exists with no recorded provenance (legacy) or a fingerprint that no longer matches the current worktree, this command stops at the earliest invalid stage and directs the user to rerun it, rather than proceeding on planning context that may no longer be valid; after validation passes, it records its own `.ce-provenance-propose.yml` sidecar the same way, so a much later `/apply` run can gate on whether the plan itself has gone stale relative to the current repository state -- durable planning artifacts previously had no provenance tracking at all. Step 1 (change-name resolution) now checks this exact workspace's own already-associated active change (via `ce status`, narrowed by the same `.ce-workspace.yml` ownership sidecar) before ever asking the user what to build -- a real usage bug where a workspace that already had an active change was still asked to re-describe/re-select it, because step 1 previously had no auto-resolution path at all, unlike `/enrich`'s and `/apply`'s equivalent step.

## templates/commands/apply.md
- Upstream project: OpenSpec (`@fission-ai/openspec`)
- Source: `.opencode/commands/opsx-apply.md` + `.opencode/skills/openspec-apply-change/SKILL.md`, generated via `openspec init <dir> --tools opencode`
- Upstream version: 1.6.0
- License: MIT (confirmed)
- Relationship: Adapted -- change selection/resume, task loop, checkbox updates, and completion reporting preserved from upstream; `CE_OPENSPEC_STORE` made mandatory, product-code changes scoped to `$CE_WORKTREE`, guardrails added; a task that obviously bundles multiple independently completable responsibilities now pauses implementation and recommends re-running `/propose` to split it, rather than being silently implemented as one lump. A human-driven change to the agreed requirement/scope mid-implementation now pauses implementation before coding the changed part and recommends `/enrich` then `/propose` to realign the artifacts, rather than folding the change into the code while the agreed contract goes stale. Every "all tasks complete" completion path (the `all_done` state, step 7's summary, and the Output On Completion template) now points to `/verify` next, never `/archive` directly -- completing implementation always leaves the worktree changed, so any prior verify/adversarial-review evidence is stale regardless of why the implementation happened (a normal task list, a post-realignment resume, or fixing an adversarial-review finding). Before reading any context file or implementing, step 4 now gates on `/propose`'s own `.ce-provenance-propose.yml` sidecar: if it's missing (a legacy plan) or its fingerprint no longer matches the current worktree, this command stops and directs the user to rerun `/propose` before resuming -- never proceeds to implement against planning context that may no longer be valid. Step 1 (change selection) now prefers this exact workspace's own already-associated active change (via `ce status "$CE_PROJECT/$CE_ISSUE"`, narrowed by the `.ce-workspace.yml` ownership sidecar) over the prior project-wide `openspec list`-based auto-select, which could otherwise pick up a different preserved workspace's own active change in a project with several -- that project-wide discovery remains only as a backward-compatibility fallback for a change that predates the ownership sidecar.

## templates/commands/archive.md
- Upstream project: OpenSpec (`@fission-ai/openspec`)
- Source: `.opencode/commands/opsx-archive.md` + `.opencode/skills/openspec-archive-change/SKILL.md`, generated via `openspec init <dir> --tools opencode`
- Upstream version: 1.6.0
- License: MIT (confirmed)
- Relationship: Adapted -- change selection, completion checks, delta-spec sync decision, and archive move preserved unchanged; `CE_OPENSPEC_STORE` made mandatory, delta-spec path explicitly store-rooted, guardrails added. The read-only, non-blocking review-evidence check (formerly step 4) is now a hard gate: archiving requires a fresh, passing `/verify` and `/adversarial-review` report (matching the current worktree fingerprint -- HEAD plus any uncommitted tracked/untracked implementation changes -- and artifacts hash covering proposal/design/tasks/specs) and unconditionally blocks on missing, failing, gapped, or stale evidence, with no confirm-to-continue override. The archive directory's `YYYY-MM-DD` date prefix must now be computed by running `date -u +%Y-%m-%d`, never inferred from the model's own memory or training data -- a real usage bug where an agent guessed the wrong calendar date.

## templates/skills/openspec-sync-specs/SKILL.md
- Upstream project: OpenSpec (`@fission-ai/openspec`)
- Source: `.opencode/skills/openspec-sync-specs/SKILL.md`, generated via `openspec init <dir> --tools opencode`
- Upstream version: 1.6.0
- License: MIT (confirmed)
- Relationship: Adapted -- sync workflow, delta-spec discovery, and per-capability merging preserved unchanged; `CE_OPENSPEC_STORE` made mandatory, main-spec path explicitly store-rooted, guardrail added.

## templates/commands/adversarial-review.md
- Upstream project: lidr-specboot (public, MIT)
- Source: `ai-specs/skills/adversarial-review/SKILL.md`
- Source revision: commit `4efb044` (2026-05-12) -- reconfirmed unchanged at this commit on 2026-09-07
- License: MIT (confirmed, Copyright (c) 2026 LIDR.co)
- Relationship: Adapted. Verbatim or near-verbatim content from lidr-specboot, beyond what an earlier version of this entry recorded (previously listed as only two sentences -- corrected here to the actual, larger extent found on re-review):
  - The opening sentence, verbatim: "Act as an independent adversarial reviewer: assume gaps, flaws, or unsafe behavior may exist until you have argued against them with evidence."
  - Two sentences on when/how this command applies, verbatim (as previously recorded): "This skill is intended for the verification window of spec-driven development (after implementation, before archiving), when the human runs a different agent or session than the one that implemented the change." and "Do not prescribe which agent, model, or IDE to use. That is the human's choice."
  - Four of the five "Mindset" bullets, verbatim or near-verbatim: the cross-boundary/composition-risk bullet, the "treat the diff as incomplete context" bullet, and the "calibrate depth to risk" bullet (all verbatim); the "hunt/challenge incorrect assumptions about data shape, timing, ordering, authz, idempotency, and error handling" bullet (near-verbatim, one verb swapped).
  - The "Adversarial pass (refute, do not rubber-stamp)" section heading, verbatim, and its four enumerated items (near-verbatim): the "could still fail" list (wrong input, partial failure, double-submit, stale cache, wrong role, race, empty state, oversized payload); the "negative and abuse cases" bullet; the "do they prove the criterion, or only the happy path?" question; and "record mismatches...as first-class findings."
  - The `PASS (adversarial)` / `PASS WITH GAPS` / `FAIL` verdict vocabulary, verbatim, including the unusual "(adversarial)" qualifier on `PASS`.
  - The "do not praise implementation to balance criticism unless a strength directly mitigates a documented risk" guardrail -- now this command's "Risk-Mitigating Observations" section instruction.
  All of the above is covered by lidr-specboot's confirmed MIT license.
  Everything else in this command is the author's own original elaboration, substantially exceeding lidr-specboot's ~115-line skill in scope: dual workspace-type handling (Implementation vs. Existing PR review, including the divergent baseline/report-destination/provenance-gate logic for each); a four-independent-axis finding classification (Severity, Confidence, Merge impact, and Area) replacing lidr-specboot's single Blocker/Major/Minor/Question axis; the mandatory, lens-independent "Baseline Review Coverage" pass (Step 6); ce-harness's own runner-agnostic reasoning-lens selection and application (Step 7); the two-table split between "Findings Affecting This Change" and "Pre-Existing or Adjacent Issues" (lidr-specboot has one undifferentiated findings table); a `**Verdict:**` sentinel line so `/archive` can grep it deterministically; a recorded worktree commit SHA, worktree fingerprint, and artifacts hash so `/archive` can detect stale review evidence; a challenge pass against any existing `/verify` report (Step 4); conditional next-step guidance based on the verdict; the `date -u +%Y-%m-%d` discipline for the report's date; and the `ce open --path "<report path>"` handoff in the "Report back" step, so a printed filesystem path into the external store is never the only way offered to reach the report.

## templates/skills/composition-patterns/SKILL.md and templates/skills/composition-patterns/rules/*.md
- Upstream project: `vercel-labs/agent-skills` (public, discovered via skills.sh)
- Source: `skills/composition-patterns/SKILL.md` and `skills/composition-patterns/rules/*.md` (8 rule files)
- Upstream version: `1.0.0` (per the skill's own `metadata.json`)
- License: MIT, as declared in the skill's own `SKILL.md` frontmatter (`license: MIT`). Note: the upstream repository has no repository-wide `LICENSE` file; this is a per-skill self-declared grant, not a repo-wide one. Treated as a legitimate, intentional MIT grant because the repository is published by Vercel specifically for one-command redistribution via the skills.sh/`npx skills` ecosystem, whose entire premise is installing this content into third-party projects.
- Relationship: Vendored near-verbatim. Content is pure React/TypeScript reference knowledge (composition patterns, boolean-prop avoidance, compound components, context-based state decoupling, React 19 API changes) with no runner-specific tool coupling, no CLI invocations, and no OpenSpec/ce-harness-specific paths to adapt. Only the upstream repository's own authoring/build artifacts were dropped as not needed at runtime: `AGENTS.md` (a compiled duplicate of the `rules/*.md` files), `README.md`, `metadata.json`, and `rules/_sections.md`/`rules/_template.md` (upstream's own SKILL.md-generation scaffolding). `SKILL.md`'s frontmatter and body are otherwise unchanged; a trailing `_See THIRD_PARTY_NOTICES.md..._` line was appended to match ce-harness's existing skill-provenance convention.
