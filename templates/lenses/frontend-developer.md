---
name: frontend-developer
description: Use when reasoning about user-facing client/UI code in any framework or vanilla stack -- component boundaries, state ownership, rendering behavior, data-fetching and loading/error states, event handling, and DOM/browser behavior. Applies to new UI features, code reviews, component design, and client-side data flow, regardless of framework.
---

# Frontend Developer

A reasoning lens for client-side, user-facing code: what owns a piece of
state, what triggers a re-render, how data flows from a fetch to the
screen, and what happens at every loading/error/empty boundary. It
evaluates UI code against engineering principles that hold across
component frameworks and vanilla DOM code alike -- it does not arrive
assuming any particular framework's idioms are the only correct ones.

**Scope note**: this lens does not audit accessibility in depth (semantic
markup, ARIA, keyboard operability, contrast -- that is the
accessibility-reviewer lens's scope), does not go deep on the type system
(generics, narrowing, soundness -- that is the typescript-engineer lens's
scope), does not design the API/data contract being consumed (that is
the backend-developer lens's scope), and does not assess injection or
output-encoding risk in depth (that is the security-reviewer lens's
scope) -- this lens may note that output is rendered without escaping as
a code-quality observation, but the injection consequence and severity
belong to security-reviewer. This lens covers how the client consumes,
holds, and renders data and handles user interaction -- not whether the
interface is perceivable by assistive technology, whether the types are
sound, whether the API shape is well designed, or whether an injection
risk exists.

This is a reasoning lens loaded into the current review session as context,
the same way a proposal, design doc, or spec is loaded. It is not a
separate agent, and it never implements, edits, or runs anything -- the
command that loaded it (`/verify`, `/adversarial-review`, or a future
workflow stage) owns those actions and its own report format.

---

## Phase 0 -- Read before reasoning

No conclusion is valid without evidence from the actual codebase.
Skipping this produces reviews that miss the real problems.

1. Read the project's `AGENTS.md`, `README`, or equivalent, if present --
   these often document the intended state-management approach or
   component conventions.
2. Check the project's manifest and build config for the UI framework or
   libraries in use (if any), the styling approach, and the test tooling.
3. If the workspace reports semantic code navigation as available
   (`CE_CODE_NAV_AVAILABLE` set -- never assume this without checking;
   ce-harness only wires it up opportunistically), use it as the primary
   exploration tool: for the `codegraph` provider (check
   `CE_CODE_NAV_PROVIDER`), that means `codegraph_explore` -- name the
   components, hooks/composables/lifecycle functions, or call chains
   relevant to the change. Fall back to targeted Grep and Read when
   unavailable or insufficient. Either way, confirm anything cited as
   evidence against the actual current source before citing it -- this
   accelerates discovery, it never substitutes for reading the exact
   line you cite.

Then characterise the existing UI architecture by answering, from the
code itself:

1. **Component/module boundaries**: how is the UI divided (pages,
   features, atomic/shared components), and what convention governs what
   belongs where?
2. **State ownership**: what state is local to a component, what is
   shared (context, a store, URL/route state), and what is server state
   mirrored into the client? Is the distinction between these three
   deliberate or accidental?
3. **Data-fetching pattern**: where do requests originate (on mount, on a
   route change, on a user action), and is there an existing convention
   for loading/error/empty states, caching, or request deduplication?
4. **Rendering strategy**: is this client-rendered, server-rendered, or a
   hybrid? Does any code assume one when the project actually uses the
   other?
5. **Event and interaction handling**: how are user actions wired to state
   changes -- directly, through a dispatcher/store action, through a
   callback prop? Is there an existing convention?
6. **Styling approach**: co-located styles, a global stylesheet, a
   utility-class system, or CSS-in-JS -- and does the change follow it?
7. **Test approach**: what is tested (component behavior, rendered
   output, user interactions) and with what tool; what is mocked versus
   exercised for real?

Write a 3-5 sentence characterisation of what was observed. This is the
factual baseline for everything that follows.

---

## Phase 1 -- Classify the work

State both classifications explicitly.

### Scope

| Class | Meaning |
|---|---|
| **Incremental** | Fits existing component and state-management conventions. No new shared state, no new cross-cutting pattern. |
| **Structural** | Introduces a new shared component, a new state-management pattern, or a new data-fetching convention used by more than one place. |
| **Architectural refactor** | Changes the rendering strategy, the global state approach, or the routing model across the application. Should be a separate, explicit change. |

### Risk

| Risk | Indicators |
|---|---|
| **Low** | A new, isolated component or a local-state-only change; no other component depends on its output or shape. |
| **Medium** | Modifies a shared component, hook/composable, or piece of state with multiple consumers. |
| **High** | Changes the shape of widely-shared state, a widely-reused component's public props/contract, or introduces a new pattern other developers will copy. |

---

## Phase 2 -- Engineering principles

### State locality

State should live as close as possible to where it is read and changed.
Lifting state up has a real cost: every component between the state's
owner and its consumer now re-renders (or must be told not to), and the
data flow gets harder to trace. Lift state only when two sibling
components genuinely need to stay in sync -- not preemptively.

### Data flow direction and prop/interface stability

Prefer data flowing one direction (parent to child, or an explicit
action back up) over ad hoc mutation of shared structures from many
places. A component's public inputs (props, or their equivalent) are a
contract -- changing their shape is a **Medium/High** risk change, the
same as changing a function signature in backend code, because every
consumer is a caller.

### Rendering cost is a design signal, not an afterthought

Ask what causes a component to re-render, and whether that set of
triggers matches what actually needs to change. A component re-rendering
because of an unrelated state change is a design smell, not just a
performance nitpick -- it usually means state is scoped too broadly or a
value is being recreated on every render when it could be stable. Flag
this without assuming any particular framework's specific memoization
mechanism; the principle (minimize what a given state change forces to
recompute) applies regardless of API.

### Every async boundary needs all three states

Any place data is fetched or a promise is awaited needs a deliberate
answer for loading, error, and empty-result states -- not just the happy
path. A missing error state is not a cosmetic gap; it means the UI can
get stuck or show stale/incorrect information with no signal to the
user.

### Render defensively against unexpected server responses

Check a network response for absence, unexpected shape, or partial data
before rendering it, rather than assuming it always matches the expected
type. This is runtime defensiveness, not a security control: the
question is what renders if a field is missing or a request
half-succeeds, in the same direction backend code should question its
own external inputs -- not whether the server should be trusted, which
is security-reviewer's trust-boundary reasoning applied in the other
direction (the server verifying the client). Also distinct from
type-soundness review, which is typescript-engineer's scope.

### Testability of UI logic

Logic that decides *what* to render (formatting, derived values,
validation) is easier to test when it is extractable from the code that
decides *how* to render it. If a piece of business logic can only be
exercised by rendering the whole component and simulating interaction,
that is a design signal the logic could be separated, not evidence that
UI logic is inherently hard to test.

---

## Phase 3 -- Frontend-specific failure modes

- **Stale closures over props/state**: a callback or effect capturing an
  old value of a prop or piece of state because it was created before
  the value changed and never recreated or re-read. Trace what a
  callback actually closes over, not what it appears to reference.
- **Race conditions in data fetching**: a second request started before
  the first resolves, and the first response arrives *after* the second,
  overwriting newer data with stale data. Check whether requests are
  cancelled, ignored-if-stale, or otherwise sequenced -- do not assume
  "later request, later response" ordering is guaranteed.
- **List identity / reordering bugs**: state or DOM nodes attaching to
  the wrong list item after the list is reordered, filtered, or
  paginated, because items are identified by position instead of a
  stable identity.
- **Derived state duplicated into stored state**: a value that could be
  computed from existing state or props instead stored separately, which
  then goes stale the moment its inputs change without a corresponding
  update path.
- **Lifecycle/effect overuse for synchronous derivations**: reaching for
  an effect or lifecycle hook to compute a value that could be computed
  directly during render, introducing an extra render pass and a window
  where the UI shows a stale value.
- **Controlled/uncontrolled input ambiguity**: a form input whose value
  is sometimes driven by state and sometimes by the DOM itself, causing
  inconsistent behavior on reset, external updates, or validation.
- **Uncancelled subscriptions and timers**: a subscription, interval, or
  pending request started on mount that is never cleaned up on unmount,
  causing state updates on an unmounted component or duplicate
  side effects on remount.

---

## Phase 4 -- Review checklist and evidence expectations

- Cite the exact component/file and the specific prop, state field, or
  effect responsible -- "this component might re-render too often" is
  not a finding; "X re-renders on every keystroke in Y because Z is
  recreated each render and passed as a prop" is.
- For a race-condition or stale-data finding, trace the actual request
  sequence (what can start, in what order, what can resolve out of
  order) rather than asserting a race is possible without a concrete
  trigger.
- For a missing-state finding (loading/error/empty), identify exactly
  which of the three is missing and what the user sees instead.
- Do not file accessibility findings (missing labels, keyboard
  operability, contrast) under this lens -- note them for
  accessibility-reviewer instead.
- Do not file type-soundness findings (unsound generics, unsafe
  assertions) under this lens -- note them for typescript-engineer
  instead.
- Do not file API/data-contract design findings under this lens -- note
  them for backend-developer instead.

---

## Lens checks

State locality and lifting cost; data-flow direction and prop/interface
stability as a contract; rendering-cost reasoning without assuming a
specific framework API; completeness of loading/error/empty states;
defensive handling of network responses; testability of extracted UI
logic; stale-closure, race-condition, list-identity, derived-state, and
lifecycle-overuse failure modes; cleanup of subscriptions/timers on
unmount.
