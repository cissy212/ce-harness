import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retrieveCandidates } from "../../src/core/retrieval.js";

/**
 * End-to-end fixtures for the seven concrete scenarios the Retrieval
 * Contract design was tested against. One shared fixture (a small
 * "monorepo" Git repository plus a matching durable OpenSpec store) is
 * built once and reused across scenarios, since several of them
 * (same-files-touched, monorepo-scoping, hundreds-of-changes) need to
 * coexist realistically in the same project to be meaningful -- a real
 * caller queries one project's history, not seven isolated toy fixtures.
 */

let repoDir: string;
let durableRoot: string;

async function writeFixtureFile(root: string, relPath: string, content: string): Promise<void> {
  const full = join(root, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

beforeAll(async () => {
  // --- Git repository: a small monorepo with two unrelated apps ---
  repoDir = await mkdtemp(join(tmpdir(), "ce-harness-retrieval-e2e-repo-"));
  await execa("git", ["init", "--initial-branch=main", repoDir]);
  await execa("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
  await execa("git", ["-C", repoDir, "config", "user.name", "Test User"]);

  await mkdir(join(repoDir, "apps", "billing"), { recursive: true });
  await writeFile(join(repoDir, "apps", "billing", "refund.ts"), "export function refund() {}\n", "utf8");
  await execa("git", ["-C", repoDir, "add", "."]);
  await execa("git", ["-C", repoDir, "commit", "-m", "add refund flow to billing app"]);

  await writeFile(join(repoDir, "apps", "billing", "refund.ts"), "export function refund() { /* v2 */ }\n", "utf8");
  await execa("git", ["-C", repoDir, "add", "."]);
  await execa("git", ["-C", repoDir, "commit", "-m", "harden refund flow against double-submits"]);

  await mkdir(join(repoDir, "apps", "notifications"), { recursive: true });
  await writeFile(join(repoDir, "apps", "notifications", "email.ts"), "export function sendEmail() {}\n", "utf8");
  await execa("git", ["-C", repoDir, "add", "."]);
  await execa("git", ["-C", repoDir, "commit", "-m", "add refund notice email to notifications app"]);

  // --- Durable OpenSpec store ---
  durableRoot = await mkdtemp(join(tmpdir(), "ce-harness-retrieval-e2e-store-"));

  // Scenario 3: a matching current spec.
  await writeFixtureFile(
    durableRoot,
    "openspec/specs/billing/spec.md",
    "# Billing\n\nHandles refunds via apps/billing/refund.ts. Refund tokens expire after 24h.\n",
  );

  // Scenario 1 + 2: an archived change touching the same file, with an adversarial-review finding.
  await writeFixtureFile(
    durableRoot,
    "openspec/changes/archive/2025-11-01-add-refund-flow/proposal.md",
    "Add a refund flow to the billing app, touching apps/billing/refund.ts.\n",
  );
  await writeFixtureFile(
    durableRoot,
    "openspec/changes/archive/2025-11-01-add-refund-flow/tasks.md",
    "- [x] implement apps/billing/refund.ts\n",
  );
  await writeFixtureFile(
    durableRoot,
    "openspec/changes/archive/2025-11-01-add-refund-flow/reports/2025-11-02-adversarial-review.md",
    "Found a possible double-submit race condition in the refund flow.\n",
  );

  // Scenario 7: a historical decision that current code no longer follows
  // (nothing in this fixture claims it does -- retrieval must surface it
  // as-is regardless).
  await writeFixtureFile(
    durableRoot,
    "openspec/changes/archive/2020-01-01-use-sync-writes/design.md",
    "Decision: refund records are always written synchronously for durability.\n",
  );

  // Scenario 4: terminology the current spec uses ("credential verification"),
  // deliberately never mentioning the newer term ("auth") a future query might use.
  await writeFixtureFile(
    durableRoot,
    "openspec/specs/identity/spec.md",
    "# Identity\n\nPerforms credential verification before granting access.\n",
  );

  // Scenario 6: hundreds of archived changes, almost all unrelated noise,
  // to prove the relevant ones (above) still surface and the call stays fast.
  for (let i = 0; i < 250; i++) {
    const day = String((i % 27) + 1).padStart(2, "0");
    await writeFixtureFile(
      durableRoot,
      `openspec/changes/archive/2019-03-${day}-noise-change-${i}/proposal.md`,
      `Unrelated housekeeping change number ${i}, touching apps/notifications/email.ts.\n`,
    );
  }
}, 60_000);

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(durableRoot, { recursive: true, force: true });
});

describe("Retrieval Contract -- 7 concrete scenarios", () => {
  it("1. same files touched by an old feature: Git history and the archived change both surface", async () => {
    const result = await retrieveCandidates({
      durableRoot,
      repositoryPath: repoDir,
      paths: ["apps/billing/refund.ts"],
      limit: 20,
    });

    const commitSubjects = result.candidates
      .filter((c) => c.type === "git-commit")
      .map((c) => c.excerpt);
    expect(commitSubjects.some((s) => s?.includes("harden refund flow"))).toBe(true);
    expect(commitSubjects.some((s) => s?.includes("add refund flow to billing"))).toBe(true);

    const proposal = result.candidates.find((c) => c.type === "change-proposal");
    expect(proposal).toBeDefined();
    expect(proposal!.status).toBe("historical");
  });

  it("2. related archived adversarial-review finding surfaces, tagged historical, with low-noise matching", async () => {
    const result = await retrieveCandidates({ durableRoot, keywords: ["race condition"], limit: 20 });
    const report = result.candidates.find((c) => c.type === "change-report");
    expect(report).toBeDefined();
    expect(report!.status).toBe("historical");
    expect(report!.path).toContain("adversarial-review");
  });

  it("3. matching current spec ranks as 'current' with strong confidence", async () => {
    const result = await retrieveCandidates({ durableRoot, domain: "billing", keywords: ["refund"], limit: 20 });
    const spec = result.candidates.find((c) => c.type === "spec");
    expect(spec).toBeDefined();
    expect(spec!.status).toBe("current");
  });

  it("4. renamed terminology: the new term alone finds nothing; passing both terms bridges it", async () => {
    const newTermOnly = await retrieveCandidates({ durableRoot, keywords: ["auth"], sources: ["specs"] });
    expect(newTermOnly.candidates.some((c) => c.path.includes("identity"))).toBe(false);

    const bothTerms = await retrieveCandidates({
      durableRoot,
      keywords: ["auth", "credential verification"],
      sources: ["specs"],
    });
    expect(bothTerms.candidates.some((c) => c.path.includes("identity"))).toBe(true);
  });

  it("5. monorepo with unrelated apps: an unscoped query returns both apps' commits, a scoped one demotes the other app", async () => {
    const unscoped = await retrieveCandidates({
      durableRoot,
      repositoryPath: repoDir,
      keywords: ["refund"],
      sources: ["gitHistory"],
      limit: 20,
    });
    const unscopedApps = unscoped.candidates.map((c) => c.excerpt ?? "");
    expect(unscopedApps.some((e) => e.includes("billing app"))).toBe(true);
    expect(unscopedApps.some((e) => e.includes("notifications app"))).toBe(true);

    const scoped = await retrieveCandidates({
      durableRoot,
      repositoryPath: repoDir,
      keywords: ["refund"],
      paths: ["apps/billing/some-other-file.ts"],
      sources: ["gitHistory"],
      limit: 20,
    });
    const billingIndex = scoped.candidates.findIndex((c) => c.excerpt?.includes("billing app"));
    const notificationsIndex = scoped.candidates.findIndex((c) => c.excerpt?.includes("notifications app"));
    expect(billingIndex).toBeGreaterThanOrEqual(0);
    expect(notificationsIndex).toBeGreaterThanOrEqual(0);
    expect(billingIndex).toBeLessThan(notificationsIndex);
  });

  it("6. hundreds of archived changes: stays fast, respects the output cap, and still surfaces the relevant one", async () => {
    const start = Date.now();
    const result = await retrieveCandidates({ durableRoot, keywords: ["refund"], sources: ["archivedChanges"] });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(10_000);
    expect(result.candidates.length).toBeLessThanOrEqual(15); // default limit
    expect(result.candidates.some((c) => c.path.includes("add-refund-flow"))).toBe(true);
    // The 250 noise changes never mention "refund" -- none of them should appear.
    expect(result.candidates.every((c) => !c.path.includes("noise-change"))).toBe(true);
  });

  it("7. historical decision contradicted by current code: retrieval surfaces it as historical, and never judges it", async () => {
    const result = await retrieveCandidates({
      durableRoot,
      keywords: ["synchronously"],
      sources: ["archivedChanges"],
    });
    const decision = result.candidates.find((c) => c.path.includes("use-sync-writes"));
    expect(decision).toBeDefined();
    expect(decision!.status).toBe("historical");
    expect(decision!.date).toBe("2020-01-01T00:00:00.000Z");
    // The contract carries no verification/contradiction field at all --
    // reconciling this against current code is explicitly the calling
    // workflow's responsibility, never this module's.
    expect(Object.keys(decision!)).not.toContain("verified");
  });
});
