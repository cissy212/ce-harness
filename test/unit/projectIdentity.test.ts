import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateProjectId } from "../../src/core/openspecId.js";
import {
  classifyIdentityMatch,
  normalizeRemoteUrl,
  readIdentityRecord,
  resolveProjectIdentity,
  scanProjectIdentities,
  writeIdentityRecord,
  type ProjectIdentityRecord,
} from "../../src/core/projectIdentity.js";
import { CeError } from "../../src/core/errors.js";

describe("normalizeRemoteUrl", () => {
  it("normalizes scp-like, ssh://, and https:// spellings of the same repository to the same value", () => {
    const scpLike = normalizeRemoteUrl("git@github.com:acme/widgets.git");
    const sshUrl = normalizeRemoteUrl("ssh://git@github.com/acme/widgets.git");
    const httpsUrl = normalizeRemoteUrl("https://github.com/acme/widgets");
    const httpsTrailing = normalizeRemoteUrl("https://GitHub.com/acme/widgets.git/");

    expect(scpLike).not.toBeNull();
    expect(scpLike).toBe(sshUrl);
    expect(scpLike).toBe(httpsUrl);
    expect(scpLike).toBe(httpsTrailing);
  });

  it("is case-insensitive on the host", () => {
    const lower = normalizeRemoteUrl("https://github.com/acme/widgets");
    const upper = normalizeRemoteUrl("https://GITHUB.COM/acme/widgets");
    expect(lower).toBe(upper);
  });

  it("distinguishes different repositories (different owner/name)", () => {
    const a = normalizeRemoteUrl("https://github.com/acme/widgets");
    const b = normalizeRemoteUrl("https://github.com/acme/gadgets");
    expect(a).not.toBe(b);
  });

  it("returns null for a local filesystem path remote (not meaningful cross-checkout evidence)", () => {
    expect(normalizeRemoteUrl("/tmp/some/bare/repo.git")).toBeNull();
    expect(normalizeRemoteUrl("./relative/repo")).toBeNull();
    expect(normalizeRemoteUrl("../relative/repo")).toBeNull();
    expect(normalizeRemoteUrl("file:///tmp/some/bare/repo.git")).toBeNull();
  });

  it("returns null for an empty or whitespace-only value", () => {
    expect(normalizeRemoteUrl("")).toBeNull();
    expect(normalizeRemoteUrl("   ")).toBeNull();
  });
});

