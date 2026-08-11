import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectBootstrapNeeds } from "../../src/core/bootstrap.js";

describe("detectBootstrapNeeds (repository bootstrap detection)", () => {
  let worktreePath: string;

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), "ce-harness-bootstrap-"));
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it("reports nothing required for an empty worktree (no known manifests at all)", () => {
    const result = detectBootstrapNeeds(worktreePath);
    expect(result.required).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("flags a Node.js project whose dependencies were never installed (node_modules absent)", async () => {
    await writeFile(join(worktreePath, "package.json"), JSON.stringify({ name: "demo" }), "utf8");

    const result = detectBootstrapNeeds(worktreePath);
    expect(result.required).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ecosystem: "npm",
      manifest: "package.json",
      suggestedCommand: "npm install",
    });
    expect(result.findings[0].message).toMatch(/node_modules\/ does not exist/);
  });

  it("does not flag a Node.js project whose dependencies are already installed", async () => {
    await writeFile(join(worktreePath, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    await mkdir(join(worktreePath, "node_modules"), { recursive: true });

    const result = detectBootstrapNeeds(worktreePath);
    expect(result.required).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("suggests pnpm/yarn/npm based on whichever lockfile is present", async () => {
    await writeFile(join(worktreePath, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    await writeFile(join(worktreePath, "pnpm-lock.yaml"), "", "utf8");

    expect(detectBootstrapNeeds(worktreePath).findings[0].suggestedCommand).toBe("pnpm install");
  });

  it("suggests yarn when only a yarn.lock is present", async () => {
    await writeFile(join(worktreePath, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    await writeFile(join(worktreePath, "yarn.lock"), "", "utf8");

    expect(detectBootstrapNeeds(worktreePath).findings[0].suggestedCommand).toBe("yarn install");
  });

  it("defaults to npm install when no lockfile is present at all", async () => {
    await writeFile(join(worktreePath, "package.json"), JSON.stringify({ name: "demo" }), "utf8");

    expect(detectBootstrapNeeds(worktreePath).findings[0].suggestedCommand).toBe("npm install");
  });

  it('mentions the "prepare" script generically, without naming any specific tool (e.g. Husky) by name', async () => {
    await writeFile(
      join(worktreePath, "package.json"),
      JSON.stringify({ name: "demo", scripts: { prepare: "husky install" } }),
      "utf8",
    );

    const result = detectBootstrapNeeds(worktreePath);
    expect(result.findings[0].message).toMatch(/"prepare" script/);
    expect(result.findings[0].message).not.toMatch(/husky/i);
  });

  it("does not mention a prepare script when none is declared", async () => {
    await writeFile(join(worktreePath, "package.json"), JSON.stringify({ name: "demo" }), "utf8");

    expect(detectBootstrapNeeds(worktreePath).findings[0].message).not.toMatch(/prepare/i);
  });

  it("never throws on a malformed package.json -- still flags the missing node_modules", async () => {
    await writeFile(join(worktreePath, "package.json"), "{ not valid json", "utf8");

    expect(() => detectBootstrapNeeds(worktreePath)).not.toThrow();
    const result = detectBootstrapNeeds(worktreePath);
    expect(result.required).toBe(true);
    expect(result.findings[0].ecosystem).toBe("npm");
  });

  it("flags a PHP/Composer project whose dependencies were never installed (vendor/ absent)", async () => {
    await writeFile(join(worktreePath, "composer.json"), JSON.stringify({ name: "demo/demo" }), "utf8");

    const result = detectBootstrapNeeds(worktreePath);
    expect(result.required).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ecosystem: "Composer",
      manifest: "composer.json",
      suggestedCommand: "composer install",
    });
  });

  it("does not flag a Composer project whose dependencies are already installed", async () => {
    await writeFile(join(worktreePath, "composer.json"), JSON.stringify({ name: "demo/demo" }), "utf8");
    await mkdir(join(worktreePath, "vendor"), { recursive: true });

    expect(detectBootstrapNeeds(worktreePath).required).toBe(false);
  });

  it("reports multiple independent findings when more than one ecosystem needs bootstrapping", async () => {
    await writeFile(join(worktreePath, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    await writeFile(join(worktreePath, "composer.json"), JSON.stringify({ name: "demo/demo" }), "utf8");

    const result = detectBootstrapNeeds(worktreePath);
    expect(result.required).toBe(true);
    expect(result.findings.map((f) => f.ecosystem).sort()).toEqual(["Composer", "npm"]);
  });

  it("never executes anything -- purely inspects file/directory existence (documented contract, sanity-checked here)", async () => {
    // No package manager, shell, or subprocess module is imported by
    // src/core/bootstrap.ts at all -- this test exists as an explicit,
    // permanent tripwire: importing execa (or any process-spawning
    // module) into bootstrap.ts in the future should be a deliberate,
    // reviewed decision, not an accident.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/core/bootstrap.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/execa/);
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/exec\(/);
  });

  it("does not consider Python or Ruby manifests (ambiguous local-install signal, deliberately out of scope)", async () => {
    await writeFile(join(worktreePath, "requirements.txt"), "flask\n", "utf8");
    await writeFile(join(worktreePath, "Gemfile"), 'source "https://rubygems.org"\n', "utf8");

    expect(detectBootstrapNeeds(worktreePath).required).toBe(false);
  });
});
