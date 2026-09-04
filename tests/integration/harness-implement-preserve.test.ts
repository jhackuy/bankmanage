/**
 * harness-implement-preserve.test.ts
 *
 * Smoke test for the Claude implementation workflow's change-detection
 * discipline. The GitHub workflow in `.github/workflows/claude-implement.yml`
 * uses `git status --porcelain --untracked-files=all -- . ':(exclude).agent-task/**'`
 * to detect task changes (both tracked and untracked) before pushing.
 *
 * This integration test proves that the exact command shapes used by the
 * workflow:
 *   1. Reports a committed/tracked file modification.
 *   2. Reports a brand-new untracked implementation file.
 *   3. Reports a brand-new untracked test file.
 *   4. Excludes the `.agent-task/` scratch directory from the report.
 *   5. Stage every task change while keeping `.agent-task/` out of the commit
 *      and still readable on disk for the post-push preservation comment.
 *
 * If any of these contracts regress, the harness can lose recoverable
 * implementation work even when it survived the run.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

interface RepoFixture {
  root: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function setupRepo(): RepoFixture {
  const root = mkdtempSync(join(tmpdir(), "harness-preserve-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  // Initial commit so HEAD exists and `git status` reports clean.
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return { root };
}

function teardownRepo(fixture: RepoFixture): void {
  if (existsSync(fixture.root)) {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function detectionOutput(cwd: string): string {
  // The exact command shape used in claude-implement.yml change-detection steps.
  return execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).agent-task/**"],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

function stageTaskChanges(cwd: string): void {
  // The exact staging command shape used in the claude-implement.yml commit step.
  git(cwd, ["add", "-A", "--", ".", ":(exclude).agent-task/**"]);
}

describe("claude-implement.yml change detection preserves tracked and untracked files", () => {
  let repo: RepoFixture;

  beforeEach(() => {
    repo = setupRepo();
  });

  afterEach(() => {
    teardownRepo(repo);
  });

  it("reports no changes on a clean repo", () => {
    expect(detectionOutput(repo.root)).toBe("");
  });

  it("reports a tracked-file modification", () => {
    writeFileSync(join(repo.root, "README.md"), "fixture-updated\n");
    const out = detectionOutput(repo.root);
    expect(out).toContain("README.md");
    expect(out.startsWith(" M ")).toBe(true);
  });

  it("reports a brand-new untracked implementation file", () => {
    mkdirSync(dirname(join(repo.root, "src", "foo.ts")), { recursive: true });
    writeFileSync(join(repo.root, "src", "foo.ts"), "export const foo = 1;\n");
    const out = detectionOutput(repo.root);
    expect(out).toContain("src/foo.ts");
    expect(out).toContain("??");
  });

  it("reports a brand-new untracked test file alongside tracked changes", () => {
    writeFileSync(join(repo.root, "README.md"), "fixture-updated\n");
    mkdirSync(dirname(join(repo.root, "tests", "unit", "foo.test.ts")), { recursive: true });
    writeFileSync(join(repo.root, "tests", "unit", "foo.test.ts"), "test('foo', () => {});\n");
    const out = detectionOutput(repo.root);
    expect(out).toContain("README.md");
    expect(out).toContain("tests/unit/foo.test.ts");
  });

  it("excludes the .agent-task scratch directory from detection output", () => {
    mkdirSync(join(repo.root, ".agent-task"), { recursive: true });
    writeFileSync(join(repo.root, ".agent-task", "scratch.txt"), "scratch\n");
    writeFileSync(join(repo.root, "real-change.ts"), "export const x = 1;\n");
    const out = detectionOutput(repo.root);
    expect(out).toContain("real-change.ts");
    expect(out).not.toContain(".agent-task");
  });

  it("the staging discipline preserves both tracked modifications and untracked files in the committed tree", () => {
    writeFileSync(join(repo.root, "README.md"), "fixture-updated\n");
    mkdirSync(dirname(join(repo.root, "src", "new.ts")), { recursive: true });
    writeFileSync(join(repo.root, "src", "new.ts"), "export const newFn = (): number => 42;\n");
    mkdirSync(dirname(join(repo.root, "tests", "unit", "new.test.ts")), { recursive: true });
    writeFileSync(
      join(repo.root, "tests", "unit", "new.test.ts"),
      "test('new', () => { expect(1).toBe(1); });\n"
    );

    stageTaskChanges(repo.root);
    git(repo.root, ["commit", "-q", "-m", "task: simulate implementation"]);
    const staged = git(repo.root, ["diff", "--name-only", "HEAD~1", "HEAD"]);
    const lines = staged.split("\n").filter(Boolean).sort();
    expect(lines).toEqual(["README.md", "src/new.ts", "tests/unit/new.test.ts"].sort());
  });

  it("keeps .agent-task scratch files out of the committed tree but on disk for the preservation comment", () => {
    mkdirSync(join(repo.root, ".agent-task"), { recursive: true });
    writeFileSync(join(repo.root, ".agent-task", "issue.json"), '{"number":1}\n');
    writeFileSync(join(repo.root, ".agent-task", "validation-final.log"), "FAIL\n");
    writeFileSync(join(repo.root, ".agent-task", "changed-paths.txt"), "src/new.ts\n");
    mkdirSync(dirname(join(repo.root, "src", "new.ts")), { recursive: true });
    writeFileSync(join(repo.root, "src", "new.ts"), "export const newFn = (): number => 42;\n");

    stageTaskChanges(repo.root);
    git(repo.root, ["commit", "-q", "-m", "task: simulate implementation"]);

    const treeOutput = git(repo.root, ["ls-tree", "-r", "--name-only", "HEAD"]);
    const tracked = treeOutput.split("\n").filter(Boolean);
    expect(tracked).toContain("src/new.ts");
    expect(tracked.filter((path) => path.startsWith(".agent-task/"))).toEqual([]);

    // The harness still reads these logs after the push to build its issue comment.
    expect(existsSync(join(repo.root, ".agent-task", "validation-final.log"))).toBe(true);
    expect(existsSync(join(repo.root, ".agent-task", "changed-paths.txt"))).toBe(true);
  });

  it("the spawned command exits non-zero only on real git errors, not on dirty status", () => {
    writeFileSync(join(repo.root, "real-change.ts"), "export const x = 1;\n");
    const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repo.root,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("real-change.ts");
  });
});