function makeRecord(
  projectId: string,
  evidence: Array<{ originUrl: string | null; rootCommit: string | null }>,
): ProjectIdentityRecord {
  return {
    projectId,
    createdAt: "2026-01-01T00:00:00.000Z",
    evidence: evidence.map((e) => ({
      project: "demo",
      originUrl: e.originUrl,
      rootCommit: e.rootCommit,
      recordedAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}

const ORIGIN_A = "github.com/acme/widgets";
const ROOT_A = "a".repeat(40);
const ORIGIN_B = "github.com/acme/gadgets";
const ROOT_B = "b".repeat(40);

describe("classifyIdentityMatch", () => {
  it("returns no-match when there are no records at all", () => {
    const result = classifyIdentityMatch({ originUrl: "https://github.com/acme/widgets", rootCommit: ROOT_A }, []);
    expect(result.kind).toBe("no-match");
  });

  it("returns no-match when neither signal agrees with any known record", () => {
    const records = [makeRecord("proj1", [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }])];
    const result = classifyIdentityMatch(
      { originUrl: "https://github.com/acme/unrelated", rootCommit: "c".repeat(40) },
      records,
    );
    expect(result.kind).toBe("no-match");
  });

  it("returns match when a single evidence entry agrees on both origin URL and root commit", () => {
    const records = [makeRecord("proj1", [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }])];
    const result = classifyIdentityMatch(
      { originUrl: "https://github.com/acme/widgets", rootCommit: ROOT_A },
      records,
    );
    expect(result.kind).toBe("match");
    if (result.kind === "match") expect(result.record.projectId).toBe("proj1");
  });

  it("returns match when the origin URL agrees and the root commit is simply unavailable right now (e.g. a shallow clone) -- unavailable is not a conflict", () => {
    // A missing signal contributes no evidence either way -- it is not
    // itself a disagreement. This is what lets a shallow clone (which
    // structurally cannot provide root-commit evidence -- see
    // core/git.ts's resolveRootCommit) of an already-known origin still
    // auto-recognize the project, rather than being permanently stuck at
    // CANDIDATE just because it's shallow.
    const records = [makeRecord("proj1", [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }])];
    const result = classifyIdentityMatch({ originUrl: "https://github.com/acme/widgets", rootCommit: null }, records);
    expect(result.kind).toBe("match");
    if (result.kind === "match") expect(result.record.projectId).toBe("proj1");
  });

  it("returns candidate when the origin URL agrees but the root commit is present on both sides and genuinely differs", () => {
    const records = [makeRecord("proj1", [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }])];
    const result = classifyIdentityMatch(
      { originUrl: "https://github.com/acme/widgets", rootCommit: ROOT_B },
      records,
    );
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.record.projectId).toBe("proj1");
      expect(result.originAgrees).toBe(true);
      expect(result.rootAgrees).toBe(false);
    }
  });

  it("returns candidate when only the root commit agrees (e.g. after a repository transfer to a new origin)", () => {
    const records = [makeRecord("proj1", [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }])];
    const result = classifyIdentityMatch(
      { originUrl: "https://github.com/acme/new-home", rootCommit: ROOT_A },
      records,
    );
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.originAgrees).toBe(false);
      expect(result.rootAgrees).toBe(true);
    }
  });

  it("returns candidate (not match) when origin and root each agree, but with DIFFERENT evidence entries of the same record", () => {
    // Conservative by design: agreement must land on a single recorded
    // snapshot to count as a full match -- see classifyIdentityMatch's
    // doc comment.
    const records = [
      makeRecord("proj1", [
        { originUrl: ORIGIN_A, rootCommit: "old-root-before-rewrite" },
        { originUrl: "github.com/acme/old-home", rootCommit: ROOT_A },
      ]),
    ];
    const result = classifyIdentityMatch({ originUrl: "https://github.com/acme/widgets", rootCommit: ROOT_A }, records);
    expect(result.kind).toBe("candidate");
  });

  it("returns conflict when the origin URL matches one project and the root commit matches a different one", () => {
    const records = [
      makeRecord("proj1", [{ originUrl: ORIGIN_A, rootCommit: "unrelated-root" }]),
      makeRecord("proj2", [{ originUrl: "github.com/acme/other", rootCommit: ROOT_A }]),
    ];
    const result = classifyIdentityMatch({ originUrl: "https://github.com/acme/widgets", rootCommit: ROOT_A }, records);
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.records.map((r) => r.projectId).sort()).toEqual(["proj1", "proj2"]);
    }
  });

  it("a full match on one record takes priority even when a different record also partially matches", () => {
    const records = [
      makeRecord("proj1", [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }]),
      makeRecord("proj2", [{ originUrl: ORIGIN_A, rootCommit: "some-other-root" }]),
    ];
    const result = classifyIdentityMatch({ originUrl: "https://github.com/acme/widgets", rootCommit: ROOT_A }, records);
    expect(result.kind).toBe("match");
    if (result.kind === "match") expect(result.record.projectId).toBe("proj1");
  });

  it("evidence entries with a null signal never falsely agree with a present signal", () => {
    const records = [makeRecord("proj1", [{ originUrl: null, rootCommit: ROOT_A }])];
    const result = classifyIdentityMatch({ originUrl: "https://github.com/acme/widgets", rootCommit: null }, records);
    expect(result.kind).toBe("no-match");
  });

  it("returns match on root-commit-only evidence when origin was never available on either side (a repository with no remote)", () => {
    // No remote configured is common and legitimate (a local-only
    // repository) -- it must not permanently strand a project at
    // CANDIDATE just because the origin signal never has anything to
    // compare.
    const records = [makeRecord("proj1", [{ originUrl: null, rootCommit: ROOT_A }])];
    const result = classifyIdentityMatch({ originUrl: null, rootCommit: ROOT_A }, records);
    expect(result.kind).toBe("match");
    if (result.kind === "match") expect(result.record.projectId).toBe("proj1");
  });

  it("a genuine root-commit conflict still blocks the match even when origin is unavailable on both sides", () => {
    const records = [makeRecord("proj1", [{ originUrl: null, rootCommit: ROOT_A }])];
    const result = classifyIdentityMatch({ originUrl: null, rootCommit: ROOT_B }, records);
    expect(result.kind).toBe("no-match");
  });
});

