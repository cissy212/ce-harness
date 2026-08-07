---
name: typescript-engineer
description: Use when reasoning about TypeScript's type system specifically -- type soundness, narrowing, generics, discriminated unions, variance, module/declaration boundaries, and any/unknown handling. Applies to any TypeScript code, frontend or backend, where the question is whether the types correctly express and enforce the intended contract, not whether the runtime architecture is sound.
---

# TypeScript Engineer

A reasoning lens for the type system itself: is a type sound (does it
ever allow a value that violates what the rest of the code assumes), is
narrowing exhaustive, do generics preserve information or just
parameterize for appearance, and is variance correct where mutable
structures are shared. This goes deeper than a general engineering
review's passing mention of "type stability" -- it is the lens to load
when the type system itself is the subject.

**Scope note**: this lens does not review runtime module boundaries,
dependency injection, or testability (that is the backend-developer
lens's scope) and does not review component architecture or rendering
behavior (that is the frontend-developer lens's scope). It reasons about
whether the *types* correctly and safely describe behavior, regardless
of whether that behavior lives in a backend service or a UI component.
When a type-soundness hole enables an actual security consequence (not
just a compiler gap), the security consequence itself belongs to
security-reviewer -- this lens still records the type-level defect, but
defers the exploit/impact framing.

This is a reasoning lens loaded into the current review session as
context, the same way a proposal, design doc, or spec is loaded. It is
not a separate agent, and it never implements, edits, or runs anything --
the command that loaded it (`/verify`, `/adversarial-review`, or a future
workflow stage) owns those actions and its own report format.

---

## Phase 0 -- Read before reasoning

No conclusion is valid without evidence from the actual codebase.
Skipping this produces reviews that miss the real problems.

1. Read `tsconfig.json` and note exactly which strictness flags are
   enabled. `strict: true` implies `strictNullChecks`, `noImplicitAny`,
   and related checks, but does **not** imply `noUncheckedIndexedAccess`
   or `exactOptionalPropertyTypes` -- both are opt-in even under
   `strict`. Do not assume a flag is on because `strict` is set; read
   the actual config.
2. Search for density of type-system escape hatches: `as any`,
   `as unknown as`, `@ts-ignore`, `@ts-expect-error`, and non-null
   assertions (`!`). A high concentration is a signal of where the type
   system has already been bypassed, and where this lens should focus
   first.
3. Determine whether the task is purely about types, or also touches
   build/declaration configuration (project references, module
   resolution, emitted `.d.ts` files) -- the latter has a wider blast
   radius than a single file's types.
4. If the workspace reports semantic code navigation as available
   (`CE_CODE_NAV_AVAILABLE` set -- never assume this without checking;
   ce-harness only wires it up opportunistically), use it: for the
   `codegraph` provider (check `CE_CODE_NAV_PROVIDER`), that means
   `codegraph_explore` to trace where a type or generic is actually
   consumed across the codebase. Fall back to targeted Grep and Read
   when unavailable or insufficient. Either way, confirm anything cited
   as evidence against the actual current source before citing it --
   this accelerates discovery, it never substitutes for reading the
   exact line you cite.

Then characterise existing type conventions:

1. **Domain modeling style**: are domain states modeled as discriminated
   unions, or as objects with several independent optional fields that
   can combine into invalid states?
2. **Identity typing**: are semantically distinct values that share a
   primitive representation (e.g. different kinds of IDs, both strings)
   distinguished with branded/nominal types, or interchangeable?
3. **Boundary typing**: how is data crossing an external boundary (an
   HTTP response, a parsed file, an environment variable) typed --
   validated against a schema, or asserted directly into the expected
   shape?
4. **Generic usage**: are generics used to preserve a relationship
   between input and output types, or applied without changing what the
   function actually guarantees?

Write a 3-5 sentence characterisation of what was observed. This is the
factual baseline for everything that follows.

---

## Phase 1 -- Classify the work

State both classifications explicitly.

### Scope

| Class | Meaning |
|---|---|
| **Incremental** | Adds or modifies a local, unexported type with no other consumers. |
| **Structural** | Modifies a shared, exported type, interface, or generic used by more than one consumer. |
| **Architectural refactor** | Changes a package's public declared surface (its `.d.ts` shape), or changes compiler strictness configuration project-wide. |

### Risk

| Risk | Indicators |
|---|---|
| **Low** | Local, unexported type; no other file references it. |
| **Medium** | Exported type or interface with a small, known set of consumers. |
| **High** | A widely-consumed type, a type that enforces an invariant relied on elsewhere (e.g. a discriminated union gating a switch), or a change to compiler strictness flags. |

---

## Phase 2 -- Reasoning principles

### Soundness over convenience

A type is unsound if it allows constructing or accepting a value that
the rest of the code assumes cannot exist. Every `as` assertion is a
soundness hole the compiler can no longer check on your behalf -- each
one needs a stated reason it is actually safe (e.g. "validated on the
line above") or it is a latent bug, not a style choice.

### Narrowing must be exhaustive

When branching on a discriminated union or a closed set of literal
values, there should be an exhaustiveness mechanism (a `never`-typed
default case, an `assertNever`-style helper) so that adding a new
variant later becomes a compile error somewhere -- not a silently
unhandled case at runtime.

### `any` disables checking; `unknown` demands narrowing

`any` turns off type checking entirely and is infectious -- it spreads
to everything it touches without a compiler warning. `unknown` forces
the caller to narrow before use, which is almost always what was
actually intended. An `any` at a module or public-API boundary is a
larger risk than one confined to a small private scope, because more
callers inherit the loss of checking.

### Generics should preserve information

A generic function that immediately widens its type parameter to
something else (or never uses the parameter in its return type) provides
no benefit over hardcoding the widened type. Ask what relationship
between input and output the generic is actually preserving; if the
answer is "none," the generic is decorative.

### Variance and mutability across a shared boundary

A mutable array or object typed covariantly can be assigned to a
narrower-looking type and then written through with a value the original
owner never expected, breaking its invariants. This is a real soundness
gap in structurally-typed mutable containers, not a style nitpick --
flag it whenever a mutable structure is shared across a module boundary
and typed covariantly.

### Structural typing means shape, not identity

Two differently-named types with the same shape are interchangeable to
the compiler. When identity matters (a `UserId` must never be passed
where an `OrderId` is expected, even though both are strings), a
branded/nominal type (a unique tag field or symbol) is the standard
technique -- relying on naming alone provides no compiler-enforced
guarantee.

### Types at a trust boundary must be earned

Data crossing an external boundary (an HTTP response, a parsed file, an
environment variable) is `unknown` until something actually validates
it. Typing it directly as the expected shape is an assertion dressed up
as a fact. If no runtime validation backs the type up, say so explicitly
-- this is the same trust-boundary concern security-reviewer applies to
behavior, applied here to types.

---

## Phase 3 -- Failure modes

- **Escape-hatch overuse**: `as any`, `as unknown as X`, or non-null
  assertions used to suppress a real type error rather than express a
  proven invariant.
- **Illegal states representable**: a type shaped as several independent
  optional fields that can combine into a combination the code never
  actually expects, where a discriminated union would make the invalid
  combination unrepresentable.
- **Optional-property drift**: without `exactOptionalPropertyTypes`,
  `{ a?: string }` accepts `{ a: undefined }` as well as a missing key --
  code that distinguishes "absent" from "explicitly undefined" (e.g.
  serialization, diffing) can silently misbehave.
- **Unchecked indexed access**: without `noUncheckedIndexedAccess`,
  `record[key]` types as always-present even when the key may not exist
  at runtime, hiding a real `undefined` case from the type checker.
- **Numeric enum pitfalls**: numeric enums accept any number, including
  ones with no corresponding member; string literal unions or `as const`
  objects are usually the more structurally-honest choice.
- **Declaration-file drift**: a hand-maintained or loosely generated
  `.d.ts` file describing a shape the runtime no longer actually
  produces.
- **Loose generic constraints**: a generic constrained too broadly (e.g.
  `<T extends object>`) to actually guarantee what the function body
  assumes about `T`.

---

## Phase 4 -- Review checklist and evidence expectations

- Cite the exact type or function signature and file:line -- "the types
  could be better" is not a finding; "`parseConfig` returns `Config` but
  never validates the parsed JSON, so a malformed file produces a
  `Config`-typed value with missing fields at runtime" is.
- For a soundness claim, construct (or concretely describe) the specific
  value the type would wrongly accept or reject.
- For an `any`/assertion finding, state whether a validation step exists
  nearby that would justify it (cite it) or confirm that none exists.
- For an exhaustiveness finding, name the specific missing variant.
- Distinguish "the compiler will not catch this" (a provable, High
  confidence finding) from a style preference (not a finding for this
  lens).
- Do not extend findings into runtime module boundaries or dependency
  injection -- note them for backend-developer instead. Do not extend
  findings into component structure -- note them for frontend-developer
  instead.

---

## Lens checks

Soundness of assertions and escape hatches; exhaustiveness of narrowing
on discriminated unions; any-vs-unknown discipline at boundaries;
information-preservation in generics; variance and mutability risk
across shared structures; structural-vs-nominal typing where identity
matters; trust-boundary typing backed by actual runtime validation;
strictness-flag awareness (`strict` does not imply every opt-in check).
