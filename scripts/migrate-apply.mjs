/**
 * scripts/migrate-apply.mjs
 *
 * Plan a forward migration apply against a managed Cloudflare D1 database.
 *
 * SAFETY CONTRACT (SPEC §11, ADR-001):
 *   - The script never invokes `wrangler d1 migrations apply` on its own.
 *     It enumerates the migration files in lexicographic order and emits a
 *     deterministic plan that the deployment harness or an OWNER can act on.
 *   - The script never echoes secret-shaped environment values.
 *   - The script is INERT by default. Mutation requires both the
 *     `BANKMANAGE_MIGRATIONS_APPLY_TOKEN` environment variable to match a
 *     non-empty value AND the caller to set `--apply` explicitly.
 *   - Even with both, this script only PRINTS the wrangler command
 *     (names + version, no secrets); it does not exec wrangler.
 *
 * Public API:
 *   listForwardMigrations(migrationsDir) -> string[]
 *   planManagedD1Apply(env, { migrationsDir }) -> {
 *     ok, missing[], invalid[], preconditions: { applyTokenRequired },
 *     migrations: string[],  // ordered list (names only)
 *     commandPlan: string[]  // parameterized wrangler commands (names only)
 *   }
 *
 * CLI mode:
 *   node scripts/migrate-apply.mjs [--plan-only] [--apply]
 *
 * The CLI is intentionally names-only. There is no path that prints the
 * managed D1 database id or the apply token value.
 */

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, "..", "migrations");

const REQUIRED_PRECONDITIONS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID"];

/**
 * Return the migration filenames in deterministic lexicographic order.
 * The empty-listing case throws — a project without migrations must
 * not be silently treated as a no-op, because the schema in
 * `migrations/` is required for every managed D1 database.
 */
export function listForwardMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error("migrate-apply: no migration files found");
  }
  return files;
}

/**
 * Plan a managed D1 migration apply. The result is informational: it
 * carries the ordered migration list and a series of wrangler-shaped
 * commands a deployment runner can act on. The function NEVER prints
 * secret values and is safe to call in CI after preflight has passed.
 *
 * Preconditions (fail closed, see above):
 *   - env.CLOUDFLARE_ACCOUNT_ID present
 *   - env.CLOUDFLARE_D1_DATABASE_ID present
 *   - migrations directory non-empty
 *
 * The optional `applyToken` parameter models the owner-gated apply
 * intent: if the deployment runner provides a non-empty token AND the
 * caller passes `apply: true`, the plan includes the destructive
 * `wrangler d1 migrations apply` command. Otherwise the plan is
 * `wrangler d1 migrations list` style only — safe to print.
 */
export function planManagedD1Apply(
  env,
  { migrationsDir = DEFAULT_MIGRATIONS_DIR, apply = false, applyToken = "" } = {}
) {
  const missing = REQUIRED_PRECONDITIONS.filter((name) => !env[name]?.trim());

  const invalid = [];
  // Migrations themselves are names-only; we never inspect their content.
  let migrations = [];
  let migrationsError = null;
  try {
    migrations = listForwardMigrations(migrationsDir);
  } catch (err) {
    migrationsError = err instanceof Error ? err.message : "unknown";
  }

  const ownerIntent = apply && typeof applyToken === "string" && applyToken.length > 0;

  const commandPlan = ownerIntent
    ? ["wrangler d1 migrations apply DB --env pilot --remote"]
    : ["wrangler d1 migrations list DB --env pilot --remote"];

  return {
    ok: missing.length === 0 && invalid.length === 0 && migrationsError === null,
    missing,
    invalid: [...new Set(invalid)],
    migrationsError,
    migrations,
    commandPlan,
    ownerIntent,
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === new URL(process.argv[1], "file:").href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const applyFlag = argv.includes("--apply");
  const planOnly = argv.includes("--plan-only") || !applyFlag;
  const token = process.env["BANKMANAGE_MIGRATIONS_APPLY_TOKEN"] ?? "";

  const plan = planManagedD1Apply(process.env, { apply: applyFlag, applyToken: token });

  if (!plan.ok) {
    const names = [
      ...new Set([...plan.missing, ...plan.invalid, ...(plan.migrationsError ? ["MIGRATIONS_DIR"] : [])]),
    ];
    process.stdout.write(`BLOCKED_OWNER_ONLY_ACTION\nMISSING_OR_INVALID=${names.join(",")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`MIGRATIONS_COUNT=${plan.migrations.length}\n`);
    // plan.ownerIntent requires BOTH --apply flag AND a non-empty apply token.
    // Without the token, we stay plan-only regardless of the --apply flag.
    if (planOnly || !plan.ownerIntent) {
      process.stdout.write("MIGRATIONS_PLAN_ONLY\n");
      process.exitCode = 0;
    } else {
      // Even in --apply mode we only print the names-only command plan;
      // actual mutation must be performed by a separate gated step.
      process.stdout.write(`MIGRATIONS_APPLY_INTENT=YES\nCOMMAND_COUNT=${plan.commandPlan.length}\n`);
      process.exitCode = 0;
    }
  }
}
