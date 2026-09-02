import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the fake `gh` executable used by tests. */
export const FAKE_GH_BIN = fileURLToPath(new URL("../fixtures/fake-gh.mjs", import.meta.url));

/** Path to a binary that is guaranteed not to exist, for "gh missing" tests. */
export function nonExistentGhBin(dir: string): string {
  return join(dir, "gh-does-not-exist");
}

export interface FakePrSnapshotInput {
  number: number;
  title: string;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  url?: string;
}

/** Points ce-harness at the fake `gh` executable for the current test. */
export function setupFakeGh(): void {
  process.env.CE_GH_BIN = FAKE_GH_BIN;
}

export function teardownFakeGh(): void {
  delete process.env.CE_GH_BIN;
  delete process.env.FAKE_GH_FAIL_AUTH;
  delete process.env.FAKE_GH_FAIL_RESOLVE;
  delete process.env.FAKE_GH_PR_JSON;
  delete process.env.FAKE_GH_EXISTING_PR_URL;
  delete process.env.FAKE_GH_FAIL_CREATE;
  delete process.env.FAKE_GH_CREATE_PR_URL;
  delete process.env.FAKE_GH_RECORD_FILE;
}

/** Configures `gh pr list --head <branch>` to report one already-open PR at this URL. */
export function setFakeExistingPr(url: string): void {
  process.env.FAKE_GH_EXISTING_PR_URL = url;
}

/** Configures the URL `gh pr create` reports on success. */
export function setFakeCreatePrUrl(url: string): void {
  process.env.FAKE_GH_CREATE_PR_URL = url;
}

/** Points `gh pr create`'s recorded invocation (repo/base/head/title/body) at this file, for a test to read back and assert against. */
export function setFakeGhRecordFile(path: string): void {
  process.env.FAKE_GH_RECORD_FILE = path;
}

/** Configures what `gh pr view --json ...` returns for the current test. */
export function setFakePrSnapshot(pr: FakePrSnapshotInput): void {
  process.env.FAKE_GH_PR_JSON = JSON.stringify({
    url: `https://github.com/example/example/pull/${pr.number}`,
    ...pr,
  });
}
