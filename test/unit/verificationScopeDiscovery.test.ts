import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { templatesRoot } from "../../src/core/templates.js";
import { createTempRepo } from "../helpers/tempRepo.js";

/**
 * Executes /verify's changed-file scope-discovery logic (Step 8.1) --
 * extracted verbatim from templates/commands/verify.md -- against real,
 * constructed Git repositories, the same "prove the shell behavior, not
 * just the markdown text" approach test/unit/verificationFreshness.test.ts
 * and test/unit/diffScopeResolution.test.ts already use.
 *
 * Real E2E bug this fixes: a change touched only `apps/dashboard/*`.
 * `/verify` inspected only worktree-root tooling, found no formatter
 * there, and concluded the check was "not applicable" -- when
 * `apps/dashboard` had its own `package.json` defining `format:check`
 * all along. `/adversarial-review` caught it later and `/verify` had to
 * re-run. These tests prove the scope-discovery snippet /verify now
 * runs *before* declaring a category unavailable actually finds that
 * nested scope, for real, not just that the markdown says the right
 * words.
 */

const FIND_SCOPE_START = "find_scope() {";

async function readVerifyTemplate(): Promise<string> {
  return readFile(join(templatesRoot(), "commands", "verify.md"), "utf8");
}

/** Extracts the find_scope() function + the git-diff/sort pipeline that uses it, dedenting the 3-space list-item indentation the markdown wraps it in. */
function extractScopeDiscoverySnippet(content: string): string {
  const startIdx = content.indexOf(FIND_SCOPE_START);
  if (startIdx === -1) {
    throw new Error(`scope-discovery snippet start marker ${JSON.stringify(FIND_SCOPE_START)} not found in verify.md`);
  }
  const fenceEnd = content.indexOf("\n   ```", startIdx);
  if (fenceEnd === -1) {
    throw new Error("scope-discovery snippet closing fence not found in verify.md");
  }
  return content
    .slice(startIdx, fenceEnd)
    .split("\n")
    .map((line) => line.replace(/^ {0,3}/, ""))
    .join("\n");
}

