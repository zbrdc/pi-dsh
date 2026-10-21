import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, makeRepo } from "./support/git-repo.ts";
import { createWorktree, ensureWorktree, inspectWorktree, settleWorktree, worktreeCwd } from "../src/worktree.ts";

test("a worktree branches from HEAD and mirrors the requested subdirectory", async () => {
  const { repo, root } = makeRepo();
  const wt = await createWorktree(join(repo, "pkg"), "Fix the parser!", root);
  assert.equal(wt.base, git(repo, "rev-parse", "HEAD"));
  assert.match(wt.branch, /^pi-dsh\/fix-the-parser-[0-9a-f]{6}$/);
  assert.equal(worktreeCwd(wt), join(wt.path, "pkg"));
  assert.equal(git(worktreeCwd(wt), "show", "HEAD:pkg/a.txt"), "one");
  assert.deepEqual(await inspectWorktree(wt), { changedFiles: 0, commits: 0 });
});

test("an untouched worktree is removed together with its branch", async () => {
  const { repo, root } = makeRepo();
  const wt = await createWorktree(repo, "idle", root);
  assert.equal(await settleWorktree(wt), "");
  assert.equal(existsSync(wt.path), false);
  assert.equal(wt.removed, true);
  assert.equal(git(repo, "branch", "--list", wt.branch), "");
});

test("a worktree with uncommitted or committed work is kept and described", async () => {
  const { repo, root } = makeRepo();
  const dirty = await createWorktree(repo, "dirty", root);
  writeFileSync(join(dirty.path, "new.txt"), "x");
  const note = await settleWorktree(dirty);
  assert.match(note, /^\[worktree kept: /);
  assert.ok(note.includes(dirty.path) && note.includes(dirty.branch));
  assert.match(note, /1 uncommitted file, 0 commits/);
  assert.equal(existsSync(dirty.path), true);

  const committed = await createWorktree(repo, "committed", root);
  writeFileSync(join(committed.path, "c.txt"), "y");
  git(committed.path, "add", "-A");
  git(committed.path, "commit", "-q", "-m", "work");
  assert.match(await settleWorktree(committed), /0 uncommitted files, 1 commit ahead/);
});

test("outside a git repository the error says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dsh-nogit-"));
  await assert.rejects(createWorktree(dir, "x", join(dir, "wt")), /needs a git repository/);
});

test("a repository without commits cannot be branched from", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dsh-empty-"));
  git(dir, "init", "-q", "-b", "main");
  await assert.rejects(createWorktree(dir, "x", join(dir, "wt")), /needs a commit/);
});

test("ensureWorktree recreates a removed worktree from the current HEAD", async () => {
  const { repo, root } = makeRepo();
  const wt = await createWorktree(repo, "again", root);
  await settleWorktree(wt);
  writeFileSync(join(repo, "later.txt"), "z");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "later");
  await ensureWorktree(wt);
  assert.equal(wt.removed, false);
  assert.equal(wt.base, git(repo, "rev-parse", "HEAD"));
  assert.equal(git(wt.path, "show", "HEAD:later.txt"), "z");
});
