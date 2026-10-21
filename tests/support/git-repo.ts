import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

/** A throwaway repository with one commit (pkg/a.txt) and a sibling directory for worktrees. */
export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pi-dsh-wt-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "pkg"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "pkg", "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { repo, root: join(dir, "worktrees") };
}
