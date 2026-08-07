---
description: Show details about the current ce-harness workspace
agent: build
---
Show the context of the current ce-harness workspace.

Run `env | grep '^CE_'` and summarize, in plain language:

- the project and issue being worked on (`CE_PROJECT`, `CE_ISSUE`)
- **the workspace type** -- state this explicitly, as either
  "Workspace type: Implementation" or "Workspace type: Existing PR
  review". It is `Existing PR review` when both `CE_DIFF_BASE` and
  `CE_DIFF_HEAD` are set (this workspace was created with
  `ce start --base --head` to review an already-given commit range);
  otherwise it is `Implementation`. Do not derive this from anything
  else -- these are the same two variables that already gate the
  review-range diff logic in `/verify` and `/adversarial-review`.
- the workspace and worktree paths (`CE_WORKSPACE`, `CE_WORKTREE`)
- the OpenSpec store id, if set (`CE_OPENSPEC_STORE`)
- the canonical reasoning-lens directory (`CE_LENSES_DIR`)
- whether semantic code navigation is available for this session
  (`CE_CODE_NAV_AVAILABLE`, and which provider backs it via
  `CE_CODE_NAV_PROVIDER`) -- absence is normal and not a problem; it just
  means the workflow commands fall back to Grep/Read

Then briefly describe what these mean for how you should work in this
session: changes belong in the worktree, and the workspace directory
holds this session's external OpenSpec store, its canonical reasoning
lenses, and the current runner's configuration. If the workspace type is
`Existing PR review`, also mention that `/verify` will refuse to run here
(there is no OpenSpec-driven implementation to check conformance
against) and that `/adversarial-review` is the command for reviewing
this commit range.