describe("readIdentityRecord / writeIdentityRecord / scanProjectIdentities", () => {
  let tempHome: string;
  const originalEnv = process.env.CE_HARNESS_HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "ce-harness-projectidentity-"));
    process.env.CE_HARNESS_HOME = tempHome;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it("readIdentityRecord returns null when no .identity.yml exists yet", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    const durableRoot = join(openspecRoot(), "someproject");
    expect(await readIdentityRecord(durableRoot)).toBeNull();
  });

  it("round-trips a record through writeIdentityRecord/readIdentityRecord", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    const durableRoot = join(openspecRoot(), generateProjectId());
    const record = makeRecord("proj1", [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }]);
    await writeIdentityRecord(durableRoot, record);
    expect(await readIdentityRecord(durableRoot)).toEqual(record);
  });

  it("readIdentityRecord throws a CeError for a file that isn't valid YAML", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const durableRoot = join(openspecRoot(), "broken");
    await mkdir(durableRoot, { recursive: true });
    await writeFile(join(durableRoot, ".identity.yml"), "projectId: [unterminated", "utf8");
    await expect(readIdentityRecord(durableRoot)).rejects.toThrow(CeError);
  });

  it("readIdentityRecord throws a CeError for YAML that doesn't match the schema", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const durableRoot = join(openspecRoot(), "bad-schema");
    await mkdir(durableRoot, { recursive: true });
    await writeFile(join(durableRoot, ".identity.yml"), "projectId: abc\n", "utf8");
    await expect(readIdentityRecord(durableRoot)).rejects.toThrow(CeError);
  });

  it("scanProjectIdentities returns an empty array when the openspec root doesn't exist yet", async () => {
    expect(await scanProjectIdentities()).toEqual([]);
  });

  it("scanProjectIdentities finds every project's record, skipping directories with no .identity.yml", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    const { mkdir } = await import("node:fs/promises");

    const recordA = makeRecord("proj-a", [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }]);
    const recordB = makeRecord("proj-b", [{ originUrl: ORIGIN_B, rootCommit: ROOT_B }]);
    await writeIdentityRecord(join(openspecRoot(), "proj-a"), recordA);
    await writeIdentityRecord(join(openspecRoot(), "proj-b"), recordB);
    // A durable store directory with no identity file at all (e.g. a
    // legacy, pre-Project-Identity durable store) -- must be skipped,
    // never thrown for.
    await mkdir(join(openspecRoot(), "legacy-no-identity"), { recursive: true });

    const found = await scanProjectIdentities();
    expect(found.map((r) => r.projectId).sort()).toEqual(["proj-a", "proj-b"]);
  });

  it("scanProjectIdentities skips (never throws for) a corrupted identity file in one project", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    const { mkdir, writeFile } = await import("node:fs/promises");

    const goodRoot = join(openspecRoot(), "good-project");
    await writeIdentityRecord(goodRoot, makeRecord("good-project", [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }]));

    const corruptRoot = join(openspecRoot(), "corrupt-project");
    await mkdir(corruptRoot, { recursive: true });
    await writeFile(join(corruptRoot, ".identity.yml"), "not: [valid", "utf8");

    const found = await scanProjectIdentities();
    expect(found.map((r) => r.projectId)).toEqual(["good-project"]);
  });
});

