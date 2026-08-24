import { readdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Deregisters `worktreePath` from `repoPath`'s Git bookkeeping (removes
 * `.git/worktrees/<name>`) while leaving the working directory itself
 * completely untouched -- exactly the state a `git worktree remove
 * --force` call can leave behind when its recursive filesystem delete
 * fails partway through (e.g. a running Docker container still holding
 * a bind mount inside it). Used to construct that "orphaned worktree"
 * state deterministically in tests, without depending on Docker Desktop
 * or macOS ACL behavior at all.
 *
 * Locates the right admin directory by its `gitdir` file (which points
 * back at `<worktreePath>/.git`) rather than assuming its name matches
 * the worktree's basename, since Git does not guarantee that.
 */
export async function deregisterWorktreeBookkeeping(repoPath: string, worktreePath: string): Promise<void> {
  const adminRoot = join(repoPath, ".git", "worktrees");
  const entries = await readdir(adminRoot);
  // Git stores (and expects to find) the fully symlink-resolved form
  // here (e.g. macOS's "/tmp" as "/private/tmp") -- realpath both sides
  // so this holds regardless of how `worktreePath` itself was spelled.
  const targetGitdir = join(await realpath(worktreePath), ".git");
  for (const entry of entries) {
    const gitdirFile = join(adminRoot, entry, "gitdir");
    const content = (await readFile(gitdirFile, "utf8")).trim();
    if (content === targetGitdir) {
      await rm(join(adminRoot, entry), { recursive: true, force: true });
      return;
    }
  }
  throw new Error(`No .git/worktrees/ entry found for "${worktreePath}" -- test setup is wrong.`);
}
