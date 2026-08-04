import { execa } from "execa";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a temporary Git repository with one commit on `main` and returns its path. */
export async function createTempRepo(prefix = "ce-harness-repo-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await execa("git", ["init", "--initial-branch=main", dir]);
  await execa("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execa("git", ["-C", dir, "config", "user.name", "Test User"]);
  await writeFile(join(dir, "README.md"), "hello\n", "utf8");
  await execa("git", ["-C", dir, "add", "."]);
  await execa("git", ["-C", dir, "commit", "-m", "initial commit"]);
  return dir;
}

export async function makeDirty(repoDir: string): Promise<void> {
  await writeFile(join(repoDir, "untracked.txt"), "dirty\n", "utf8");
}
