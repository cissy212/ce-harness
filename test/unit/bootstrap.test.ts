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

  it("warns about the potential lockfile side effect when a full install is the only option (node_modules absent)", async () => {
    await writeFile(join(worktreePath, "package.json"), JSON.stringify({ name: "demo" }), "utf8");

    const result = detectBootstrapNeeds(worktreePath);
    expect(result.findings[0].sideEffectWarning).toMatch(/lockfile/i);
  });

  it("warns about the potential composer.lock side effect for a full Composer install", async () => {
    await writeFile(join(worktreePath, "composer.json"), JSON.stringify({ name: "demo/demo" }), "utf8");

    const result = detectBootstrapNeeds(worktreePath);
    expect(result.findings[0].sideEffectWarning).toMatch(/composer\.lock/i);
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

  describe("targeted setup: prefers re-running just a declared lifecycle script over a full reinstall", () => {
    async function setUpInstalledRepoWithHuskyMarker() {
      await writeFile(
        join(worktreePath, "package.json"),
        JSON.stringify({ name: "demo", scripts: { prepare: "husky install" } }),
        "utf8",
      );
      await mkdir(join(worktreePath, "node_modules"), { recursive: true });
      await mkdir(join(worktreePath, ".husky"), { recursive: true });
    }

    it('suggests "npm run prepare" -- never a full install -- when dependencies are installed but the Git-hooks artifact is missing', async () => {
      await setUpInstalledRepoWithHuskyMarker();
      // .husky/ exists (proves this repo uses it) but .husky/_/husky.sh
      // (the generated helper) does not -- exactly the real-world case
      // this feature exists to fix.

      const result = detectBootstrapNeeds(worktreePath);
      expect(result.required).toBe(true);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        ecosystem: "npm",
        manifest: "package.json",
        suggestedCommand: "npm run prepare",
      });
      expect(result.findings[0].message).toMatch(/\.husky\/_\/husky\.sh/);
      expect(result.findings[0].message).toMatch(/Husky/);
    });

    it('never suggests "npm install" for this case -- the targeted command carries no side-effect warning', async () => {
      await setUpInstalledRepoWithHuskyMarker();

      const result = detectBootstrapNeeds(worktreePath);
      expect(result.findings[0].suggestedCommand).not.toBe("npm install");
      expect(result.findings[0].sideEffectWarning).toBeUndefined();
    });

    it("does not flag anything once the Git-hooks artifact actually exists", async () => {
      await setUpInstalledRepoWithHuskyMarker();
      await mkdir(join(worktreePath, ".husky", "_"), { recursive: true });
      await writeFile(join(worktreePath, ".husky", "_", "husky.sh"), "#!/usr/bin/env sh\n", "utf8");

      expect(detectBootstrapNeeds(worktreePath).required).toBe(false);
    });

    it('does not flag a missing "husky.sh" artifact when the repository never uses Husky at all (no .husky/ directory)', async () => {
      // A "prepare" script exists and node_modules is installed, but
      // there is no .husky/ directory at all -- nothing proves this
      // repository uses Husky, so nothing should be inferred about it.
      await writeFile(
        join(worktreePath, "package.json"),
        JSON.stringify({ name: "demo", scripts: { prepare: "some-other-tool setup" } }),
        "utf8",
      );
      await mkdir(join(worktreePath, "node_modules"), { recursive: true });

      expect(detectBootstrapNeeds(worktreePath).required).toBe(false);
    });

    it("does not run the targeted check at all when dependencies aren't installed -- the full-install finding already covers it", async () => {
      // node_modules is absent entirely -- checkNodeEcosystem's finding
      // should be the only one; installing will run "prepare" itself.
      await writeFile(
        join(worktreePath, "package.json"),
        JSON.stringify({ name: "demo", scripts: { prepare: "husky install" } }),
        "utf8",
      );
      await mkdir(join(worktreePath, ".husky"), { recursive: true });

      const result = detectBootstrapNeeds(worktreePath);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].suggestedCommand).toBe("npm install");
    });

    it("does not flag anything when no prepare script is declared at all, even if .husky/ exists without its generated artifact", async () => {
      await writeFile(join(worktreePath, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
      await mkdir(join(worktreePath, "node_modules"), { recursive: true });
      await mkdir(join(worktreePath, ".husky"), { recursive: true });

      expect(detectBootstrapNeeds(worktreePath).required).toBe(false);
    });
  });
});
