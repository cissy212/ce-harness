---
name: accessibility-reviewer
description: Use when reviewing user-facing markup or UI code for accessibility -- semantic structure, ARIA usage, keyboard operability, focus management, and color/contrast. Applies to any web UI regardless of framework or component library; grounded in HTML semantics and WCAG success criteria rather than any framework's conventions.
---

# Accessibility Reviewer

A reasoning lens focused narrowly on one question: can every person,
regardless of input method (pointer, keyboard, switch, voice) or sensory
ability (sighted, low-vision, blind, hard-of-hearing), perceive and
operate this interface? It is grounded in HTML semantics, ARIA, and WCAG
success criteria -- not in general UI quality, and not in any particular
component library's conventions.

**Scope note**: this lens does not review component architecture, state
management, or rendering behavior (that is the frontend-developer lens's
scope), does not review the type system (that is the typescript-engineer
lens's scope), and does not review injection or authorization risk (that
is the security-reviewer lens's scope). If a finding is really about
component structure and only
incidentally touches accessibility (e.g. "this component is hard to
reason about, and also missing a label"), split it: the structural
observation belongs to frontend-developer, the missing label belongs
here.

This is a reasoning lens loaded into the current review session as
context, the same way a proposal, design doc, or spec is loaded. It is
not a separate agent, and it never implements, edits, or runs anything --
the command that loaded it (`/verify`, `/adversarial-review`, or a future
workflow stage) owns those actions and its own report format.

---

## Phase 0 -- Read before reasoning

No conclusion is valid without evidence from the actual codebase.
Skipping this produces reviews that miss the real problems.

1. Read the project's `AGENTS.md`, `README`, or equivalent for any
   documented accessibility target (a WCAG conformance level, a legal
   requirement such as ADA or EN 301 549, or an internal standard) --
   these override the general WCAG 2.2 AA baseline this lens otherwise
   assumes.
2. Identify what actually reaches the browser: if reviewing component
   code rather than raw markup, trace what HTML and ARIA attributes the
   component actually produces -- do not infer accessibility from a
   component's name or its framework category alone.
3. Check for existing accessibility tooling (an axe/pa11y config, an
   eslint accessibility plugin, prior audit output) and treat any
   existing findings as evidence to read, not something to re-derive
   from scratch.
4. If a `.codegraph/` index exists at or above the project root, use
   `codegraph_explore` to find the components or templates relevant to
   the change. Fall back to targeted Grep and Read otherwise.

Then characterise what exists today:

1. **Interactive elements**: what forms, buttons, links, and custom
   widgets (menus, dialogs, tabs, sliders) are present, and are they
   built from native HTML elements or custom-built with divs/spans and
   ARIA?
2. **Existing focus-management patterns**: how do modals, route changes,
   and dynamic content updates currently handle focus, if at all?
3. **Color and theming system**: is contrast handled by a defined
   palette/design-token system, or set ad hoc per component?
4. **Heading and landmark structure**: does the page have a logical
   heading hierarchy and landmark regions already, or none at all?

Write a 3-5 sentence characterisation of what was observed. This is the
factual baseline for everything that follows.

---

## Phase 1 -- Classify the work

State both classifications explicitly.

### Scope

| Class | Meaning |
|---|---|
| **Incremental** | A content, copy, or styling change with no new interaction pattern. |
| **Structural** | A new interactive widget, form, or navigation pattern. |
| **Architectural refactor** | A new component-library or design-system pattern that will be reused across many screens, making its accessibility contract load-bearing for everything built on it. |

### Risk

| Risk | Indicators |
|---|---|
| **Low** | Static content, text, or purely visual styling with no interaction change. |
| **Medium** | A new form or interactive control built from native HTML elements. |
| **High** | A custom-built widget reimplementing native semantics or keyboard behavior (custom dropdown, modal, tabs, drag-and-drop) -- these are exactly where native behavior is easiest to lose. |

---

## Phase 2 -- Reasoning principles

### Native-first

Prefer a native HTML element with built-in semantics and keyboard
behavior over recreating one with generic elements, ARIA, and custom
JavaScript. Every reimplementation is a chance to omit a behavior the
native element gave you for free.

### ARIA is a promise, not decoration

Adding a `role` or `aria-*` attribute creates an obligation to implement
the full behavior that role implies (keyboard model, state changes,
focus behavior). A role without the matching behavior is worse than no
role at all, because it tells assistive technology the element behaves
like something it does not. Never treat ARIA attributes as a way to
silence a linter without checking the behavioral contract they declare.

### Reason about the accessibility tree, not the screen

For each meaningful element, ask what is exposed to assistive
technology: its accessible name, role, value, and state. A visual review
alone (does it look right?) cannot answer this -- reason from the actual
markup and attributes about what a screen reader would announce.

### Operability without a pointer

Every interactive element must be reachable and operable using the
keyboard alone, in an order that matches the visual/logical order. Trace
actual tab order and key handlers; do not assume default browser
behavior survives once JavaScript intercepts events (a `click` handler
on a non-interactive element, for example, does not become
keyboard-operable on its own).

### Focus is state, and state needs management

Every interaction that changes what's on screen in a major way (opening
a dialog, navigating, removing the currently-focused element) needs a
deliberate answer to "where does focus go now?" Losing focus context
(reset to the top of the page, or to nothing) is a common and disruptive
failure for keyboard and screen-reader users.

### Color and contrast are two independent failure modes

"Text is hard to read" (contrast ratio) and "meaning is conveyed by
color alone" (e.g. only a red border indicates an error) are two
distinct WCAG concerns. Check both independently; passing one says
nothing about the other.

### Evidence has a ceiling without a runtime check

Some questions (what does a screen reader actually announce, does this
element receive real keyboard focus in a browser) cannot be fully
answered by reading source code. When the answer would require an
assistive-technology or browser check that hasn't been done, say so
explicitly as an evidence gap rather than asserting a confident answer.

---

## Phase 3 -- Failure modes (WCAG-grounded)

- **Missing or generic accessible names** -- icon-only buttons with no
  label, links reading "click here," images with no meaningful `alt`, or
  decorative images with a non-empty `alt` adding noise. (WCAG 1.1.1,
  2.4.4, 2.4.9, 4.1.2)
- **Keyboard traps or unreachable controls** -- an element that can be
  focused but not un-focused via keyboard, or an interactive element
  that a keyboard user simply cannot reach. (WCAG 2.1.1, 2.1.2)
- **Focus not managed on dynamic transitions** -- dialogs that open
  without moving focus into them, content removal that leaves focus on
  a now-detached element. (WCAG 2.4.3, 2.4.7, 4.1.2)
- **Custom widgets missing the keyboard model their role implies** --
  e.g. a `tablist`/`tab` pattern with no arrow-key navigation, a custom
  `dialog` with no escape-to-close or focus trap. (WCAG 4.1.2, 2.1.1)
- **Insufficient contrast** -- text or meaningful UI components below
  the required contrast ratio against their background, computed with
  the actual relative-luminance formula rather than an eyeballed guess.
  (WCAG 1.4.3, 1.4.11)
- **Status and error messages that are visual-only** -- validation
  feedback or live-updating status text with no mechanism (e.g. a live
  region) to reach assistive technology that isn't looking at that part
  of the screen. (WCAG 4.1.3)
- **Heading/landmark structure that doesn't reflect content** --
  headings skipped or chosen for visual size rather than hierarchy,
  breaking screen-reader structural navigation. (WCAG 1.3.1, 2.4.6)
- **Motion with no reduced-motion accommodation** -- animation that
  cannot be disabled or reduced for users who have indicated a
  preference against it. (WCAG 2.3.3)

---

## Phase 4 -- Review checklist and evidence expectations

- Every finding must cite the specific WCAG success criterion number --
  "this is inaccessible" is not a finding; "this icon button has no
  accessible name (WCAG 4.1.2)" is.
- Cite the exact markup or attribute (or its confirmed absence) at the
  specific file/line -- not a general impression of the component.
- Calibrate confidence honestly: something confirmed by reading the
  actual markup/ARIA output is High confidence; something that would
  require a screen reader or automated tool (axe, Lighthouse) to fully
  confirm is Medium or Low confidence, and should say so rather than
  being asserted as certain.
- For a contrast finding, show the actual foreground/background values
  and the computed ratio -- not an eyeballed "this looks low-contrast."
- Do not file component-architecture or state-management findings under
  this lens -- note them for frontend-developer instead.

---

## Lens checks

Native-first element choice; the ARIA-implies-behavior contract;
accessibility-tree reasoning distinct from visual review; keyboard
operability and tab order; focus management across dynamic transitions;
contrast and color-as-sole-indicator evaluated independently;
WCAG-success-criterion-cited findings; confidence calibrated against what
actually requires a runtime/assistive-technology check.
