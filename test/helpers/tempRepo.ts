import { execa } from "execa";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a temporary Git repository with one commit on `main` and
 * returns its path. The initial commit embeds a random nonce so two
 * independent calls never produce byte-identical root commits: a commit
 * hash is a function of tree content + author/committer + message +
 * timestamp (second resolution), so two repos created back-to-back with
 * otherwise-identical fixture content really can collide on the exact
 * same root commit -- and Project Identity (core/projectIdentity.ts)
 * treats a shared root commit as real evidence of the same project, so
 * two genuinely unrelated fixture repos coincidentally "sharing" one
 * would be a false positive in exactly the tests meant to prove they
 * never do.
 */
export async function createTempRepo(prefix = "ce-harness-repo-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await execa("git", ["init", "--initial-branch=main", dir]);
  await execa("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execa("git", ["-C", dir, "config", "user.name", "Test User"]);
  await writeFile(join(dir, "README.md"), `hello\n\n<!-- ${randomUUID()} -->\n`, "utf8");
  await execa("git", ["-C", dir, "add", "."]);
  await execa("git", ["-C", dir, "commit", "-m", "initial commit"]);
  return dir;
}

export async function makeDirty(repoDir: string): Promise<void> {
  await writeFile(join(repoDir, "untracked.txt"), "dirty\n", "utf8");
}

/**
 * Creates a bare repository with one commit on `defaultBranch` (its only
 * branch, and the one its `HEAD` symref points at), suitable for use as
 * a Git remote in tests -- entirely over the local filesystem, no real
 * network involved.
 */
export async function createBareRemote(
  defaultBranch: string,
  prefix = "ce-harness-remote-",
): Promise<string> {
  const bareDir = await mkdtemp(join(tmpdir(), prefix));
  const seedDir = await mkdtemp(join(tmpdir(), "ce-harness-remote-seed-"));
  try {
    await execa("git", ["init", `--initial-branch=${defaultBranch}`, seedDir]);
    await execa("git", ["-C", seedDir, "config", "user.email", "test@example.com"]);
    await execa("git", ["-C", seedDir, "config", "user.name", "Test User"]);
    await writeFile(join(seedDir, "README.md"), "hello\n", "utf8");
    await execa("git", ["-C", seedDir, "add", "."]);
    await execa("git", ["-C", seedDir, "commit", "-m", "initial commit"]);
    await execa("git", ["clone", "--bare", seedDir, bareDir]);
  } finally {
    await rm(seedDir, { recursive: true, force: true });
  }
  return bareDir;
}

/**
 * Clones `remoteDir` to a fresh temporary directory and returns its
 * path -- a realistic local clone: the remote's default branch is
 * checked out locally, and `refs/remotes/origin/HEAD` is set exactly as
 * a real `git clone` would set it.
 */
export async function cloneRepo(remoteDir: string, prefix = "ce-harness-clone-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await execa("git", ["clone", remoteDir, dir]);
  await execa("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execa("git", ["-C", dir, "config", "user.name", "Test User"]);
  return dir;
}
