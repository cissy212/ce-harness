---
name: security-reviewer
description: Use when reasoning about security -- trust boundaries, input validation, injection, authentication/authorization, secrets handling, and dependency/supply-chain risk. Applies to any language or stack; security reasoning is about where trust is assumed versus verified, not about a specific framework's built-in protections.
---

# Security Reviewer

A reasoning lens for finding where code trusts an input, an identity, or
a dependency that has not actually been verified. It reasons only from
evidence already gathered -- the code, the diff, configuration, and any
existing scan output -- and never runs a scanner, exploit, or live
request itself.

**Scope note**: this lens does not review general code architecture,
module boundaries, or maintainability (that is the backend-developer
lens's scope), does not review accessibility (that is the
accessibility-reviewer lens's scope), and does not go deep on
type-system mechanics (that is the typescript-engineer lens's scope) --
though a type-soundness hole that enables a trust-boundary violation is
worth recording here for its security consequence. Operational
concerns of pipelines (idempotency, retries, concurrency) belong to
pipeline-data-engineer, unless the operational gap itself has a security
consequence (e.g. a retried side effect that duplicates a privileged
action) -- in that case, record the security consequence here and defer
the operational mechanics to that lens. Component architecture and
rendering behavior belong to the frontend-developer lens's scope; when
client-side code renders output without escaping it, the injection
consequence and severity are this lens's to record, while the
component-level code-quality observation belongs to frontend-developer.

This is a reasoning lens loaded into the current review session as
context, the same way a proposal, design doc, or spec is loaded. It is
not a separate agent, and it never implements, edits, or runs anything --
the command that loaded it (`/verify`, `/adversarial-review`, or a future
workflow stage) owns those actions and its own report format.

---

## Phase 0 -- Read before reasoning

No conclusion is valid without evidence from the actual codebase.
Skipping this produces reviews that miss the real problems.

1. Read the project's `AGENTS.md`, `README`, or equivalent, and any
   documented threat model, security policy, or compliance requirement
   (e.g. PCI, SOC 2, HIPAA) -- these override general defaults below.
2. Identify every place external input enters the system: HTTP request
   bodies/params/headers, file uploads, webhook payloads, queue
   messages, CLI arguments, environment variables, and third-party API
   responses. This is the actual attack surface -- reason from it, not
   from what merely "feels risky."
3. Check how secrets and credentials are managed today (environment
   variables, a secret manager, a vault, checked-in configuration)
   before assuming a convention.
4. If the workspace reports semantic code navigation as available
   (`CE_CODE_NAV_AVAILABLE` set -- never assume this without checking;
   ce-harness only wires it up opportunistically), use it: for the
   `codegraph` provider (check `CE_CODE_NAV_PROVIDER`), that means
   `codegraph_explore` to trace how external input flows through the
   codebase. Fall back to targeted Grep and Read when unavailable or
   insufficient. Either way, confirm anything cited as evidence against
   the actual current source before citing it -- this accelerates
   discovery, it never substitutes for reading the exact line you cite.

Then characterise the trust model:

1. **Authentication mechanism**: session, token, mTLS, or another
   scheme -- and is it applied consistently across entry points?
2. **Authorization model**: roles, per-resource ownership checks, ACLs
   -- and where is each actually enforced (middleware, per-handler,
   database row-level)?
3. **Existing security tooling**: is there SAST, dependency-scanning, or
   secret-scanning output already available to read as evidence?

Write a 3-5 sentence characterisation of what was observed. This is the
factual baseline for everything that follows.

---

## Phase 1 -- Classify the work

State both classifications explicitly.

### Scope

| Class | Meaning |
|---|---|
| **Incremental** | A change entirely within an already-validated boundary; no new external input. |
| **Structural** | A new external input, endpoint, or entry point, or a new trust relationship (e.g. a new third-party integration). |
| **Architectural refactor** | A change to the authentication or authorization model itself, or to how secrets are managed. Should be a separate, explicit change. |

### Risk

| Risk | Indicators |
|---|---|
| **Low** | No new external input; no privilege change. |
| **Medium** | A new, validated input, or a change touching an existing authorization check. |
| **High** | A new unauthenticated or lower-trust entry point, a change to how identity or permissions are established, or anything touching secrets or cryptography. |

---

## Phase 2 -- Reasoning principles

### Trust boundaries are the unit of analysis

For any function, ask: does this trust its caller, or does it verify the
data independently? The pattern to find is data crossing from a
less-trusted context (user input, a third-party response) into a
more-trusted one (a query, a shell command, a file path, a template)
without validation in between -- this holds regardless of language or
framework.

### Validate at the boundary, not by convention

Input should be validated (type, shape, range, and an allow-list where
possible) at the point it enters the trusted side of the system -- never
assumed clean because "the client already checks it." The client is not
a trust boundary; the server or service boundary is.

### Authorization is an explicit check, not an implicit filter

Confirm that access control is an explicit, enforced check -- "is this
specific user allowed to act on this specific resource" -- rather than
an implicit one, such as relying on an identifier being hard to guess,
or filtering a list in the response without checking ownership on the
underlying fetch itself.

### Least privilege as a default question

For any credential, token, or service account, ask what the minimum
scope actually needed is, and whether what's granted matches it. Overly
broad scope is a finding on its own, even with no known exploit path
yet -- it's the blast radius of a future compromise, not just today's
behavior.

### Secrets have a full lifecycle

A secrets finding is not only "is this exposed" -- it also includes
creation, storage, transmission, rotation, and revocation. Ask whether a
secret can be rotated without a code change, and whether any path logs,
echoes, or persists it in plaintext.

### Defense in depth, not a single gate

A sensitive operation relying on exactly one control (only client-side
validation, only a network-level restriction) is a single point of
failure. Note where a second, independent control would catch the same
class of bug, even if the first control is currently working correctly.

### Third-party input is still input

A dependency's behavior, a webhook sender, or an upstream API response
is external input, not a trusted internal value, merely because it comes
from a "known" service. Verify signatures or checksums where the
protocol supports them, and do not assume a response is well-formed or
non-malicious by default.

---

## Phase 3 -- Failure modes

- **Injection** (the general, language-agnostic pattern): a string built
  from external input interpreted as code, a query, a command, or markup
  by another system without parameterization or escaping -- SQL/NoSQL
  query construction, shell command construction, template rendering
  with unescaped output, LDAP/XPath queries, or deserializing untrusted
  data into executable objects.
- **Broken object-level authorization (IDOR-style)**: an identifier
  supplied by the client (a URL parameter, a body field) used to fetch
  or mutate a resource without confirming the current user actually
  owns or can access that specific resource.
- **Authentication bypass surfaces**: default credentials, missing
  checks on routes assumed "not publicly reachable," or session/token
  validation applied inconsistently across entry points added at
  different times.
- **Secrets in the wrong place**: committed to version control, logged,
  embedded in client-shipped code, or passed through a channel (a URL
  query string, unencrypted storage) with weaker guarantees than the
  secret needs.
- **Server-side request forgery (SSRF)**: server-side code fetching a
  URL derived from user input without restricting scheme, host, or IP
  range -- especially against internal or metadata endpoints.
- **Insecure deserialization**: parsing untrusted data with a
  deserializer capable of instantiating arbitrary types or executing
  code as a side effect of parsing.
- **Cryptographic misuse**: home-rolled cryptography, weak or legacy
  algorithms/modes, static IVs or nonces, or comparing secrets with a
  non-constant-time comparison.
- **Dependency and supply-chain risk**: newly introduced dependencies
  with excessive install-time permissions or scripts, unpinned versions
  for security-sensitive packages, or versions already flagged as
  vulnerable by existing tooling output.

---

## Phase 4 -- Review checklist and evidence expectations

- Cite the exact untrusted-input source and the exact sink it reaches
  (file:line for both), tracing the path between them. A finding with no
  concrete path from input to consequence is speculative (Low
  confidence), not a confirmed defect.
- For an authorization finding, cite the specific check that is missing
  or misapplied -- "this seems unprotected" is not sufficient.
- For a secrets finding, cite exactly where the value is defined/read
  and every place it is confirmed to flow to (a log line, a response
  body, an error message).
- Track exploitability and impact explicitly: a theoretical issue with
  no plausible trigger path is still worth recording, but state that
  distinction rather than treating every finding as equally urgent.
- Never attempt to actually exploit, scan, or send a live request as
  part of this review. Reason only from code, diff, configuration, and
  any already-existing scan output; if confirming a finding would
  require doing one of those things, state that explicitly as a
  limitation instead.

---

## Lens checks

Trust-boundary identification across every external input;
validate-at-the-boundary discipline; authorization as an explicit
per-resource check rather than implicit filtering; least-privilege
evaluation for credentials and tokens; full secrets lifecycle awareness;
defense-in-depth versus single-gate reliance; injection, IDOR, SSRF,
deserialization, and cryptographic-misuse pattern recognition;
input-to-sink evidence tracing with explicit confidence calibration; no
live exploitation or scanning.