/** Runs the extracted snippet for real against `worktreePath`, diffing `diffRange` (substituted for the markdown's own placeholder). */
async function discoverScopes(worktreePath: string, diffRange: string): Promise<string[]> {
  const snippet = extractScopeDiscoverySnippet(await readVerifyTemplate()).replace(
    "<the same diff range Step 3 resolved>",
    diffRange,
  );
  const result = await execa("bash", ["-c", snippet], {
    env: { ...process.env, CE_WORKTREE: worktreePath },
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const FIND_DOCS_START = "find_docs() {";

/** Extracts the find_docs() function (instruction-evidence gathering, step 2), dedenting the same 3-space list-item indentation. */
function extractFindDocsSnippet(content: string): string {
  const startIdx = content.indexOf(FIND_DOCS_START);
  if (startIdx === -1) {
    throw new Error(`find_docs snippet start marker ${JSON.stringify(FIND_DOCS_START)} not found in verify.md`);
  }
  const fenceEnd = content.indexOf("\n   ```", startIdx);
  if (fenceEnd === -1) {
    throw new Error("find_docs snippet closing fence not found in verify.md");
  }
  return content
    .slice(startIdx, fenceEnd)
    .split("\n")
    .map((line) => line.replace(/^ {0,3}/, ""))
    .join("\n");
}

/** Runs find_docs() for real against a single changed-file path relative to $CE_WORKTREE. */
async function discoverDocs(worktreePath: string, changedFile: string): Promise<string[]> {
  const snippet = `${extractFindDocsSnippet(await readVerifyTemplate())}\nfind_docs "${changedFile}"`;
  const result = await execa("bash", ["-c", snippet], {
    env: { ...process.env, CE_WORKTREE: worktreePath },
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function commitAll(repoDir: string, message: string): Promise<void> {
  await execa("git", ["-C", repoDir, "add", "."]);
  await execa("git", ["-C", repoDir, "commit", "-m", message]);
}

describe("verify.md's changed-file scope discovery (Step 8.1), executed for real", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    cleanupDirs.length = 0;
  });

  it("one changed nested package with a scoped check absent at root: discovers the nested scope, not root", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    // Root manifest: no format:check script at all.
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ scripts: { build: "echo build" } }), "utf8");
    await mkdir(join(repoDir, "apps", "dashboard", "src"), { recursive: true });
    // Nested manifest: has its own format:check script.
    await writeFile(
      join(repoDir, "apps", "dashboard", "package.json"),
      JSON.stringify({ scripts: { "format:check": "echo format-check" } }),
      "utf8",
    );
    await commitAll(repoDir, "add dashboard app scaffolding");

    await writeFile(join(repoDir, "apps", "dashboard", "src", "index.ts"), "export {};\n", "utf8");
    await commitAll(repoDir, "change dashboard source");

    const scopes = await discoverScopes(repoDir, "HEAD~1...HEAD");

    expect(scopes).toEqual(["apps/dashboard"]);
    expect(scopes).not.toContain(".");
  });

  it("a nested README/AGENTS.md in an intermediate directory never stops scope discovery early -- resolves to the real tooling scope above it", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ scripts: { build: "echo build" } }), "utf8");
    await mkdir(join(repoDir, "apps", "dashboard", "src", "components"), { recursive: true });
    // The real tooling scope: apps/dashboard/package.json defines the actual scoped check.
    await writeFile(
      join(repoDir, "apps", "dashboard", "package.json"),
      JSON.stringify({ scripts: { "format:check": "echo dashboard-format" } }),
      "utf8",
    );
    // An intermediate directory, strictly between the changed file and
    // apps/dashboard, that has BOTH a README.md and an AGENTS.md -- pure
    // documentation, no tooling of its own.
    await writeFile(
      join(repoDir, "apps", "dashboard", "src", "components", "README.md"),
      "# Components\n\nComponent-level notes.\n",
      "utf8",
    );
    await writeFile(
      join(repoDir, "apps", "dashboard", "src", "components", "AGENTS.md"),
      "Run `npm run format:check` from the app root before committing.\n",
      "utf8",
    );
    await commitAll(repoDir, "scaffold dashboard with a documented components directory");

    await writeFile(
      join(repoDir, "apps", "dashboard", "src", "components", "ContactDrawer.vue"),
      "<template></template>\n",
      "utf8",
    );
    await commitAll(repoDir, "change ContactDrawer.vue");

    const scopes = await discoverScopes(repoDir, "HEAD~1...HEAD");

    // Must resolve to apps/dashboard (the tooling boundary), never the
    // intermediate components/ directory just because it has docs.
    expect(scopes).toEqual(["apps/dashboard"]);
    expect(scopes).not.toContain("apps/dashboard/src/components");
  });

  it("instruction evidence (README.md/AGENTS.md) is still gathered from every level along the path, even though it never defines the scope", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    await mkdir(join(repoDir, "apps", "dashboard", "src", "components"), { recursive: true });
    await writeFile(join(repoDir, "apps", "dashboard", "package.json"), JSON.stringify({ scripts: {} }), "utf8");
    await writeFile(
      join(repoDir, "apps", "dashboard", "src", "components", "README.md"),
      "component notes\n",
      "utf8",
    );
    await writeFile(join(repoDir, "apps", "dashboard", "AGENTS.md"), "app-level guidance\n", "utf8");
    await writeFile(join(repoDir, "README.md"), "root readme\n", "utf8");

    const docs = await discoverDocs(repoDir, "apps/dashboard/src/components/ContactDrawer.vue");

    expect(docs.sort()).toEqual(
      ["apps/dashboard/AGENTS.md", "apps/dashboard/src/components/README.md", "README.md"].sort(),
    );
  });

  it("multiple changed scopes require checking each independently", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    await mkdir(join(repoDir, "apps", "dashboard", "src"), { recursive: true });
    await mkdir(join(repoDir, "packages", "shared", "src"), { recursive: true });
    await writeFile(
      join(repoDir, "apps", "dashboard", "package.json"),
      JSON.stringify({ scripts: { "format:check": "echo dashboard-format" } }),
      "utf8",
    );
    await writeFile(
      join(repoDir, "packages", "shared", "Cargo.toml"),
      "[package]\nname = \"shared\"\n",
      "utf8",
    );
    await commitAll(repoDir, "scaffold two packages");

    await writeFile(join(repoDir, "apps", "dashboard", "src", "index.ts"), "export {};\n", "utf8");
    await writeFile(join(repoDir, "packages", "shared", "src", "lib.rs"), "pub fn x() {}\n", "utf8");
    await commitAll(repoDir, "change both packages");

    const scopes = await discoverScopes(repoDir, "HEAD~1...HEAD");

    expect(scopes.sort()).toEqual(["apps/dashboard", "packages/shared"]);
  });

  it("a changed file with no nested manifest above it resolves to the root scope (\".\"), the root-check-still-applies case", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "echo test" } }), "utf8");
    await commitAll(repoDir, "add root manifest");

    await writeFile(join(repoDir, "root-level-file.ts"), "export {};\n", "utf8");
    await commitAll(repoDir, "change a root-level file");

    const scopes = await discoverScopes(repoDir, "HEAD~1...HEAD");

    expect(scopes).toEqual(["."]);
  });

  it("no manifest/task-runner/doc anywhere in the ancestor chain: scope discovery still terminates at root (\".\"), never silently empty", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    // No package.json, no Makefile, no docs anywhere -- a genuinely
    // tooling-free repository. Discovery must still resolve a scope
    // (root) rather than producing nothing, so a later "is this
    // category available" check has something concrete to inspect.
    await mkdir(join(repoDir, "misc", "nested"), { recursive: true });
    await writeFile(join(repoDir, "misc", "nested", "notes.txt"), "hello\n", "utf8");
    await commitAll(repoDir, "add a plain file with no tooling anywhere");

    await writeFile(join(repoDir, "misc", "nested", "notes.txt"), "hello again\n", "utf8");
    await commitAll(repoDir, "edit the plain file");

    const scopes = await discoverScopes(repoDir, "HEAD~1...HEAD");

    expect(scopes).toEqual(["."]);
  });

  it("the change's own scope is found even when the changed file IS the manifest itself", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    await mkdir(join(repoDir, "apps", "dashboard"), { recursive: true });
    await writeFile(
      join(repoDir, "apps", "dashboard", "package.json"),
      JSON.stringify({ scripts: { test: "echo v1" } }),
      "utf8",
    );
    await commitAll(repoDir, "add dashboard manifest");

    await writeFile(
      join(repoDir, "apps", "dashboard", "package.json"),
      JSON.stringify({ scripts: { test: "echo v2", "format:check": "echo new-check" } }),
      "utf8",
    );
    await commitAll(repoDir, "add format:check to dashboard manifest");

    const scopes = await discoverScopes(repoDir, "HEAD~1...HEAD");

    expect(scopes).toEqual(["apps/dashboard"]);
  });

  it("respects $CE_DIFF_BASE...$CE_DIFF_HEAD-style explicit ranges, not just HEAD~1...HEAD", async () => {
    const repoDir = await createTempRepo();
    cleanupDirs.push(repoDir);
    await mkdir(join(repoDir, "apps", "dashboard", "src"), { recursive: true });
    await writeFile(
      join(repoDir, "apps", "dashboard", "package.json"),
      JSON.stringify({ scripts: { "format:check": "echo check" } }),
      "utf8",
    );
    await commitAll(repoDir, "scaffold dashboard");
    const base = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

    await writeFile(join(repoDir, "apps", "dashboard", "src", "index.ts"), "export {};\n", "utf8");
    await commitAll(repoDir, "change dashboard source");
    const head = (await execa("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

    const scopes = await discoverScopes(repoDir, `${base}...${head}`);

    expect(scopes).toEqual(["apps/dashboard"]);
  });

  describe("template text: no invented package-manager commands, root always still considered", () => {
    it("verify.md still instructs never assuming npm/a specific stack, applied per scope", async () => {
      const content = await readVerifyTemplate();
      expect(content).toMatch(/each scope may use a completely different package\s+manager\/toolchain/);
      expect(content).toMatch(/Do not assume npm, Docker, Prisma, or any other specific stack or\s+tool/);
    });

    it("verify.md states the relevant scope set always includes the root, even once a nested scope is found", async () => {
      const content = await readVerifyTemplate();
      expect(content).toMatch(/relevant\s+scope set is this output plus `\$CE_WORKTREE` itself, always/);
    });

    it("verify.md requires confirming unavailability at every relevant scope before reporting a category unavailable", async () => {
      const content = await readVerifyTemplate();
      expect(content).toMatch(/confirm this holds at \*every\* relevant scope/);
    });

    it("verify.md still forbids running every discovered script in every scope", async () => {
      const content = await readVerifyTemplate();
      expect(content).toMatch(/Never run every discovered script in every scope/);
    });

    it("the report's Commands Executed and Outcomes field now records which scope justified each command", async () => {
      const content = await readVerifyTemplate();
      expect(content).toMatch(/`<discovered command>` \(scope: `<scope directory/);
    });

    it("the extracted scope-discovery snippet itself contains no hardcoded npm/pip/cargo invocation", async () => {
      const snippet = extractScopeDiscoverySnippet(await readVerifyTemplate());
      expect(snippet).not.toMatch(/npm run|npm test|pip install|cargo (build|test|run)/);
    });
  });
});
