/**
 * harness-narrow-failure.test.ts
 *
 * Verifies that scripts/harness-narrow-failure.mjs correctly classifies
 * validation logs as narrow (micro-repair allowed) or broad (no retry).
 *
 * The script is invoked as a black-box CLI exactly as the GitHub workflow
 * invokes it. Each test writes a fixture log to a temp file, runs the
 * script with that log path, and asserts on the parsed JSON output
 * (plus the exit code).
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(process.cwd(), "scripts", "harness-narrow-failure.mjs");

interface NarrowResult {
  narrow: boolean;
  reason: string;
  files: string[];
  error_count: number;
}

function runDetector(log: string, changedPaths?: string[]): { exit: number; result: NarrowResult } {
  const dir = mkdtempSync(join(tmpdir(), "harness-narrow-"));
  try {
    const logPath = join(dir, "validation.log");
    writeFileSync(logPath, log, "utf8");
    const args = [SCRIPT, logPath];
    if (changedPaths) {
      const changedPathsPath = join(dir, "changed-paths.txt");
      writeFileSync(changedPathsPath, changedPaths.join("\n") + "\n", "utf8");
      args.push(changedPathsPath);
    }
    try {
      const stdout = execFileSync("node", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exit: 0, result: JSON.parse(stdout.trim()) as NarrowResult };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      const stdout = e.stdout ?? "";
      return {
        exit: e.status ?? 1,
        result: JSON.parse(
          stdout.trim() || '{"narrow":false,"reason":"unknown","files":[],"error_count":0}'
        ) as NarrowResult,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runDetectorExpectingFailure(log: string): { exit: number } {
  const dir = mkdtempSync(join(tmpdir(), "harness-narrow-"));
  try {
    const logPath = join(dir, "validation.log");
    writeFileSync(logPath, log, "utf8");
    try {
      execFileSync("node", [SCRIPT, logPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exit: 0 };
    } catch (err) {
      const e = err as { status?: number };
      return { exit: e.status ?? 1 };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("harness narrow-failure detector", () => {
  it("returns usage error when called without a log path", () => {
    let captured = "";
    try {
      execFileSync("node", [SCRIPT], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      captured = `${e.status ?? "?"}:${e.stderr ?? ""}`;
    }
    expect(captured).toMatch(/^2:/);
    expect(captured).toMatch(/Usage/);
  });

  it("classifies a single-file TypeScript error as narrow", () => {
    const log = [
      "src/services/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "Found 1 error in src/services/foo.ts.",
      "",
    ].join("\n");
    const { exit, result } = runDetector(log);
    expect(exit).toBe(0);
    expect(result.narrow).toBe(true);
    expect(result.reason).toBe("narrow");
    expect(result.files).toEqual(["src/services/foo.ts"]);
    expect(result.error_count).toBe(1);
  });

  it("classifies a single failing Vitest file as narrow", () => {
    const log = [
      " RUN  v3.2.7 /home/runner/work/repo",
      "",
      " × src/services/foo.test.ts > foo > bar",
      "   × should do something 1ms",
      "     → expected true to be false",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed (1)",
      "",
    ].join("\n");
    const { exit, result } = runDetector(log);
    expect(exit).toBe(0);
    expect(result.narrow).toBe(true);
    expect(result.files).toContain("src/services/foo.test.ts");
  });

  it("classifies a single ESLint file error as narrow", () => {
    const log = [
      "/home/runner/work/repo/src/services/foo.ts",
      "  42:7  error  Unexpected any  @typescript-eslint/no-explicit-any",
      "",
      "✖ 1 problem (1 error, 0 warnings)",
      "",
    ].join("\n");
    const { exit, result } = runDetector(log);
    expect(exit).toBe(0);
    expect(result.narrow).toBe(true);
    expect(result.files).toEqual(["/home/runner/work/repo/src/services/foo.ts"]);
  });

  it("classifies a Prettier formatting failure as narrow", () => {
    const log = [
      "Checking formatting...",
      "Code style issues found in src/services/foo.ts. Run Prettier with --write to fix.",
      "",
    ].join("\n");
    const { exit, result } = runDetector(log);
    expect(exit).toBe(0);
    expect(result.narrow).toBe(true);
    expect(result.files).toEqual(["src/services/foo.ts"]);
  });

  it("rejects an empty log as broad (no deterministic failures recognised)", () => {
    const log = "All checks passed successfully.\n";
    const { exit, result } = runDetector(log);
    expect(exit).toBe(1);
    expect(result.narrow).toBe(false);
    expect(result.reason).toBe("no_deterministic_failures_recognized");
    expect(result.files).toEqual([]);
    expect(result.error_count).toBe(0);
  });

  it("rejects a log mentioning more than MAX_FILES distinct files as broad", () => {
    const lines = [
      "a.ts(1,1): error TS2322: bad",
      "b.ts(2,2): error TS2322: bad",
      "c.ts(3,3): error TS2322: bad",
      "d.ts(4,4): error TS2322: bad",
      "e.ts(5,5): error TS2322: bad",
      "f.ts(6,6): error TS2322: bad",
    ];
    const { exit, result } = runDetector(lines.join("\n"));
    expect(exit).toBe(1);
    expect(result.narrow).toBe(false);
    expect(result.reason).toBe("too_many_files_6");
    expect(result.files).toHaveLength(6);
  });

  it("rejects a log with many errors in a single file as broad", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 25; i++) {
      lines.push(`src/services/foo.ts(${i},1): error TS2322: bad ${i}`);
    }
    const { exit, result } = runDetector(lines.join("\n"));
    expect(exit).toBe(1);
    expect(result.narrow).toBe(false);
    expect(result.reason).toBe("too_many_errors_25");
    expect(result.files).toEqual(["src/services/foo.ts"]);
  });

  it("counts a single file referenced by multiple categories only once", () => {
    const log = [
      "src/services/foo.ts(10,5): error TS2322: bad",
      "src/services/foo.test.ts > foo > bar",
      "  × should do something 5ms",
      "    → expected true to be false",
      "Code style issues found in src/services/foo.ts. Run Prettier with --write to fix.",
    ].join("\n");
    const { exit, result } = runDetector(log);
    expect(exit).toBe(0);
    expect(result.narrow).toBe(true);
    expect(result.files.sort()).toEqual(["src/services/foo.test.ts", "src/services/foo.ts"]);
    // typescript + vitest_arrow + prettier = 3 markers for two files
    expect(result.error_count).toBe(3);
  });

  it("ignores lines that look like paths but contain no recognisable failure marker", () => {
    const log = ["src/services/foo.ts", "  // a comment line", "Done."].join("\n");
    const { exit, result } = runDetector(log);
    expect(exit).toBe(1);
    expect(result.narrow).toBe(false);
    expect(result.reason).toBe("no_deterministic_failures_recognized");
  });

  it("the exit code matches the narrow decision (0 for narrow, 1 for broad)", () => {
    const narrowLog = "src/services/foo.ts(1,1): error TS2322: bad\n";
    const broadLog = "Everything passed.\n";
    expect(runDetector(narrowLog).exit).toBe(0);
    expect(runDetectorExpectingFailure(broadLog).exit).toBe(1);
  });
});

describe("harness narrow-failure detector scoped to the task's changed paths", () => {
  it("accepts a failure in a file the task actually changed", () => {
    const log = "src/services/foo.ts(10,5): error TS2322: bad\n";
    const { exit, result } = runDetector(log, ["src/services/foo.ts", "tests/unit/foo.test.ts"]);
    expect(exit).toBe(0);
    expect(result.narrow).toBe(true);
    expect(result.reason).toBe("narrow");
  });

  it("rejects a failure in a file outside the task's changed paths", () => {
    const log = "src/services/unrelated.ts(10,5): error TS2322: bad\n";
    const { exit, result } = runDetector(log, ["src/services/foo.ts"]);
    expect(exit).toBe(1);
    expect(result.narrow).toBe(false);
    expect(result.reason).toBe("unrelated_files_1");
    expect(result.files).toEqual(["src/services/unrelated.ts"]);
  });

  it("rejects the whole set when only some failing files are in scope", () => {
    const log = [
      "src/services/foo.ts(10,5): error TS2322: bad",
      "src/services/unrelated.ts(12,1): error TS2345: bad",
    ].join("\n");
    const { exit, result } = runDetector(log, ["src/services/foo.ts"]);
    expect(exit).toBe(1);
    expect(result.narrow).toBe(false);
    expect(result.reason).toBe("unrelated_files_1");
  });

  it("matches absolute log paths against repo-relative changed paths", () => {
    const log = [
      "/home/runner/work/repo/src/services/foo.ts",
      "  42:7  error  Unexpected any  @typescript-eslint/no-explicit-any",
      "",
    ].join("\n");
    const { exit, result } = runDetector(log, ["src/services/foo.ts"]);
    expect(exit).toBe(0);
    expect(result.narrow).toBe(true);
  });

  it("rejects every failure when the task changed no paths", () => {
    const log = "src/services/foo.ts(10,5): error TS2322: bad\n";
    const { exit, result } = runDetector(log, []);
    expect(exit).toBe(1);
    expect(result.narrow).toBe(false);
    expect(result.reason).toBe("unrelated_files_1");
  });
});
