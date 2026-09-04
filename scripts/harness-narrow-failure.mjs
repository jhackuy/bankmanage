#!/usr/bin/env node
/**
 * scripts/harness-narrow-failure.mjs
 *
 * Decides whether the remaining failure set in a deterministic validation log
 * is "narrow" enough to warrant exactly one micro-repair pass.
 *
 * "Narrow" means:
 *   - The log contains at least one recognisable deterministic failure.
 *   - The failures mention at most MAX_FILES distinct task files.
 *   - The total number of recognisable failure markers is at most MAX_ERROR_LINES.
 *
 * The detector recognises:
 *   - TypeScript compiler errors: `path/file.ts(line,col): error TS1234`
 *   - Vitest FAIL lines:         ` FAIL  path/file.test.ts`
 *   - Vitest arrow failures:     ` ×  ... path/file.test.ts > ...`
 *   - ESLint file path + error:  `path.ts` line followed by `  N:N  error`
 *   - Prettier formatting:       `Code style issues found in path`
 *   - Vite build failures:       `Failed to compile` followed by file path
 *
 * Usage:
 *   node scripts/harness-narrow-failure.mjs <validation-log-path>
 *
 * Output:
 *   JSON to stdout: { narrow, reason, files: [...], error_count }
 *
 * Exit codes:
 *   0 = narrow (micro-repair allowed)
 *   1 = broad / not narrow (do not retry)
 *   2 = usage error
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const MAX_FILES = 5;
const MAX_ERROR_LINES = 20;

const PATTERNS = [
  // TypeScript compiler: path/to/file.ts(line,col): error TS1234: ...
  { name: "typescript", regex: /^([^\s:()]+\.tsx?)\(\d+,\d+\):\s*error\s+(TS\d+)/gm },
  // Vitest FAIL line (top-level file summary)
  { name: "vitest_fail", regex: /^\s*FAIL\s+(\S+\.test\.[jt]sx?)\b/gm },
  // Vitest verbose arrow failure: ` ×  path/to/file.test.ts > describe > name`
  { name: "vitest_arrow", regex: /^\s*[×✖]\s+(?:.*?\s+)?(\S+\.test\.[jt]sx?)\b/gm },
  // Vitest test path on its own line: `path/to/file.test.ts > describe > name`
  { name: "vitest_path", regex: /^(\S+\.test\.[jt]sx?)\s+>\s+/gm },
  // ESLint file path on its own line followed by `  N:N  error|warning`
  { name: "eslint", regex: /^(\S+\.(?:ts|tsx|js|jsx|mjs|cjs))\s*\n\s+\d+:\d+\s+(?:error|warning)/gm },
  // Prettier: "Code style issues found in path/to/file.ext" (stop at trailing punctuation/space)
  { name: "prettier", regex: /Code style issues found in (\S+?\.(?:ts|tsx|js|jsx|mjs|cjs))(?=[. ])/g },
  // Vite/Rollup build failure: "Failed to compile" then file path on the next line
  { name: "vite_build", regex: /Failed to compile[^\n]*\n[^\n]*?([^\s()]+\.(?:ts|tsx|js|jsx|mjs|cjs))/g },
];

export function analyzeFailureNarrowness(log) {
  const foundFiles = new Set();
  const errors = [];

  for (const { name, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(log)) !== null) {
      const file = match[1];
      if (!file) continue;
      foundFiles.add(file);
      errors.push({ name, file });
    }
  }

  const files = [...foundFiles].sort();
  let narrow = false;
  let reason;

  if (foundFiles.size === 0) {
    reason = "no_deterministic_failures_recognized";
  } else if (foundFiles.size > MAX_FILES) {
    reason = `too_many_files_${foundFiles.size}`;
  } else if (errors.length > MAX_ERROR_LINES) {
    reason = `too_many_errors_${errors.length}`;
  } else {
    narrow = true;
    reason = "narrow";
  }

  return { narrow, reason, files, error_count: errors.length };
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
  const logPath = process.argv[2];
  if (!logPath) {
    process.stderr.write("Usage: harness-narrow-failure.mjs <validation-log-path>\n");
    process.exit(2);
  }
  const log = readFileSync(logPath, "utf8");
  const result = analyzeFailureNarrowness(log);
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.narrow ? 0 : 1);
}
