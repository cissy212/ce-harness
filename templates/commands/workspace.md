---
description: Show details about the current ce-harness workspace
agent: build
---
Show the context of the current ce-harness workspace.

Run `env | grep '^CE_'` and summarize, in plain language:

- the project and issue being worked on (`CE_PROJECT`, `CE_ISSUE`)
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
lenses, and the current runner's configuration.