describe("resolveProjectIdentity", () => {
  let tempHome: string;
  const originalEnv = process.env.CE_HARNESS_HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "ce-harness-resolveidentity-"));
    process.env.CE_HARNESS_HOME = tempHome;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.CE_HARNESS_HOME;
    } else {
      process.env.CE_HARNESS_HOME = originalEnv;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it("mints a fresh project id (with a record to persist) when nothing matches", async () => {
    const result = await resolveProjectIdentity({
      project: "demo",
      originUrl: "https://github.com/acme/widgets",
      rootCommit: ROOT_A,
    });
    expect(result.projectId).toMatch(/^[a-f0-9]{12}$/);
    expect(result.recordToPersist).not.toBeNull();
    expect(result.recordToPersist?.projectId).toBe(result.projectId);
    expect(result.recordToPersist?.evidence).toHaveLength(1);
  });

  it("mints a fresh project id even with no Git signals available at all", async () => {
    const result = await resolveProjectIdentity({ project: "demo", originUrl: null, rootCommit: null });
    expect(result.projectId).toMatch(/^[a-f0-9]{12}$/);
    expect(result.recordToPersist?.evidence[0]).toMatchObject({ originUrl: null, rootCommit: null });
  });

  it("reuses an existing project id on a full match, with nothing new to persist", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    const projectId = generateProjectId();
    await writeIdentityRecord(
      join(openspecRoot(), projectId),
      makeRecord(projectId, [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }]),
    );

    const result = await resolveProjectIdentity({
      project: "demo",
      originUrl: "https://github.com/acme/widgets",
      rootCommit: ROOT_A,
    });
    expect(result.projectId).toBe(projectId);
    expect(result.recordToPersist).toBeNull();
  });

  it("throws (refuses) on a CANDIDATE match, with an actionable hint naming the candidate's id", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    const projectId = generateProjectId();
    await writeIdentityRecord(
      join(openspecRoot(), projectId),
      makeRecord(projectId, [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }]),
    );

    // A genuine conflict: origin agrees, but ROOT_B is a real,
    // present-on-both-sides root commit that differs from ROOT_A -- not
    // merely "root commit unavailable" (see classifyIdentityMatch's own
    // tests for why that's treated differently).
    await expect(
      resolveProjectIdentity({ project: "demo", originUrl: "https://github.com/acme/widgets", rootCommit: ROOT_B }),
    ).rejects.toThrow(CeError);
    await expect(
      resolveProjectIdentity({ project: "demo", originUrl: "https://github.com/acme/widgets", rootCommit: ROOT_B }),
    ).rejects.toThrow(new RegExp(projectId));
  });

  it("throws (refuses) on a CONFLICT match, listing every conflicting id", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    await writeIdentityRecord(
      join(openspecRoot(), "proj-origin"),
      makeRecord("proj-origin", [{ originUrl: ORIGIN_A, rootCommit: "unrelated-root" }]),
    );
    await writeIdentityRecord(
      join(openspecRoot(), "proj-root"),
      makeRecord("proj-root", [{ originUrl: "github.com/acme/other", rootCommit: ROOT_A }]),
    );

    await expect(
      resolveProjectIdentity({ project: "demo", originUrl: "https://github.com/acme/widgets", rootCommit: ROOT_A }),
    ).rejects.toThrow(CeError);
  });

  it("--new-project mints a fresh id even when a full match exists", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    const existingId = generateProjectId();
    await writeIdentityRecord(
      join(openspecRoot(), existingId),
      makeRecord(existingId, [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }]),
    );

    const result = await resolveProjectIdentity({
      project: "demo",
      originUrl: "https://github.com/acme/widgets",
      rootCommit: ROOT_A,
      mintNew: true,
    });
    expect(result.projectId).not.toBe(existingId);
    expect(result.recordToPersist).not.toBeNull();
  });

  it("--project-id attaches to an existing project explicitly, appending a new evidence entry", async () => {
    const { openspecRoot } = await import("../../src/core/paths.js");
    const existingId = generateProjectId();
    await writeIdentityRecord(
      join(openspecRoot(), existingId),
      makeRecord(existingId, [{ originUrl: ORIGIN_A, rootCommit: ROOT_A }]),
    );

    const result = await resolveProjectIdentity({
      project: "demo",
      originUrl: "https://github.com/acme/renamed",
      rootCommit: "c".repeat(40),
      explicitProjectId: existingId,
    });
    expect(result.projectId).toBe(existingId);
    expect(result.recordToPersist?.evidence).toHaveLength(2);
  });

  it("--project-id throws a CeError when the given id does not exist", async () => {
    await expect(
      resolveProjectIdentity({ project: "demo", originUrl: null, rootCommit: null, explicitProjectId: generateProjectId() }),
    ).rejects.toThrow(CeError);
  });

  it("--project-id throws a CeError when the value isn't shaped like a real project id", async () => {
    await expect(
      resolveProjectIdentity({ project: "demo", originUrl: null, rootCommit: null, explicitProjectId: "not-a-real-id" }),
    ).rejects.toThrow(CeError);
  });
});
