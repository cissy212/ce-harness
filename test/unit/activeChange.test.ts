import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeChangeRoot,
  formatArtifactChecklist,
  listActiveChanges,
  listArchivedChanges,
  readChangeOwnership,
  resolveActiveChangesForWorkspace,
  resolveArchivedChangeForWorkspace,
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

  describe("readChangeOwnership", () => {
    it("returns null when the change has no ownership sidecar (legacy change)", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "legacy-change");
      await mkdir(changeRoot, { recursive: true });
      expect(await readChangeOwnership(changeRoot)).toBeNull();
    });

    it("reads project and issue from a valid sidecar", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "tagged-change");
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/tagged-change/.ce-workspace.yml",
        'project: "my-project"\nissue: "130"\n',
      );
      expect(await readChangeOwnership(changeRoot)).toEqual({ project: "my-project", issue: "130" });
    });

    it("returns null for a malformed sidecar instead of throwing", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "broken-change");
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/broken-change/.ce-workspace.yml",
        "not: [valid: yaml:\n",
      );
      expect(await readChangeOwnership(changeRoot)).toBeNull();
    });

    it("returns null when the sidecar is missing the expected fields", async () => {
      const changeRoot = join(durableRoot, "openspec", "changes", "incomplete-change");
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/incomplete-change/.ce-workspace.yml",
        "project: my-project\n",
      );
      expect(await readChangeOwnership(changeRoot)).toBeNull();
    });
  });

  describe("resolveActiveChangesForWorkspace", () => {
    it("falls back to the full list when no active change carries an ownership sidecar (fully legacy store)", async () => {
      await mkdir(join(durableRoot, "openspec", "changes", "alpha-change"), { recursive: true });
      await mkdir(join(durableRoot, "openspec", "changes", "beta-change"), { recursive: true });

      expect(await resolveActiveChangesForWorkspace(durableRoot, "my-project", "130")).toEqual([
        "alpha-change",
        "beta-change",
      ]);
    });

    it("narrows to only the change(s) owned by the given workspace when ownership is recorded", async () => {
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/issue-130-change/.ce-workspace.yml",
        'project: "my-project"\nissue: "130"\n',
      );
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/issue-143-change/.ce-workspace.yml",
        'project: "my-project"\nissue: "143"\n',
      );

      expect(await resolveActiveChangesForWorkspace(durableRoot, "my-project", "130")).toEqual([
        "issue-130-change",
      ]);
      expect(await resolveActiveChangesForWorkspace(durableRoot, "my-project", "143")).toEqual([
        "issue-143-change",
      ]);
    });

    it("keeps a legacy workspace's own untagged change usable after a different, newer workspace starts tagging its own changes (mixed legacy + tagged store)", async () => {
      // Workspace A's pre-existing legacy change: no ownership sidecar.
      await mkdir(join(durableRoot, "openspec", "changes", "legacy-a-change"), { recursive: true });
      // Workspace B's newer change, created after this mechanism existed.
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/tagged-b-change/.ce-workspace.yml",
        'project: "my-project"\nissue: "143"\n',
      );

      // Workspace A must still resolve its own legacy change -- never []
      // just because some *other* change in the shared store is tagged.
      expect(await resolveActiveChangesForWorkspace(durableRoot, "my-project", "130")).toEqual([
        "legacy-a-change",
      ]);
      // Workspace B resolves its own tagged change as before.
      expect(await resolveActiveChangesForWorkspace(durableRoot, "my-project", "143")).toEqual([
        "tagged-b-change",
      ]);
    });

    it("preserves ambiguity across multiple untagged candidates when this workspace has no exact match", async () => {
      await mkdir(join(durableRoot, "openspec", "changes", "legacy-one"), { recursive: true });
      await mkdir(join(durableRoot, "openspec", "changes", "legacy-two"), { recursive: true });
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/tagged-change/.ce-workspace.yml",
        'project: "my-project"\nissue: "143"\n',
      );

      expect(await resolveActiveChangesForWorkspace(durableRoot, "my-project", "130")).toEqual([
        "legacy-one",
        "legacy-two",
      ]);
    });

    it("never leaks a change owned by a different workspace, even when this workspace has none of its own (no untagged candidates either)", async () => {
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/issue-143-change/.ce-workspace.yml",
        'project: "my-project"\nissue: "143"\n',
      );

      expect(await resolveActiveChangesForWorkspace(durableRoot, "my-project", "130")).toEqual([]);
    });

    it("excludes archived changes the same way listActiveChanges does", async () => {
      await mkdir(join(durableRoot, "openspec", "changes", "archive", "2026-05-12-old-change"), {
        recursive: true,
      });

      expect(await resolveActiveChangesForWorkspace(durableRoot, "my-project", "130")).toEqual([]);
    });
  });

  describe("listArchivedChanges", () => {
    it("returns an empty list when nothing has been archived yet", async () => {
      expect(await listArchivedChanges(durableRoot)).toEqual([]);
    });

    it("lists archived changes, most-recently-archived first, with the date prefix stripped from name", async () => {
      await mkdir(join(durableRoot, "openspec", "changes", "archive", "2026-05-12-add-user-auth"), {
        recursive: true,
      });
      await mkdir(join(durableRoot, "openspec", "changes", "archive", "2026-09-02-addressbook-email-notes"), {
        recursive: true,
      });

      expect(await listArchivedChanges(durableRoot)).toEqual([
        { name: "addressbook-email-notes", archiveDirName: "2026-09-02-addressbook-email-notes" },
        { name: "add-user-auth", archiveDirName: "2026-05-12-add-user-auth" },
      ]);
    });
  });

  describe("resolveArchivedChangeForWorkspace", () => {
    it("returns null when nothing is archived", async () => {
      expect(await resolveArchivedChangeForWorkspace(durableRoot, "my-project", "130")).toBeNull();
    });

    it("returns null for a legacy archived change with no ownership sidecar", async () => {
      await mkdir(join(durableRoot, "openspec", "changes", "archive", "2026-05-12-legacy-change"), {
        recursive: true,
      });
      expect(await resolveArchivedChangeForWorkspace(durableRoot, "my-project", "130")).toBeNull();
    });

    it("resolves the archived change owned by this exact workspace", async () => {
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/archive/2026-09-02-addressbook-email-notes/.ce-workspace.yml",
        'project: "my-project"\nissue: "130"\n',
      );

      expect(await resolveArchivedChangeForWorkspace(durableRoot, "my-project", "130")).toEqual({
        name: "addressbook-email-notes",
        changeRoot: join(durableRoot, "openspec", "changes", "archive", "2026-09-02-addressbook-email-notes"),
      });
    });

    it("never resolves an archived change owned by a different workspace", async () => {
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/archive/2026-09-02-someone-elses-change/.ce-workspace.yml",
        'project: "my-project"\nissue: "143"\n',
      );

      expect(await resolveArchivedChangeForWorkspace(durableRoot, "my-project", "130")).toBeNull();
    });

    it("resolves the most recently archived one when this workspace owns more than one", async () => {
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/archive/2026-05-12-first-change/.ce-workspace.yml",
        'project: "my-project"\nissue: "130"\n',
      );
      await writeFixtureFile(
        durableRoot,
        "openspec/changes/archive/2026-09-02-second-change/.ce-workspace.yml",
        'project: "my-project"\nissue: "130"\n',
      );

      const resolved = await resolveArchivedChangeForWorkspace(durableRoot, "my-project", "130");
      expect(resolved?.name).toBe("second-change");
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
