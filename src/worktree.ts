/** Git worktree isolation for subagents and teammates.
 *
 * DSH children share one workspace and only get advisory `writeScopes`
 * overlap warnings. A worktree gives a child its own checkout and branch, so
 * parallel writers cannot overwrite each other. A worktree with no changes is
 * removed when its child settles; one with work stays for the parent to
 * review, merge, or discard. Nothing is merged automatically. */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Worktree {
  /** Main checkout the worktree belongs to. */
  repo: string;
  path: string;
  branch: string;
  /** Commit the branch started from. */
  base: string;
  /** Path of the requested cwd inside the repo ("" at the root, otherwise "sub/dir/"). */
  prefix: string;
  /** True once the worktree and branch were deleted because the child changed nothing. */
  removed?: boolean;
}

export const defaultWorktreeRoot = (): string => join(homedir(), ".pi", "agent", "pi-dsh", "worktrees");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

const slugOf = (label: string): string => {
  const words = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return `${words || "task"}-${randomBytes(3).toString("hex")}`;
};

/** The child's working directory inside its worktree, mirroring the parent's position in the repo. */
export const worktreeCwd = (wt: Worktree): string => resolve(wt.path, wt.prefix);

export async function createWorktree(cwd: string, label: string, root = defaultWorktreeRoot()): Promise<Worktree> {
  let repo: string;
  try { repo = await git(cwd, ["rev-parse", "--show-toplevel"]); }
  catch { throw new Error(`isolation "worktree" needs a git repository, and ${cwd} is not inside one`); }
  let base: string;
  try { base = await git(repo, ["rev-parse", "HEAD"]); }
  catch { throw new Error(`isolation "worktree" needs a commit to branch from, and ${repo} has none`); }
  const prefix = await git(cwd, ["rev-parse", "--show-prefix"]);
  const slug = slugOf(label);
  const parent = join(root, `${basename(repo)}-${createHash("sha1").update(repo).digest("hex").slice(0, 8)}`);
  mkdirSync(parent, { recursive: true });
  const wt: Worktree = { repo, path: join(parent, slug), branch: `pi-dsh/${slug}`, base, prefix };
  await git(repo, ["worktree", "add", "-b", wt.branch, wt.path, base]);
  return wt;
}

export interface WorktreeState { changedFiles: number; commits: number }

export async function inspectWorktree(wt: Worktree): Promise<WorktreeState> {
  const status = await git(wt.path, ["status", "--porcelain"]);
  const ahead = await git(wt.path, ["rev-list", "--count", `${wt.base}..HEAD`]);
  return { changedFiles: status === "" ? 0 : status.split("\n").length, commits: Number(ahead) };
}

export async function removeWorktree(wt: Worktree): Promise<void> {
  await git(wt.repo, ["worktree", "remove", "--force", wt.path]);
  await git(wt.repo, ["branch", "-D", wt.branch]).catch(() => undefined); // already gone is fine
  wt.removed = true;
}

/** Bring back a worktree that was removed (or deleted by hand) so a resumed child has its directory again. */
export async function ensureWorktree(wt: Worktree): Promise<void> {
  if (!wt.removed && existsSync(wt.path)) return;
  await git(wt.repo, ["worktree", "prune"]);
  wt.base = await git(wt.repo, ["rev-parse", "HEAD"]);
  const branchExists = await git(wt.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${wt.branch}`]).then(() => true, () => false);
  await git(wt.repo, branchExists ? ["worktree", "add", wt.path, wt.branch] : ["worktree", "add", "-b", wt.branch, wt.path, wt.base]);
  wt.removed = false;
}

/** Close out a settled child's worktree: delete it when untouched, else describe how to keep or drop the work. */
export async function settleWorktree(wt: Worktree): Promise<string> {
  if (wt.removed) return "";
  try {
    const state = await inspectWorktree(wt);
    if (state.changedFiles === 0 && state.commits === 0) { await removeWorktree(wt); return ""; }
    return `[worktree kept: ${wt.path} on branch ${wt.branch}, ${state.changedFiles} uncommitted file${state.changedFiles === 1 ? "" : "s"}, ${state.commits} commit${state.commits === 1 ? "" : "s"} ahead of ${wt.base.slice(0, 8)}. `
      + `Review: git -C ${wt.path} diff HEAD. Keep: commit there, then git merge ${wt.branch}. Discard: git worktree remove --force ${wt.path} && git branch -D ${wt.branch}]`;
  } catch (err) {
    return `[worktree left in place at ${wt.path} (branch ${wt.branch}); its state could not be read: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
