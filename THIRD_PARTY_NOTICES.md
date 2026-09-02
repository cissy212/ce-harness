# Third-Party Notices

This file records the provenance of ce-harness templates adapted or
methodologically inspired by other projects. It replaces per-file
history/provenance prose that previously lived inside the executable
templates themselves (removed to reduce token cost on every load).

## Publication review required

**Before ce-harness is published publicly, the files listed below must
not contain copied or closely adapted expression from MAT
(market-audit-tool) unless explicit permission is obtained from its
rights holder.**

MAT is a private/internal repository with no confirmed license. Its
entries in this file record where its methodology and phrasing were used
as an internal reference during development. **A notice in this file is
not permission for public redistribution** and must not be treated as
one.

Files requiring one of the two remediations below before public
publication:

- `templates/commands/verify.md`
- `templates/commands/adversarial-review.md` (the MAT-derived portions
  only -- the lidr-specboot-derived portions are separately licensed MIT
  and are not affected)
- `templates/lenses/backend-developer.md`
- `templates/lenses/pipeline-data-engineer.md`

Required remediation, before public publication, for each file above:

- **(a)** obtain written permission from MAT's rights holder to
  redistribute the adapted expression under a stated license, or
- **(b)** perform an independent clean-room rewrite of the file, based
  only on generic software-engineering ideas and publicly available,
  appropriately licensed sources, with no reference to MAT's text during
  the rewrite.

This rename/cleanup task is not that clean-room rewrite and does not
weaken or alter the methodology in these files; it only relocates their
provenance documentation out of the executable templates.

---

## templates/commands/propose.md
- Upstream project: OpenSpec (`@fission-ai/openspec`)
- Source: `.opencode/commands/opsx-propose.md` + `.opencode/skills/openspec-propose/SKILL.md`, generated via `openspec init <dir> --tools opencode`
- Upstream version: 1.6.0
- License: MIT (confirmed)
- Relationship: Adapted -- workflow, artifact ordering, and behavior preserved from upstream; `CE_OPENSPEC_STORE` made mandatory, `--store` added to every invocation, guardrails added against repo-local artifacts and product-code changes; now reads `<changeRoot>/explore.md` (a ce-harness-owned, non-schema findings file -- see `templates/commands/explore.md`) for context before creating artifacts, and validates the change after creating artifacts (moved here from `/explore`, which no longer drafts or validates schema artifacts); each `tasks.md` task must now have one clear, independently verifiable success criterion, split semantically (never by mechanically breaking on "and") when it bundles independently completable responsibilities. When `enrich.md` documents a requirement change caught after implementation was already underway, `/propose` now revises the `done` artifacts it affects (instead of skipping them for being `done`), preserving already-completed, still-valid `tasks.md` entries rather than regenerating the file wholesale. A guardrail now states explicitly that realigning artifacts on an already-implemented change invalidates existing `/verify`/`/adversarial-review` evidence -- this command never suggests `/archive`. Right after `changeRoot` is resolved, this command now writes a small ce-harness-owned `.ce-workspace.yml` sidecar recording the workspace's project/issue, so `ce status`/`ce open --change` can durably associate a change with the workspace that created it instead of guessing across every active change in the project's shared durable store.

