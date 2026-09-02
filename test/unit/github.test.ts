import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CeError } from "../../src/core/errors.js";
import { createPullRequest, findOpenPrForBranch, parseGithubSlug } from "../../src/core/github.js";
import {
  setFakeCreatePrUrl,
  setFakeExistingPr,
  setFakeGhRecordFile,
  setupFakeGh,
  teardownFakeGh,
} from "../helpers/fakeGh.js";

describe("parseGithubSlug (pure)", () => {
  it("parses an https URL", () => {
    expect(parseGithubSlug("https://github.com/octocat/hello-world")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("parses an https URL with a trailing .git", () => {
    expect(parseGithubSlug("https://github.com/octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("parses an https URL with embedded credentials", () => {
    expect(parseGithubSlug("https://x-access-token:abc123@github.com/octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("parses SSH shorthand", () => {
    expect(parseGithubSlug("git@github.com:octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("parses a full ssh:// URL", () => {
    expect(parseGithubSlug("ssh://git@github.com/octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  it("returns null for a non-GitHub host", () => {
    expect(parseGithubSlug("https://gitlab.com/octocat/hello-world.git")).toBeNull();
  });

  it("returns null for an unparseable string", () => {
    expect(parseGithubSlug("not a url at all")).toBeNull();
  });
});

describe("findOpenPrForBranch / createPullRequest (against the fake gh CLI)", () => {
  let scratchDir: string;

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "ce-harness-github-test-"));
    setupFakeGh();
  });

  afterEach(async () => {
    teardownFakeGh();
    await rm(scratchDir, { recursive: true, force: true });
  });

  describe("findOpenPrForBranch", () => {
    it("returns null when no open PR exists for the branch", async () => {
      expect(await findOpenPrForBranch(scratchDir, "octocat/hello-world", "feature/130")).toBeNull();
    });

    it("returns the URL of an already-open PR for the branch", async () => {
      setFakeExistingPr("https://github.com/octocat/hello-world/pull/42");
      expect(await findOpenPrForBranch(scratchDir, "octocat/hello-world", "feature/130")).toBe(
        "https://github.com/octocat/hello-world/pull/42",
      );
    });
  });

  describe("createPullRequest", () => {
    it("creates a PR and returns its URL, passing an explicit --repo/--base/--head/--title/--body-file", async () => {
      setFakeCreatePrUrl("https://github.com/octocat/hello-world/pull/7");
      const recordFile = join(scratchDir, "record.json");
      setFakeGhRecordFile(recordFile);
      const bodyFile = join(scratchDir, "body.md");
      await writeFile(bodyFile, "## Summary\nDid a thing.\n", "utf8");

      const url = await createPullRequest(scratchDir, {
        repoSlug: "octocat/hello-world",
        base: "main",
        head: "feature/130-example",
        title: "Add the thing",
        bodyFile,
      });

      expect(url).toBe("https://github.com/octocat/hello-world/pull/7");
      const record = JSON.parse(await readFile(recordFile, "utf8"));
      expect(record).toEqual({
        repo: "octocat/hello-world",
        base: "main",
        head: "feature/130-example",
        title: "Add the thing",
        body: "## Summary\nDid a thing.\n",
      });
    });

    it("never passes any merge/auto-merge flag", async () => {
      const recordFile = join(scratchDir, "record.json");
      setFakeGhRecordFile(recordFile);
      const bodyFile = join(scratchDir, "body.md");
      await writeFile(bodyFile, "body\n", "utf8");

      await createPullRequest(scratchDir, {
        repoSlug: "octocat/hello-world",
        base: "main",
        head: "feature/130",
        title: "Title",
        bodyFile,
      });

      const record = JSON.parse(await readFile(recordFile, "utf8"));
      expect(JSON.stringify(record)).not.toMatch(/merge/i);
    });

    it("throws a clear, actionable CeError when gh pr create fails", async () => {
      process.env.FAKE_GH_FAIL_CREATE = "1";
      const bodyFile = join(scratchDir, "body.md");
      await writeFile(bodyFile, "body\n", "utf8");

      await expect(
        createPullRequest(scratchDir, {
          repoSlug: "octocat/hello-world",
          base: "main",
          head: "feature/130",
          title: "Title",
          bodyFile,
        }),
      ).rejects.toThrow(CeError);
    });
  });
});
