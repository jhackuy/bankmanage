#!/usr/bin/env node
/**
 * scripts/harness-micro-repair-decide.mjs
 *
 * Decides whether the bounded micro-repair step in
 * `.github/workflows/claude-implement.yml` should continue to final
 * validation/preservation or hard-exit, given:
 *   - the Claude provider exit status,
 *   - the subtype reported in the Claude result JSON,
 *   - whether the repository currently has task changes (tracked or untracked,
 *     excluding `.agent-task/**`).
 *
 * Decision matrix:
 *   claude_status == 0                        -> success
 *   subtype == "error_max_turns" && changes   -> continue_with_changes (existing behaviour)
 *   has_repo_changes                          -> continue_with_changes (preserve progress)
 *   otherwise                                 -> exit_no_changes (no preservation possible)
 *
 * Usage:
 *   node scripts/harness-micro-repair-decide.mjs <claude-status> <subtype> <has-repo-changes>
 *
 * Output:
 *   JSON to stdout: { action, reason }
 *
 * Exit codes:
 *   0 = continue (do not hard-exit)
 *   1 = exit (no preservation possible)
 *   2 = usage error
 */

import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

export function decideMicroRepair({ claudeStatus, subtype, hasRepoChanges }) {
  if (claudeStatus === 0) {
    return { action: "success", reason: "claude_exit_zero" };
  }
  if (subtype === "error_max_turns" && hasRepoChanges) {
    return { action: "continue_with_changes", reason: "error_max_turns_with_changes" };
  }
  if (hasRepoChanges) {
    return { action: "continue_with_changes", reason: "non_zero_with_changes" };
  }
  return { action: "exit_no_changes", reason: "non_zero_no_changes" };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [, , statusArg, subtypeArg, changesArg] = process.argv;
  if (statusArg === undefined || statusArg === "") {
    process.stderr.write(
      "Usage: harness-micro-repair-decide.mjs <claude-status> <subtype> <has-repo-changes>\n"
    );
    process.exit(2);
  }
  const claudeStatus = Number.parseInt(statusArg, 10);
  if (!Number.isFinite(claudeStatus)) {
    process.stderr.write(`harness-micro-repair-decide: invalid claude-status: ${statusArg}\n`);
    process.exit(2);
  }
  const subtype = subtypeArg ?? "";
  const hasRepoChanges = changesArg === "true";
  const result = decideMicroRepair({ claudeStatus, subtype, hasRepoChanges });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.action === "exit_no_changes" ? 1 : 0);
}
