/**
 * harness-micro-repair-decide.test.ts
 *
 * Verifies that scripts/harness-micro-repair-decide.mjs correctly decides
 * whether the bounded micro-repair step in `.github/workflows/claude-implement.yml`
 * should continue to final validation/preservation or hard-exit.
 *
 * The script is the exact decision function the workflow invokes after the
 * micro-repair provider returns. The acceptance criteria for issue #44 require
 * that a non-zero/empty micro-repair response with repository changes must NOT
 * bypass validation or preservation; the test below pins that behaviour.
 *
 * The script is invoked as a black-box CLI exactly as the GitHub workflow
 * invokes it. Each test calls the script with the triple
 * (claude_status, subtype, has_repo_changes) and asserts on the parsed JSON
 * output plus the exit code.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts", "harness-micro-repair-decide.mjs");

interface MicroRepairDecision {
  action: "success" | "continue_with_changes" | "exit_no_changes";
  reason: string;
}

function runDecision(
  claudeStatus: number,
  subtype: string,
  hasRepoChanges: boolean
): { exit: number; result: MicroRepairDecision } {
  try {
    const stdout = execFileSync(
      "node",
      [SCRIPT, String(claudeStatus), subtype, hasRepoChanges ? "true" : "false"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return { exit: 0, result: JSON.parse(stdout.trim()) as MicroRepairDecision };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    const stdout = e.stdout ?? "";
    return {
      exit: e.status ?? 1,
      result: JSON.parse(
        stdout.trim() || '{"action":"exit_no_changes","reason":"unknown"}'
      ) as MicroRepairDecision,
    };
  }
}

describe("harness micro-repair decision (issue #44 regression guard)", () => {
  it("returns usage error when claude-status is missing", () => {
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

  it("returns usage error when claude-status is not a number", () => {
    let captured = "";
    try {
      execFileSync("node", [SCRIPT, "not-a-number", "", "false"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      captured = `${e.status ?? "?"}:${e.stderr ?? ""}`;
    }
    expect(captured).toMatch(/^2:/);
    expect(captured).toMatch(/invalid claude-status/);
  });

  it("classifies a clean exit as success and continues", () => {
    const { exit, result } = runDecision(0, "", false);
    expect(exit).toBe(0);
    expect(result.action).toBe("success");
    expect(result.reason).toBe("claude_exit_zero");
  });

  it("classifies a clean exit with empty subtype as success", () => {
    const { exit, result } = runDecision(0, "error_max_turns", true);
    expect(exit).toBe(0);
    expect(result.action).toBe("success");
    expect(result.reason).toBe("claude_exit_zero");
  });
});

describe("harness micro-repair decision: provider failure with repository changes", () => {
  it("continues when subtype is error_max_turns and there are repo changes (existing behaviour)", () => {
    const { exit, result } = runDecision(1, "error_max_turns", true);
    expect(exit).toBe(0);
    expect(result.action).toBe("continue_with_changes");
    expect(result.reason).toBe("error_max_turns_with_changes");
  });

  it("continues when subtype is empty and there are repo changes (issue #44 regression)", () => {
    const { exit, result } = runDecision(1, "", true);
    expect(exit).toBe(0);
    expect(result.action).toBe("continue_with_changes");
    expect(result.reason).toBe("non_zero_with_changes");
  });

  it("continues when subtype is an unrelated error string and there are repo changes", () => {
    const { exit, result } = runDecision(137, "some_other_error", true);
    expect(exit).toBe(0);
    expect(result.action).toBe("continue_with_changes");
    expect(result.reason).toBe("non_zero_with_changes");
  });

  it("continues when subtype is empty, status is large, and there are repo changes", () => {
    const { exit, result } = runDecision(134, "", true);
    expect(exit).toBe(0);
    expect(result.action).toBe("continue_with_changes");
    expect(result.reason).toBe("non_zero_with_changes");
  });
});

describe("harness micro-repair decision: provider failure with no repository changes", () => {
  it("exits when there are no repo changes and subtype is error_max_turns", () => {
    const { exit, result } = runDecision(1, "error_max_turns", false);
    expect(exit).toBe(1);
    expect(result.action).toBe("exit_no_changes");
    expect(result.reason).toBe("non_zero_no_changes");
  });

  it("exits when there are no repo changes and subtype is empty (no preservation possible)", () => {
    const { exit, result } = runDecision(1, "", false);
    expect(exit).toBe(1);
    expect(result.action).toBe("exit_no_changes");
    expect(result.reason).toBe("non_zero_no_changes");
  });

  it("exits when there are no repo changes and subtype is an unrelated error string", () => {
    const { exit, result } = runDecision(137, "some_other_error", false);
    expect(exit).toBe(1);
    expect(result.action).toBe("exit_no_changes");
    expect(result.reason).toBe("non_zero_no_changes");
  });
});
