import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { createTempRepo } from "../helpers/tempRepo.js";
import { computeWorktreeFingerprint } from "../../src/core/git.js";
import {
  checkStaleness,
  formatProvenanceSummary,
  isStageInvalid,
  readProvenance,
  type ProvenanceStage,
  type StalenessResult,
} from "../../src/core/provenance.js";

async function writeFixtureFile(root: string, relPath: string, content: string): Promise<void> {
  const full = join(root, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

describe("readProvenance", () => {
  let changeRoot: string;

  beforeEach(async () => {
    changeRoot = await mkdtemp(join(tmpdir(), "ce-harness-provenance-"));
  });

  afterEach(async () => {
    await rm(changeRoot, { recursive: true, force: true });
  });

  it("returns null when no sidecar exists (a change predating this mechanism)", async () => {
    expect(await readProvenance(changeRoot, "explore")).toBeNull();
  });

  it("reads a valid sidecar", async () => {
    await writeFixtureFile(
      changeRoot,
      ".ce-provenance-explore.yml",
      'commit: "abc123"\nfingerprint: "deadbeef1234"\nrecordedAt: "2026-09-01"\n',
    );
    expect(await readProvenance(changeRoot, "explore")).toEqual({
      commit: "abc123",
      fingerprint: "deadbeef1234",
      recordedAt: "2026-09-01",
    });
  });

  it("reads each stage from its own distinct sidecar file, never cross-contaminating", async () => {
    await writeFixtureFile(
      changeRoot,
      ".ce-provenance-explore.yml",
      'commit: "explore-sha"\nfingerprint: "explorefinger"\nrecordedAt: "2026-08-01"\n',
    );
    await writeFixtureFile(
      changeRoot,
      ".ce-provenance-enrich.yml",
      'commit: "enrich-sha"\nfingerprint: "enrichfinger"\nrecordedAt: "2026-08-15"\n',
    );
    await writeFixtureFile(
      changeRoot,
      ".ce-provenance-propose.yml",
      'commit: "propose-sha"\nfingerprint: "proposefinger"\nrecordedAt: "2026-08-20"\n',
    );

    expect((await readProvenance(changeRoot, "explore"))?.commit).toBe("explore-sha");
    expect((await readProvenance(changeRoot, "enrich"))?.commit).toBe("enrich-sha");
    expect((await readProvenance(changeRoot, "propose"))?.commit).toBe("propose-sha");
  });

  it("returns null for a malformed sidecar instead of throwing", async () => {
    await writeFixtureFile(changeRoot, ".ce-provenance-explore.yml", "not: [valid: yaml:\n");
    expect(await readProvenance(changeRoot, "explore")).toBeNull();
  });

  it("returns null when the sidecar is missing an expected field", async () => {
    await writeFixtureFile(changeRoot, ".ce-provenance-explore.yml", 'commit: "abc123"\n');
    expect(await readProvenance(changeRoot, "explore")).toBeNull();
  });
});

describe("checkStaleness", () => {
  // changeRoot (the durable OpenSpec store's change directory) and
  // repoDir (the Git worktree) are always separate directories in real
  // usage -- kept separate here too, so writing a sidecar into
  // changeRoot never itself pollutes the worktree fingerprint being
  // compared against it.
  let changeRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    changeRoot = await mkdtemp(join(tmpdir(), "ce-harness-provenance-changeroot-"));
  });

  afterEach(async () => {
    await rm(changeRoot, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns \"unknown\" when no provenance was recorded", async () => {
    repoDir = await createTempRepo();
    expect(await checkStaleness(changeRoot, "explore", repoDir)).toEqual({ status: "unknown" });
  });

  it("returns \"fresh\" when the recorded fingerprint matches the current worktree state", async () => {
    repoDir = await createTempRepo();
    const fingerprint = await computeWorktreeFingerprint(repoDir);
    await writeFixtureFile(
      changeRoot,
      ".ce-provenance-explore.yml",
      `commit: "x"\nfingerprint: "${fingerprint}"\nrecordedAt: "2026-09-01"\n`,
    );

    const result = await checkStaleness(changeRoot, "explore", repoDir);
    expect(result.status).toBe("fresh");
  });

  it("returns \"stale\" once the worktree changes after the stamp was recorded (uncommitted edit)", async () => {
    repoDir = await createTempRepo();
    const fingerprint = await computeWorktreeFingerprint(repoDir);
    await writeFixtureFile(
      changeRoot,
      ".ce-provenance-explore.yml",
      `commit: "x"\nfingerprint: "${fingerprint}"\nrecordedAt: "2026-09-01"\n`,
    );

    await writeFile(join(repoDir, "README.md"), "modified after exploring\n", "utf8");

    const result = await checkStaleness(changeRoot, "explore", repoDir);
    expect(result.status).toBe("stale");
    if (result.status === "stale") {
      expect(result.currentFingerprint).not.toBe(fingerprint);
      expect(result.stamp.recordedAt).toBe("2026-09-01");
    }
  });

  it("returns \"stale\" once a new commit lands after the stamp was recorded", async () => {
    repoDir = await createTempRepo();
    const fingerprint = await computeWorktreeFingerprint(repoDir);
    await writeFixtureFile(
      changeRoot,
      ".ce-provenance-explore.yml",
      `commit: "x"\nfingerprint: "${fingerprint}"\nrecordedAt: "2026-09-01"\n`,
    );

    await writeFile(join(repoDir, "new.txt"), "x\n", "utf8");
    await execa("git", ["-C", repoDir, "add", "."]);
    await execa("git", ["-C", repoDir, "commit", "-m", "advance"]);

    expect((await checkStaleness(changeRoot, "explore", repoDir)).status).toBe("stale");
  });

  it("each stage is checked independently -- a stale explore stamp never affects enrich/propose", async () => {
    repoDir = await createTempRepo();
    const originalFingerprint = await computeWorktreeFingerprint(repoDir);
    await writeFixtureFile(
      changeRoot,
      ".ce-provenance-explore.yml",
      `commit: "x"\nfingerprint: "${originalFingerprint}"\nrecordedAt: "2026-08-01"\n`,
    );

    await writeFile(join(repoDir, "drift.txt"), "x\n", "utf8");
    const newFingerprint = await computeWorktreeFingerprint(repoDir);
    await writeFixtureFile(
      changeRoot,
      ".ce-provenance-enrich.yml",
      `commit: "y"\nfingerprint: "${newFingerprint}"\nrecordedAt: "2026-08-15"\n`,
    );

    expect((await checkStaleness(changeRoot, "explore", repoDir)).status).toBe("stale");
    expect((await checkStaleness(changeRoot, "enrich", repoDir)).status).toBe("fresh");
    expect((await checkStaleness(changeRoot, "propose", repoDir)).status).toBe("unknown");
  });
});

describe("isStageInvalid", () => {
  it("is false only for \"fresh\"", () => {
    expect(isStageInvalid({ status: "fresh", stamp: { commit: "x", fingerprint: "f", recordedAt: "2026-09-01" } })).toBe(
      false,
    );
  });

  it("is true for \"stale\" -- a stale artifact must never be treated as fresh", () => {
    expect(
      isStageInvalid({
        status: "stale",
        stamp: { commit: "x", fingerprint: "f", recordedAt: "2026-09-01" },
        currentFingerprint: "g",
      }),
    ).toBe(true);
  });

  it("is true for \"unknown\" -- a legacy artifact with no recorded provenance must never be treated as fresh", () => {
    expect(isStageInvalid({ status: "unknown" })).toBe(true);
  });
});

describe("formatProvenanceSummary", () => {
  it("returns null when there are no entries at all", () => {
    expect(formatProvenanceSummary([])).toBeNull();
  });

  it("shows an \"unknown\" entry explicitly, with rerun guidance -- never omitted, never treated as fresh", () => {
    const entries: { stage: ProvenanceStage; result: StalenessResult }[] = [
      { stage: "explore", result: { status: "unknown" } },
    ];
    const summary = formatProvenanceSummary(entries);
    expect(summary).toContain("explore unknown");
    expect(summary).toContain("legacy");
    expect(summary).toContain("rerun /explore");
  });

  it("shows fresh, stale, and unknown entries together, each with correct wording and rerun guidance where applicable", () => {
    const entries: { stage: ProvenanceStage; result: StalenessResult }[] = [
      { stage: "explore", result: { status: "unknown" } },
      {
        stage: "enrich",
        result: { status: "fresh", stamp: { commit: "x", fingerprint: "f1", recordedAt: "2026-09-01" } },
      },
      {
        stage: "propose",
        result: {
          status: "stale",
          stamp: { commit: "y", fingerprint: "f2", recordedAt: "2026-08-20" },
          currentFingerprint: "f3",
        },
      },
    ];

    const summary = formatProvenanceSummary(entries);
    expect(summary).toContain("explore unknown");
    expect(summary).toContain("rerun /explore");
    expect(summary).toContain("enrich fresh (as of 2026-09-01)");
    expect(summary).toContain("propose stale (repo changed since 2026-08-20) -- rerun /propose");
  });
});
