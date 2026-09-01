import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeChangeRoot,
  formatArtifactChecklist,
  listActiveChanges,
  summarizeChangeArtifacts,
} from "../../src/core/activeChange.js";

/** Writes `content` to `relPath` under `root`, creating parent directories as needed. */
async function writeFixtureFile(root: string, relPath: string, content: string): Promise<void> {
  const full = join(root, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

describe("activeChange (durable-store discovery for `ce status` / `ce open --change`)", () => {
  let durableRoot: string;

  beforeEach(async () => {
    durableRoot = await mkdtemp(join(tmpdir(), "ce-harness-active-change-"));
  });

  afterEach(async () => {
    await rm(durableRoot, { recursive: true, force: true });
  });

  describe("listActiveChanges", () => {
    it("returns an empty list when the durable store doesn't exist yet", async () => {
      const missingRoot = join(durableRoot, "does-not-exist");
      expect(await listActiveChanges(missingRoot)).toEqual([]);
    });

    it("returns an empty list when openspec/changes/ doesn't exist yet (a fresh store with nothing proposed)", async () => {
      expect(await listActiveChanges(durableRoot)).toEqual([]);
    });

    it("lists active change directory names, sorted", async () => {
      await writeFixtureFile(durableRoot, "openspec/changes/zeta-change/proposal.md", "z\n");
      await writeFixtureFile(durableRoot, "openspec/changes/alpha-change/proposal.md", "a\n");

      expect(await listActiveChanges(durableRoot)).toEqual(["alpha-change", "zeta-change"]);
    });

    it("excludes the archive/ directory", async () => {
      await writeFixtureFile(durableRoot, "openspec/changes/contacts-email-notes/proposal.md", "x\n");
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/archive/2026-05-12-add-user-auth/proposal.md",
        "y\n",
      );

      expect(await listActiveChanges(durableRoot)).toEqual(["contacts-email-notes"]);
    });

    it("excludes non-directory entries under openspec/changes/", async () => {
      await writeFixtureFile(durableRoot, "openspec/changes/real-change/proposal.md", "x\n");
      await writeFixtureFile(durableRoot, "openspec/changes/.stray-file", "not a change\n");

      expect(await listActiveChanges(durableRoot)).toEqual(["real-change"]);
    });
  });

  describe("activeChangeRoot", () => {
    it("resolves <durableRoot>/openspec/changes/<name>, matching the layout retrieval.ts and every workflow template assume", () => {
      expect(activeChangeRoot("/store", "contacts-email-notes")).toBe(
        join("/store", "openspec", "changes", "contacts-email-notes"),
      );
    });
  });

  describe("summarizeChangeArtifacts", () => {
    it("reports every artifact absent for a change directory with nothing in it yet", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "empty-change");
      await mkdir(changeRoot, { recursive: true });

      const summary = await summarizeChangeArtifacts(changeRoot);
      expect(summary).toEqual({
        explore: { present: false },
        enrich: { present: false },
        proposal: { present: false },
        design: { present: false },
        tasks: { present: false },
        specs: [],
        reports: [],
      });
    });

    it("detects explore.md, proposal.md, design.md, and tasks.md by existence", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "my-change");
      await writeFixtureFile(durableRoot, "openspec/changes/my-change/explore.md", "findings\n");
      await writeFixtureFile(durableRoot, "openspec/changes/my-change/proposal.md", "why\n");
      await writeFixtureFile(durableRoot, "openspec/changes/my-change/design.md", "how\n");
      await writeFixtureFile(durableRoot, "openspec/changes/my-change/tasks.md", "steps\n");

      const summary = await summarizeChangeArtifacts(changeRoot);
      expect(summary.explore.present).toBe(true);
      expect(summary.proposal.present).toBe(true);
      expect(summary.design.present).toBe(true);
      expect(summary.tasks.present).toBe(true);
      expect(summary.enrich.present).toBe(false);
    });

    it("reads enrich.md's own Status line when present", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "my-change");
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/my-change/enrich.md",
        "# Requirement Understanding: my-change\n\n**Status:** ready\n**Last updated:** 2026-05-12\n",
      );

      const summary = await summarizeChangeArtifacts(changeRoot);
      expect(summary.enrich).toEqual({ present: true, status: "ready" });
    });

    it("reads a needs-clarification enrich.md Status too", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "my-change");
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/my-change/enrich.md",
        "**Status:** needs-clarification\n",
      );

      const summary = await summarizeChangeArtifacts(changeRoot);
      expect(summary.enrich).toEqual({ present: true, status: "needs-clarification" });
    });

    it("omits status when enrich.md exists but has no recognizable Status line", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "my-change");
      await writeFixtureFile(durableRoot, "openspec/changes/my-change/enrich.md", "no status here\n");

      const summary = await summarizeChangeArtifacts(changeRoot);
      expect(summary.enrich).toEqual({ present: true });
    });

    it("lists delta-spec capability directory names under specs/, sorted", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "my-change");
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/my-change/specs/contact-creation/spec.md",
        "delta\n",
      );
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/my-change/specs/contacts-directory/spec.md",
        "delta\n",
      );

      const summary = await summarizeChangeArtifacts(changeRoot);
      expect(summary.specs).toEqual(["contact-creation", "contacts-directory"]);
    });

    it("lists report filenames under reports/", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "my-change");
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/my-change/reports/2026-05-12-verify.md",
        "report\n",
      );

      const summary = await summarizeChangeArtifacts(changeRoot);
      expect(summary.reports).toEqual(["2026-05-12-verify.md"]);
    });

    it("never throws for a change directory that doesn't exist at all", async () => {
      const missingChangeRoot = join(durableRoot, "openspec", "changes", "does-not-exist");
      await expect(summarizeChangeArtifacts(missingChangeRoot)).resolves.toEqual({
        explore: { present: false },
        enrich: { present: false },
        proposal: { present: false },
        design: { present: false },
        tasks: { present: false },
        specs: [],
        reports: [],
      });
    });
  });

  describe("formatArtifactChecklist", () => {
    it("renders a full checklist with all artifacts present", () => {
      const line = formatArtifactChecklist({
        explore: { present: true },
        enrich: { present: true, status: "ready" },
        proposal: { present: true },
        design: { present: true },
        tasks: { present: true },
        specs: ["contact-creation", "contacts-directory"],
        reports: ["2026-05-12-verify.md"],
      });

      expect(line).toBe(
        "explore ✓  enrich ✓ (ready)  proposal ✓  design ✓  tasks ✓  " +
          "specs (2: contact-creation, contacts-directory)  reports (1)",
      );
    });

    it("marks missing artifacts with ✗ and omits specs/reports when there are none", () => {
      const line = formatArtifactChecklist({
        explore: { present: true },
        enrich: { present: false },
        proposal: { present: false },
        design: { present: false },
        tasks: { present: false },
        specs: [],
        reports: [],
      });

      expect(line).toBe("explore ✓  enrich ✗  proposal ✗  design ✗  tasks ✗");
    });

    it("omits the parenthetical status when enrich.md exists but its status couldn't be read", () => {
      const line = formatArtifactChecklist({
        explore: { present: false },
        enrich: { present: true },
        proposal: { present: false },
        design: { present: false },
        tasks: { present: false },
        specs: [],
        reports: [],
      });

      expect(line).toBe("explore ✗  enrich ✓  proposal ✗  design ✗  tasks ✗");
    });
  });
});