## templates/commands/apply.md
- Upstream project: OpenSpec (`@fission-ai/openspec`)
- Source: `.opencode/commands/opsx-apply.md` + `.opencode/skills/openspec-apply-change/SKILL.md`, generated via `openspec init <dir> --tools opencode`
- Upstream version: 1.6.0
- License: MIT (confirmed)
- Relationship: Adapted -- change selection/resume, task loop, checkbox updates, and completion reporting preserved from upstream; `CE_OPENSPEC_STORE` made mandatory, product-code changes scoped to `$CE_WORKTREE`, guardrails added; a task that obviously bundles multiple independently completable responsibilities now pauses implementation and recommends re-running `/propose` to split it, rather than being silently implemented as one lump. A human-driven change to the agreed requirement/scope mid-implementation now pauses implementation before coding the changed part and recommends `/enrich` then `/propose` to realign the artifacts, rather than folding the change into the code while the agreed contract goes stale. Every "all tasks complete" completion path (the `all_done` state, step 7's summary, and the Output On Completion template) now points to `/verify` next, never `/archive` directly -- completing implementation always leaves the worktree changed, so any prior verify/adversarial-review evidence is stale regardless of why the implementation happened (a normal task list, a post-realignment resume, or fixing an adversarial-review finding).

## templates/commands/archive.md
- Upstream project: OpenSpec (`@fission-ai/openspec`)
- Source: `.opencode/commands/opsx-archive.md` + `.opencode/skills/openspec-archive-change/SKILL.md`, generated via `openspec init <dir> --tools opencode`
- Upstream version: 1.6.0
- License: MIT (confirmed)
- Relationship: Adapted -- change selection, completion checks, delta-spec sync decision, and archive move preserved unchanged; `CE_OPENSPEC_STORE` made mandatory, delta-spec path explicitly store-rooted, guardrails added. The read-only, non-blocking review-evidence check (formerly step 4) is now a hard gate: archiving requires a fresh, passing `/verify` and `/adversarial-review` report (matching the current worktree fingerprint -- HEAD plus any uncommitted tracked/untracked implementation changes -- and artifacts hash covering proposal/design/tasks/specs) and unconditionally blocks on missing, failing, gapped, or stale evidence, with no confirm-to-continue override.

## templates/skills/openspec-sync-specs/SKILL.md
- Upstream project: OpenSpec (`@fission-ai/openspec`)
- Source: `.opencode/skills/openspec-sync-specs/SKILL.md`, generated via `openspec init <dir> --tools opencode`
- Upstream version: 1.6.0
- License: MIT (confirmed)
- Relationship: Adapted -- sync workflow, delta-spec discovery, and per-capability merging preserved unchanged; `CE_OPENSPEC_STORE` made mandatory, main-spec path explicitly store-rooted, guardrail added.

## templates/commands/verify.md
- Upstream project: MAT (market-audit-tool) -- private/internal repository
- Source: `ai-specs/skills/verify-against-spec/SKILL.md` and `.opencode/commands/verify.md`
- Source revision: commit `457411e` (2026-07-24)
- License: **Internal methodological reference -- redistribution permission not confirmed.** No LICENSE file in the source repository. See "Publication review required" above.
- Relationship: Adapted -- change-resolution flow, requirement/scenario verification loop, VERIFIED/PARTIALLY VERIFIED/NOT VERIFIED/BLOCKED categories, and checked-task audit preserved; generalized to be repository-agnostic and external-store-aware; MAT-specific specialist-agent mapping, PIPELINE.md reads, Docker assumption, and hardcoded npm commands removed. The `Overall Verdict` now leads with a `**Verdict:**` sentinel line (exactly `PASS`/`PASS WITH GAPS`/`FAIL`, nothing else) plus a recorded worktree commit SHA (human reference), a worktree fingerprint (HEAD plus any uncommitted tracked/untracked implementation changes -- a commit alone would miss uncommitted work), and an artifacts hash (proposal/design/tasks/specs, not just tasks.md), so `/archive` can grep it deterministically and detect stale evidence. The "run `/adversarial-review` next" recommendation is now conditional on a clean `PASS` verdict -- a `FAIL`/`PASS WITH GAPS` report instead recommends fixing the findings and re-running `/verify`, never proceeding forward to `/adversarial-review` or `/archive` on a report that isn't clean.

## templates/commands/adversarial-review.md
- Upstream projects: lidr-specboot (public, MIT) and MAT (market-audit-tool, private/internal)
- Sources: lidr-specboot `ai-specs/skills/adversarial-review/SKILL.md`; MAT `ai-specs/skills/adversarial-review/SKILL.md` and `.opencode/commands/adversarial-review.md`
- Source revisions: lidr-specboot commit `4efb044` (2026-05-12); MAT commit `9afcb15` (2026-07-28)
- License: lidr-specboot content -- MIT (confirmed, Copyright (c) 2026 LIDR.co). MAT content -- **Internal methodological reference -- redistribution permission not confirmed.** No LICENSE file in the source repository. See "Publication review required" above.
- Relationship: Adapted -- adversarial mindset and framing verbatim-quoted from lidr-specboot in two sentences ("This skill is intended for the verification window...", "Do not prescribe which agent, model, or IDE to use..."); adversarial-pass steps, Area/Confidence taxonomies, and evidence-discipline requirements from MAT's refined skill; generalized to be repository-agnostic and external-store-aware; MAT's report-path/archive-gate coupling and pr-review/bug-investigation references removed. The `Overall Verdict` now leads with a `**Verdict:**` sentinel line (exactly `PASS`/`PASS WITH GAPS`/`FAIL`, nothing else) plus a recorded worktree commit SHA (human reference), a worktree fingerprint (HEAD plus any uncommitted tracked/untracked implementation changes), and an artifacts hash (proposal/design/tasks/specs, not just tasks.md) -- all Implementation workspaces only -- so `/archive` can grep it deterministically and detect stale evidence -- a ce-harness-native, minimal reintroduction of an archive-gate coupling, not the MAT-specific one removed above. This command's own "Report back" step now states a next step explicitly (it previously stated none): a `FAIL`/`PASS WITH GAPS` verdict recommends fixing the findings and re-running `/verify`, never `/archive`; a clean `PASS` verdict recommends `/archive` only conditionally, on `/verify`'s own most recent report also being a fresh, clean `PASS` -- `/archive`'s own gate remains the sole authority on whether archiving actually succeeds.

## templates/lenses/backend-developer.md
- Upstream project: MAT (market-audit-tool) -- private/internal repository
- Source: `ai-specs/agents/backend-developer.md`
- Source revision: commit `a81f15b` (2026-07-24)
- License: **Internal methodological reference -- redistribution permission not confirmed.** No LICENSE file in the source repository. See "Publication review required" above.
- Relationship: Adapted -- read-before-reasoning, scope/risk classification, engineering principles, abstraction discipline, and query/transaction reasoning preserved in substance; runner-specific metadata, MAT paths/examples, and MAT's plan/review output formats removed; rewritten as a portable reasoning lens.

## templates/lenses/pipeline-data-engineer.md
- Upstream project: MAT (market-audit-tool) -- private/internal repository
- Source: `ai-specs/agents/pipeline-data-engineer.md`
- Source revision: commit `cfff04d` (2026-07-24)
- License: **Internal methodological reference -- redistribution permission not confirmed.** No LICENSE file in the source repository. See "Publication review required" above.
- Relationship: Adapted -- idempotency/work-selection/concurrency/checkpoint/observability principles and execution patterns preserved in substance; every MAT-specific example genericized; runner-specific metadata and MAT's plan/review output formats removed.

## templates/skills/composition-patterns/SKILL.md and templates/skills/composition-patterns/rules/*.md
- Upstream project: `vercel-labs/agent-skills` (public, discovered via skills.sh)
- Source: `skills/composition-patterns/SKILL.md` and `skills/composition-patterns/rules/*.md` (8 rule files)
- Upstream version: `1.0.0` (per the skill's own `metadata.json`)
- License: MIT, as declared in the skill's own `SKILL.md` frontmatter (`license: MIT`). Note: the upstream repository has no repository-wide `LICENSE` file; this is a per-skill self-declared grant, not a repo-wide one. Treated as a legitimate, intentional MIT grant because the repository is published by Vercel specifically for one-command redistribution via the skills.sh/`npx skills` ecosystem, whose entire premise is installing this content into third-party projects -- unlike MAT's entries above, there is affirmative evidence of intent to allow redistribution.
- Relationship: Vendored near-verbatim. Content is pure React/TypeScript reference knowledge (composition patterns, boolean-prop avoidance, compound components, context-based state decoupling, React 19 API changes) with no runner-specific tool coupling, no CLI invocations, and no OpenSpec/ce-harness-specific paths to adapt. Only the upstream repository's own authoring/build artifacts were dropped as not needed at runtime: `AGENTS.md` (a compiled duplicate of the `rules/*.md` files), `README.md`, `metadata.json`, and `rules/_sections.md`/`rules/_template.md` (upstream's own SKILL.md-generation scaffolding). `SKILL.md`'s frontmatter and body are otherwise unchanged; a trailing `_See THIRD_PARTY_NOTICES.md..._` line was appended to match ce-harness's existing skill-provenance convention.
