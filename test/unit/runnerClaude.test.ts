import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempRepo } from "../helpers/tempRepo.js";
import {
  setupFakeClaude,
  teardownFakeClaude,
  nonExistentClaudeBin,
  type FakeClaudeEnv,
} from "../helpers/fakeClaude.js";

describe("Claude Code runner (core/runners/claude.ts)", () => {
  describe("binary resolution", () => {
    const originalBin = process.env.CE_CLAUDE_BIN;

    afterEach(() => {
      if (originalBin === undefined) delete process.env.CE_CLAUDE_BIN;
      else process.env.CE_CLAUDE_BIN = originalBin;
    });

    it('defaults to "claude"', async () => {
      delete process.env.CE_CLAUDE_BIN;
      const { claudeBinary } = await import("../../src/core/runners/claude.js");
      expect(claudeBinary()).toBe("claude");
    });

    it("CE_CLAUDE_BIN overrides the resolved binary", async () => {
      process.env.CE_CLAUDE_BIN = "/custom/path/to/claude";
      const { claudeBinary } = await import("../../src/core/runners/claude.js");
      expect(claudeBinary()).toBe("/custom/path/to/claude");
    });
  });

  describe("launch", () => {
    let fakeClaude: FakeClaudeEnv;
    let worktreePath: string;

    beforeEach(async () => {
      fakeClaude = await setupFakeClaude();
      worktreePath = await mkdtemp(join(tmpdir(), "ce-harness-claude-launch-"));
    });

    afterEach(async () => {
      await teardownFakeClaude(fakeClaude);
      await rm(worktreePath, { recursive: true, force: true });
    });

    it("launches with the given cwd and env, no arguments (interactive handoff)", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      const result = await CLAUDE_RUNNER.launch({
        cwd: worktreePath,
        env: { CE_WORKSPACE: "/tmp/some-workspace" },
      });

      expect(result).toEqual({ launched: true, exitCode: 0 });
      const launch = JSON.parse(await readFile(fakeClaude.outputFile, "utf8"));
      expect(launch.cwd).toBe(await realpathOf(worktreePath));
      expect(launch.argv).toEqual([]);
      expect(launch.env.CE_WORKSPACE).toBe("/tmp/some-workspace");
    });

    it("uses the CE_CLAUDE_BIN override for the actual spawned binary", async () => {
      // setupFakeClaude already points CE_CLAUDE_BIN at the fake binary --
      // a successful launch (rather than ENOENT) is itself proof the
      // override took effect over the "claude" default.
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const result = await CLAUDE_RUNNER.launch({ cwd: worktreePath, env: {} });
      expect(result.launched).toBe(true);
    });

    it("reports launch failure without throwing when the binary cannot be found", async () => {
      process.env.CE_CLAUDE_BIN = nonExistentClaudeBin(fakeClaude.dir);
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      const result = await CLAUDE_RUNNER.launch({ cwd: worktreePath, env: {} });
      expect(result.launched).toBe(false);
    });

    it("propagates the fake claude's exit code", async () => {
      process.env.FAKE_CLAUDE_EXIT_CODE = "5";
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const result = await CLAUDE_RUNNER.launch({ cwd: worktreePath, env: {} });
      expect(result).toEqual({ launched: true, exitCode: 5 });
    });

    it("formatLaunchCommand renders cwd, env assignments, and the resolved binary", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const command = CLAUDE_RUNNER.formatLaunchCommand("/tmp/wt", { CE_WORKSPACE: "/tmp/ws" });
      expect(command).toContain('cd "/tmp/wt"');
      expect(command).toContain('CE_WORKSPACE="/tmp/ws"');
      expect(command.trim().endsWith(process.env.CE_CLAUDE_BIN as string)).toBe(true);
    });
  });

  describe("writeConfig", () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await createTempRepo();
    });

    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it("materializes <worktree>/.claude/{commands,skills} from the canonical templates, and returns every path it wrote", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { templatesRoot } = await import("../../src/core/templates.js");

      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });
      expect(written).toContain(join("commands", "workspace.md"));
      expect(written).toContain(join("commands", "adversarial-review.md"));
      expect(written).toContain(join("skills", "openspec-sync-specs"));

      const claudeDir = join(repoDir, ".claude");
      expect(existsSync(join(claudeDir, "commands", "workspace.md"))).toBe(true);
      expect(existsSync(join(claudeDir, "commands", "adversarial-review.md"))).toBe(true);
      expect(existsSync(join(claudeDir, "skills", "openspec-sync-specs", "SKILL.md"))).toBe(true);

      const copied = await readFile(join(claudeDir, "commands", "workspace.md"), "utf8");
      const source = await readFile(join(templatesRoot(), "commands", "workspace.md"), "utf8");
      expect(copied).toBe(source);
    });

    it("adds each written path individually to the repository's local, never-committed exclude file", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      await CLAUDE_RUNNER.writeConfig({ workspacePath: "/tmp/unused-workspace", worktreePath: repoDir });

      const excludeContent = await readFile(join(repoDir, ".git", "info", "exclude"), "utf8");
      expect(excludeContent).toContain("/.claude/commands/workspace.md");
      expect(excludeContent).toContain("/.claude/skills/openspec-sync-specs");
      // Never a single blanket pattern -- that would also hide unrelated,
      // non-harness-owned content the repository might keep under .claude.
      expect(excludeContent).not.toMatch(/^\/\.claude$/m);

      const { execa } = await import("execa");
      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });

    it('leaves a colliding, UNTRACKED command file untouched, warns about it by name, and still installs every non-colliding template', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      // Deliberately never `git add`/`git commit`ed -- untracked,
      // local-only content (e.g. the user's own personal command) that
      // happens to share a name with one of ce-harness's own templates.
      const preExistingDir = join(repoDir, ".claude", "commands");
      await mkdir(preExistingDir, { recursive: true });
      await writeFile(join(preExistingDir, "workspace.md"), "the user's own untracked command\n", "utf8");

      // vi.spyOn reuses (rather than replaces) an already-mocked
      // console.error across tests in this file, so mockClear() here
      // guarantees this test only sees calls it caused itself.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      errorSpy.mockClear();
      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });

      // The colliding entry is never claimed...
      expect(written).not.toContain(join("commands", "workspace.md"));
      // ...but nothing else pays for that collision.
      expect(written).toContain(join("commands", "adversarial-review.md"));
      expect(written).toContain(join("skills", "openspec-sync-specs"));

      // The pre-existing file survives exactly as it was.
      expect(await readFile(join(preExistingDir, "workspace.md"), "utf8")).toBe(
        "the user's own untracked command\n",
      );
      // Every other template was installed alongside it.
      expect(existsSync(join(repoDir, ".claude", "commands", "adversarial-review.md"))).toBe(true);
      expect(existsSync(join(repoDir, ".claude", "skills", "openspec-sync-specs", "SKILL.md"))).toBe(
        true,
      );

      expect(
        errorSpy.mock.calls.some(
          (call) => String(call[0]).includes("commands/workspace.md") && String(call[0]).includes("/workspace"),
        ),
      ).toBe(true);

      // The untouched, non-harness-owned file was never added to the
      // exclude file, so it still shows up as a real untracked change --
      // but the harness-written siblings were, so they do not. (Matching
      // core/git.ts's own statusPorcelain, `--untracked-files=all` is
      // needed here so an untracked directory expands to individual
      // files instead of collapsing to one summary line.)
      const { execa } = await import("execa");
      const status = await execa("git", [
        "-C",
        repoDir,
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      expect(status.stdout).toContain(".claude/commands/workspace.md");
      expect(status.stdout).not.toContain("adversarial-review.md");
      const excludeContent = existsSync(join(repoDir, ".git", "info", "exclude"))
        ? await readFile(join(repoDir, ".git", "info", "exclude"), "utf8")
        : "";
      expect(excludeContent).not.toContain("/.claude/commands/workspace.md");
      expect(excludeContent).toContain("/.claude/commands/adversarial-review.md");
    });

    it('leaves a colliding, TRACKED command file untouched (committed by the repository itself), and still installs every non-colliding template', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { execa } = await import("execa");

      const trackedDir = join(repoDir, ".claude", "commands");
      await mkdir(trackedDir, { recursive: true });
      await writeFile(join(trackedDir, "workspace.md"), "the repository's own tracked command\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a .claude/commands/workspace.md"]);

      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });

      expect(written).not.toContain(join("commands", "workspace.md"));
      expect(written).toContain(join("commands", "adversarial-review.md"));
      expect(await readFile(join(trackedDir, "workspace.md"), "utf8")).toBe(
        "the repository's own tracked command\n",
      );
      expect(existsSync(join(repoDir, ".claude", "commands", "adversarial-review.md"))).toBe(true);

      // Clean: the tracked file is unmodified (so it shows nothing on its
      // own), and every harness-written sibling was excluded individually.
      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });

    it("installs ce-harness commands and skills alongside an unrelated, pre-existing repository skill (the Oz scenario), leaving it untouched", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { execa } = await import("execa");

      // The repository's base branch already tracks its own, unrelated
      // skill -- nothing about its name collides with any ce-harness
      // command or skill template.
      const ownSkillDir = join(repoDir, ".claude", "skills", "setup-service-infra");
      await mkdir(ownSkillDir, { recursive: true });
      await writeFile(join(ownSkillDir, "SKILL.md"), "the repository's own skill\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a setup-service-infra skill"]);

      // vi.spyOn reuses (rather than replaces) an already-mocked
      // console.error across tests in this file, so mockClear() here
      // guarantees this test only sees calls it caused itself.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      errorSpy.mockClear();
      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });

      // Zero collisions -- every ce-harness command and skill installs.
      expect(written).toContain(join("commands", "adversarial-review.md"));
      expect(written).toContain(join("commands", "explore.md"));
      expect(written).toContain(join("commands", "propose.md"));
      expect(written).toContain(join("commands", "apply.md"));
      expect(written).toContain(join("commands", "verify.md"));
      expect(written).toContain(join("commands", "archive.md"));
      expect(written).toContain(join("commands", "workspace.md"));
      expect(written).toContain(join("skills", "openspec-sync-specs"));
      expect(errorSpy).not.toHaveBeenCalled();

      // /adversarial-review is materialized.
      expect(existsSync(join(repoDir, ".claude", "commands", "adversarial-review.md"))).toBe(true);

      // The repository's own skill is completely untouched.
      expect(await readFile(join(ownSkillDir, "SKILL.md"), "utf8")).toBe(
        "the repository's own skill\n",
      );

      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });

    it('leaves a colliding, TRACKED skill directory untouched (committed by the repository itself), warns about it by name, and still installs every other command and skill', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { execa } = await import("execa");

      // The repository's base branch already tracks its own content at
      // the exact same path as one of ce-harness's own skill templates.
      const trackedSkillDir = join(repoDir, ".claude", "skills", "openspec-sync-specs");
      await mkdir(trackedSkillDir, { recursive: true });
      await writeFile(
        join(trackedSkillDir, "SKILL.md"),
        "the repository's own openspec-sync-specs skill\n",
        "utf8",
      );
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a colliding openspec-sync-specs skill"]);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      errorSpy.mockClear();
      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });

      // The colliding skill is never claimed...
      expect(written).not.toContain(join("skills", "openspec-sync-specs"));
      // ...but every command and the other skill still install.
      expect(written).toContain(join("commands", "adversarial-review.md"));
      expect(written).toContain(join("skills", "composition-patterns"));

      // The repository's own skill content survives exactly as it was.
      expect(await readFile(join(trackedSkillDir, "SKILL.md"), "utf8")).toBe(
        "the repository's own openspec-sync-specs skill\n",
      );
      expect(existsSync(join(repoDir, ".claude", "commands", "adversarial-review.md"))).toBe(true);
      expect(existsSync(join(repoDir, ".claude", "skills", "composition-patterns", "SKILL.md"))).toBe(
        true,
      );

      expect(
        errorSpy.mock.calls.some(
          (call) =>
            String(call[0]).includes("skills/openspec-sync-specs") &&
            String(call[0]).includes('"openspec-sync-specs" skill'),
        ),
      ).toBe(true);

      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });

    it('degrades gracefully instead of crashing when ".claude" itself already exists as a FILE, warns about it, and never touches it', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { execa } = await import("execa");

      await writeFile(join(repoDir, ".claude"), "not a directory\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a .claude FILE"]);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      errorSpy.mockClear();

      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });

      // Nothing at all could be installed -- neither commands nor skills
      // have anywhere to go -- but this must not throw.
      expect(written).toEqual([]);
      expect(existsSync(join(repoDir, ".claude", "commands"))).toBe(false);
      expect(existsSync(join(repoDir, ".claude", "skills"))).toBe(false);

      // The repository's own file survives exactly as it was.
      expect(await readFile(join(repoDir, ".claude"), "utf8")).toBe("not a directory\n");

      expect(
        errorSpy.mock.calls.some(
          (call) => String(call[0]).includes('".claude"') && String(call[0]).includes("not a directory"),
        ),
      ).toBe(true);

      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });

    it('degrades gracefully when ".claude/commands" exists as a FILE, installing skills normally while warning about commands', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { execa } = await import("execa");

      await mkdir(join(repoDir, ".claude"), { recursive: true });
      await writeFile(join(repoDir, ".claude", "commands"), "not a directory\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a .claude/commands FILE"]);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      errorSpy.mockClear();

      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });

      // No command could be installed...
      expect(written.some((path) => path.startsWith(join("commands", "")))).toBe(false);
      // ...but skills are entirely unaffected by the blocked sibling.
      expect(written).toContain(join("skills", "openspec-sync-specs"));
      expect(existsSync(join(repoDir, ".claude", "skills", "openspec-sync-specs", "SKILL.md"))).toBe(
        true,
      );

      // The repository's own file survives exactly as it was.
      expect(await readFile(join(repoDir, ".claude", "commands"), "utf8")).toBe("not a directory\n");

      expect(
        errorSpy.mock.calls.some(
          (call) =>
            String(call[0]).includes(join(".claude", "commands")) &&
            String(call[0]).includes("not a directory"),
        ),
      ).toBe(true);

      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });

    it('degrades gracefully when ".claude/skills" exists as a FILE, installing commands normally while warning about skills', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { execa } = await import("execa");

      await mkdir(join(repoDir, ".claude"), { recursive: true });
      await writeFile(join(repoDir, ".claude", "skills"), "not a directory\n", "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a .claude/skills FILE"]);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      errorSpy.mockClear();

      const written = await CLAUDE_RUNNER.writeConfig({
        workspacePath: "/tmp/unused-workspace",
        worktreePath: repoDir,
      });

      // No skill could be installed...
      expect(written.some((path) => path.startsWith(join("skills", "")))).toBe(false);
      // ...but commands are entirely unaffected by the blocked sibling.
      expect(written).toContain(join("commands", "adversarial-review.md"));
      expect(existsSync(join(repoDir, ".claude", "commands", "adversarial-review.md"))).toBe(true);

      // The repository's own file survives exactly as it was.
      expect(await readFile(join(repoDir, ".claude", "skills"), "utf8")).toBe("not a directory\n");

      expect(
        errorSpy.mock.calls.some(
          (call) =>
            String(call[0]).includes(join(".claude", "skills")) &&
            String(call[0]).includes("not a directory"),
        ),
      ).toBe(true);

      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });
  });

  describe("refreshConfig", () => {
    let repoDir: string;
    let tempDir: string;
    let fakeTemplatesRoot: string;
    const originalTemplatesRoot = process.env.CE_TEMPLATES_ROOT;

    beforeEach(async () => {
      repoDir = await createTempRepo();
      tempDir = await mkdtemp(join(tmpdir(), "ce-harness-refresh-templates-"));
      fakeTemplatesRoot = join(tempDir, "templates");
      await mkdir(join(fakeTemplatesRoot, "commands"), { recursive: true });
      process.env.CE_TEMPLATES_ROOT = fakeTemplatesRoot;
    });

    afterEach(async () => {
      if (originalTemplatesRoot === undefined) delete process.env.CE_TEMPLATES_ROOT;
      else process.env.CE_TEMPLATES_ROOT = originalTemplatesRoot;
      await rm(repoDir, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    });

    async function writeTemplate(name: string, content: string): Promise<void> {
      await writeFile(join(fakeTemplatesRoot, "commands", name), content, "utf8");
    }

    const unusedPaths = { workspacePath: "/tmp/unused-workspace" };

    it("refreshing an unchanged harness-managed file is a no-op: reported unchanged, content untouched, hash recorded", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      await writeTemplate("verify.md", "v1 content\n");
      const written = await CLAUDE_RUNNER.writeConfig({ ...unusedPaths, worktreePath: repoDir });

      // Legacy shape: commandsManaged already lists it, no hash recorded yet
      // (exactly every real workspace that predates this feature).
      const workspace = baseWorkspace({
        worktreePath: repoDir,
        runnerWorktreeArtifacts: { commandsManaged: written },
      });

      const refreshed = await CLAUDE_RUNNER.refreshConfig({ ...unusedPaths, worktreePath: repoDir }, workspace);

      expect(refreshed.result.unchanged).toContain(join("commands", "verify.md"));
      expect(refreshed.result.updated).not.toContain(join("commands", "verify.md"));
      expect(refreshed.result.skipped).not.toContain(join("commands", "verify.md"));
      expect(refreshed.commandsManagedHashes[join("commands", "verify.md")]).toBeTruthy();
      expect(await readFile(join(repoDir, ".claude", "commands", "verify.md"), "utf8")).toBe("v1 content\n");
    });

    it("updates an outdated harness-managed template: on-disk content matches its recorded hash, so the newer template content wins", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { sha256File } = await import("../../src/core/templates.js");
      await writeTemplate("verify.md", "v1 content\n");
      const written = await CLAUDE_RUNNER.writeConfig({ ...unusedPaths, worktreePath: repoDir });
      const v1Hash = await sha256File(join(repoDir, ".claude", "commands", "verify.md"));

      // A workspace one refresh cycle in: v1's hash is already on record.
      const workspaceAtV1 = baseWorkspace({
        worktreePath: repoDir,
        runnerWorktreeArtifacts: {
          commandsManaged: written,
          commandsManagedHashes: { [join("commands", "verify.md")]: v1Hash },
        },
      });

      // ce-harness's own template moves on to v2.
      await writeTemplate("verify.md", "v2 content -- updated\n");

      const refreshed = await CLAUDE_RUNNER.refreshConfig(
        { ...unusedPaths, worktreePath: repoDir },
        workspaceAtV1,
      );

      expect(refreshed.result.updated).toContain(join("commands", "verify.md"));
      expect(await readFile(join(repoDir, ".claude", "commands", "verify.md"), "utf8")).toBe(
        "v2 content -- updated\n",
      );
      expect(refreshed.commandsManagedHashes[join("commands", "verify.md")]).toBe(
        await sha256File(join(repoDir, ".claude", "commands", "verify.md")),
      );
    });

    it("preserves a user-customized harness-managed file: on-disk content no longer matches the recorded hash, so refresh leaves it completely alone", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { sha256File } = await import("../../src/core/templates.js");
      await writeTemplate("verify.md", "v1 content\n");
      const written = await CLAUDE_RUNNER.writeConfig({ ...unusedPaths, worktreePath: repoDir });
      const v1Hash = await sha256File(join(repoDir, ".claude", "commands", "verify.md"));

      // The user hand-edits the file after ce-harness wrote it...
      await writeFile(
        join(repoDir, ".claude", "commands", "verify.md"),
        "my own customized verify command\n",
        "utf8",
      );
      // ...and, separately, ce-harness's own template also moved on.
      await writeTemplate("verify.md", "v2 content -- updated\n");

      const workspace = baseWorkspace({
        worktreePath: repoDir,
        runnerWorktreeArtifacts: {
          commandsManaged: written,
          commandsManagedHashes: { [join("commands", "verify.md")]: v1Hash },
        },
      });

      const refreshed = await CLAUDE_RUNNER.refreshConfig({ ...unusedPaths, worktreePath: repoDir }, workspace);

      expect(refreshed.result.skipped).toContain(join("commands", "verify.md"));
      expect(refreshed.result.updated).not.toContain(join("commands", "verify.md"));
      expect(await readFile(join(repoDir, ".claude", "commands", "verify.md"), "utf8")).toBe(
        "my own customized verify command\n",
      );
    });

    it("never bootstraps a path the workspace never recorded as harness-owned at all -- a genuine pre-existing collision is always skipped", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      await writeTemplate("verify.md", "template content\n");
      await mkdir(join(repoDir, ".claude", "commands"), { recursive: true });
      await writeFile(
        join(repoDir, ".claude", "commands", "verify.md"),
        "not ce-harness's -- collided at ce start\n",
        "utf8",
      );

      // writeConfig would itself have skipped this as a collision --
      // commandsManaged never names it.
      const workspace = baseWorkspace({
        worktreePath: repoDir,
        runnerWorktreeArtifacts: { commandsManaged: [] },
      });

      const refreshed = await CLAUDE_RUNNER.refreshConfig({ ...unusedPaths, worktreePath: repoDir }, workspace);

      expect(refreshed.result.skipped).toContain(join("commands", "verify.md"));
      expect(await readFile(join(repoDir, ".claude", "commands", "verify.md"), "utf8")).toBe(
        "not ce-harness's -- collided at ce start\n",
      );
    });

    it('never bootstraps anything under the legacy all-or-nothing "commandsManaged: true" shape -- no individual paths to trust, so an outdated file is left alone rather than blindly updated', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      await writeTemplate("verify.md", "v1 content\n");
      const written = await CLAUDE_RUNNER.writeConfig({ ...unusedPaths, worktreePath: repoDir });
      expect(written).toContain(join("commands", "verify.md"));

      // The template moves on -- were this the per-item array shape, this
      // would be the ordinary bootstrap-then-update case (see the
      // "unchanged" test above proves the reverse: no change, no bootstrap
      // needed at all). The boolean shape has no per-item list to
      // bootstrap from in the first place.
      await writeTemplate("verify.md", "v2 content -- updated\n");

      const workspace = baseWorkspace({
        worktreePath: repoDir,
        runnerWorktreeArtifacts: { commandsManaged: true }, // legacy boolean, no per-item list
      });

      const refreshed = await CLAUDE_RUNNER.refreshConfig({ ...unusedPaths, worktreePath: repoDir }, workspace);

      expect(refreshed.result.skipped).toContain(join("commands", "verify.md"));
      expect(refreshed.result.updated).toEqual([]);
      expect(await readFile(join(repoDir, ".claude", "commands", "verify.md"), "utf8")).toBe(
        "v1 content\n",
      );
    });

    it("writes a brand-new template entry that didn't exist when this workspace was first provisioned", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      await writeTemplate("verify.md", "v1 content\n");
      const written = await CLAUDE_RUNNER.writeConfig({ ...unusedPaths, worktreePath: repoDir });

      // A newer ce-harness ships a brand-new command template.
      await writeTemplate("brand-new-command.md", "brand new\n");

      const workspace = baseWorkspace({
        worktreePath: repoDir,
        runnerWorktreeArtifacts: { commandsManaged: written },
      });

      const refreshed = await CLAUDE_RUNNER.refreshConfig({ ...unusedPaths, worktreePath: repoDir }, workspace);

      expect(refreshed.result.updated).toContain(join("commands", "brand-new-command.md"));
      expect(refreshed.commandsManaged).toContain(join("commands", "brand-new-command.md"));
      expect(await readFile(join(repoDir, ".claude", "commands", "brand-new-command.md"), "utf8")).toBe(
        "brand new\n",
      );
    });

    it("is idempotent: refreshing a second time (with the first refresh's own persisted output) reports everything unchanged and writes nothing", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      await writeTemplate("verify.md", "v1 content\n");
      const written = await CLAUDE_RUNNER.writeConfig({ ...unusedPaths, worktreePath: repoDir });

      const workspace = baseWorkspace({
        worktreePath: repoDir,
        runnerWorktreeArtifacts: { commandsManaged: written },
      });
      const first = await CLAUDE_RUNNER.refreshConfig({ ...unusedPaths, worktreePath: repoDir }, workspace);

      const workspaceAfterFirst = baseWorkspace({
        worktreePath: repoDir,
        runnerWorktreeArtifacts: {
          commandsManaged: first.commandsManaged,
          commandsManagedHashes: first.commandsManagedHashes,
        },
      });
      const second = await CLAUDE_RUNNER.refreshConfig(
        { ...unusedPaths, worktreePath: repoDir },
        workspaceAfterFirst,
      );

      expect(second.result.updated).toEqual([]);
      expect(second.result.skipped).toEqual([]);
      expect(second.result.unchanged).toContain(join("commands", "verify.md"));
      expect(second.commandsManagedHashes).toEqual(first.commandsManagedHashes);
      expect(second.commandsManaged.sort()).toEqual(first.commandsManaged.sort());
    });

    it("never touches skills -- deliberately out of scope for this pass", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      await mkdir(join(fakeTemplatesRoot, "skills", "openspec-sync-specs"), { recursive: true });
      await writeFile(
        join(fakeTemplatesRoot, "skills", "openspec-sync-specs", "SKILL.md"),
        "v1 skill\n",
        "utf8",
      );
      await writeTemplate("verify.md", "v1 content\n");
      const written = await CLAUDE_RUNNER.writeConfig({ ...unusedPaths, worktreePath: repoDir });
      expect(written).toContain(join("skills", "openspec-sync-specs"));

      // The skill template changes...
      await writeFile(
        join(fakeTemplatesRoot, "skills", "openspec-sync-specs", "SKILL.md"),
        "v2 skill -- updated\n",
        "utf8",
      );

      const workspace = baseWorkspace({
        worktreePath: repoDir,
        runnerWorktreeArtifacts: { commandsManaged: written },
      });
      const refreshed = await CLAUDE_RUNNER.refreshConfig({ ...unusedPaths, worktreePath: repoDir }, workspace);

      // ...but refreshConfig never reports on it, and the on-disk skill is untouched.
      expect(refreshed.result.updated.some((p) => p.startsWith(join("skills", "")))).toBe(false);
      expect(refreshed.result.unchanged.some((p) => p.startsWith(join("skills", "")))).toBe(false);
      expect(refreshed.result.skipped.some((p) => p.startsWith(join("skills", "")))).toBe(false);
      expect(
        await readFile(join(repoDir, ".claude", "skills", "openspec-sync-specs", "SKILL.md"), "utf8"),
      ).toBe("v1 skill\n");
    });
  });

  describe("writeCodeGraphConfig", () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await createTempRepo();
    });

    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it("writes <worktree>/.mcp.json registering CodeGraph's MCP server, excludes it locally, and returns true", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      const written = await CLAUDE_RUNNER.writeCodeGraphConfig(
        { workspacePath: "/tmp/unused-workspace", worktreePath: repoDir },
        "codegraph",
      );
      expect(written).toBe(true);

      const configPath = join(repoDir, ".mcp.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(await readFile(configPath, "utf8"));
      expect(config.mcpServers.codegraph.command).toBe("codegraph");
      expect(config.mcpServers.codegraph.args).toEqual(["serve", "--mcp", "--path", repoDir]);

      const excludeContent = await readFile(join(repoDir, ".git", "info", "exclude"), "utf8");
      expect(excludeContent).toContain("/.mcp.json");
    });

    it('never overwrites a pre-existing, UNTRACKED ".mcp.json", and returns false', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");

      // Never `git add`/`git commit`ed -- e.g. a personal, local-only MCP
      // config the user already had sitting in their repo.
      await writeFile(join(repoDir, ".mcp.json"), '{"mcpServers":{"personal":{}}}\n', "utf8");

      const written = await CLAUDE_RUNNER.writeCodeGraphConfig(
        { workspacePath: "/tmp/unused-workspace", worktreePath: repoDir },
        "codegraph",
      );
      expect(written).toBe(false);

      expect(await readFile(join(repoDir, ".mcp.json"), "utf8")).toBe(
        '{"mcpServers":{"personal":{}}}\n',
      );
      const { execa } = await import("execa");
      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toContain(".mcp.json");
      const excludeContent = existsSync(join(repoDir, ".git", "info", "exclude"))
        ? await readFile(join(repoDir, ".git", "info", "exclude"), "utf8")
        : "";
      expect(excludeContent).not.toContain("/.mcp.json");
    });

    it('never overwrites a pre-existing, TRACKED ".mcp.json" (committed by the repository itself), and returns false', async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const { execa } = await import("execa");

      await writeFile(join(repoDir, ".mcp.json"), '{"mcpServers":{"repoOwn":{}}}\n', "utf8");
      await execa("git", ["-C", repoDir, "add", "."]);
      await execa("git", ["-C", repoDir, "commit", "-m", "vendor a .mcp.json"]);

      const written = await CLAUDE_RUNNER.writeCodeGraphConfig(
        { workspacePath: "/tmp/unused-workspace", worktreePath: repoDir },
        "codegraph",
      );
      expect(written).toBe(false);

      expect(await readFile(join(repoDir, ".mcp.json"), "utf8")).toBe(
        '{"mcpServers":{"repoOwn":{}}}\n',
      );
      const status = await execa("git", ["-C", repoDir, "status", "--porcelain"]);
      expect(status.stdout).toBe("");
    });
  });

  describe("buildEnv", () => {
    it("returns no runner-specific env vars -- Claude discovers .claude/.mcp.json from cwd alone", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      const workspace = baseWorkspace();

      expect(CLAUDE_RUNNER.buildEnv(workspace)).toEqual({});
    });
  });

  describe("managedWorktreeRelativePaths", () => {
    it("returns [] when runnerWorktreeArtifacts is absent (legacy workspace, or nothing was written)", async () => {
      const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
      expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(baseWorkspace())).toEqual([]);
    });

    describe("per-item array form (current writeConfig contract)", () => {
      it("returns each entry as a .claude-relative path", async () => {
        const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
        const workspace = baseWorkspace({
          runnerWorktreeArtifacts: {
            commandsManaged: [join("commands", "adversarial-review.md"), join("skills", "openspec-sync-specs")],
          },
        });
        expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(workspace)).toEqual([
          join(".claude", "commands", "adversarial-review.md"),
          join(".claude", "skills", "openspec-sync-specs"),
        ]);
      });

      it("never includes an unrelated, pre-existing repository entry the array does not name (e.g. setup-service-infra)", async () => {
        const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
        const workspace = baseWorkspace({
          runnerWorktreeArtifacts: { commandsManaged: [join("commands", "adversarial-review.md")] },
        });
        const managed = CLAUDE_RUNNER.managedWorktreeRelativePaths(workspace);
        expect(managed).not.toContain(join(".claude", "skills", "setup-service-infra"));
        expect(managed).not.toContain(".claude");
      });

      it("returns [] when the array is empty -- every template collided", async () => {
        const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
        const workspace = baseWorkspace({ runnerWorktreeArtifacts: { commandsManaged: [] } });
        expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(workspace)).toEqual([]);
      });

      it('includes ".mcp.json" alongside the per-item paths when mcpManaged is true', async () => {
        const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
        const workspace = baseWorkspace({
          runnerWorktreeArtifacts: {
            commandsManaged: [join("commands", "workspace.md")],
            mcpManaged: true,
          },
        });
        expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(workspace)).toEqual([
          join(".claude", "commands", "workspace.md"),
          ".mcp.json",
        ]);
      });
    });

    describe("legacy boolean form (workspace.yml persisted before per-item tracking existed)", () => {
      it("returns [\".claude\"] when only commandsManaged is true", async () => {
        const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
        const workspace = baseWorkspace({ runnerWorktreeArtifacts: { commandsManaged: true } });
        expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(workspace)).toEqual([".claude"]);
      });

      it('returns [".claude", ".mcp.json"] when both are managed', async () => {
        const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
        const workspace = baseWorkspace({
          runnerWorktreeArtifacts: { commandsManaged: true, mcpManaged: true },
        });
        expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(workspace)).toEqual([".claude", ".mcp.json"]);
      });

      it("never includes a path whose flag is false -- a pre-existing, safely-skipped path is never claimed", async () => {
        const { CLAUDE_RUNNER } = await import("../../src/core/runners/claude.js");
        const workspace = baseWorkspace({
          runnerWorktreeArtifacts: { commandsManaged: false, mcpManaged: false },
        });
        expect(CLAUDE_RUNNER.managedWorktreeRelativePaths(workspace)).toEqual([]);
      });
    });
  });
});

function baseWorkspace(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    project: "demo",
    repositoryPath: "/tmp/demo-repo",
    issue: "issue-1",
    sanitizedIssue: "issue-1",
    baseBranch: "main",
    internalBranch: "ce-harness/issue-1",
    worktreePath: "/tmp/demo-worktree",
    workspacePath: "/tmp/demo-workspace",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
