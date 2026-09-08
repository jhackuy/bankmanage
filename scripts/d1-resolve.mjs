/**
 * scripts/d1-resolve.mjs
 *
 * Resolve managed Cloudflare D1 configuration from environment bindings.
 * This script NEVER prints secret or account-specific values to stdout.
 * It is the first boundary the M5 deployment harness crosses before
 * `wrangler d1 migrations apply` or `wrangler deploy` is invoked. Missing
 * or malformed configuration must abort here, before any Cloudflare API
 * call, to avoid accidental mutation against a real database.
 *
 * Public API:
 *   resolveManagedD1Config(env) -> {
 *     ok, missing[], invalid[], config: { accountId, databaseId } | null
 *   }
 *
 * CLI mode (when invoked directly):
 *   node scripts/d1-resolve.mjs
 *   -> prints NAMES ONLY (missing/invalid) and exits 0 or 1.
 */

const REQUIRED_NAMES = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID"];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLACEHOLDER_UUID = "00000000-0000-0000-0000-000000000000";

// Conservative: a hex-like token 32 or 64 chars is the canonical
// Cloudflare account id (32-hex) or a full UUID. Real Cloudflare account
// ids are also 32-hex, so we accept either shape but reject obvious
// placeholders and zero-length.
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const PLACEHOLDER_ACCOUNT_ID = "0".repeat(32);

export function resolveManagedD1Config(env) {
  const missing = REQUIRED_NAMES.filter((name) => !env[name]?.trim());

  const invalid = [];
  const accountRaw = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const databaseRaw = env.CLOUDFLARE_D1_DATABASE_ID?.trim() ?? "";

  if (accountRaw && (accountRaw === PLACEHOLDER_ACCOUNT_ID || !ACCOUNT_ID_PATTERN.test(accountRaw))) {
    invalid.push("CLOUDFLARE_ACCOUNT_ID");
  }

  if (databaseRaw && (databaseRaw === PLACEHOLDER_UUID || !UUID_PATTERN.test(databaseRaw))) {
    invalid.push("CLOUDFLARE_D1_DATABASE_ID");
  }

  const ok = missing.length === 0 && invalid.length === 0;

  return {
    ok,
    missing,
    invalid: [...new Set(invalid)],
    // The structured config is internal. Callers that need it MUST NOT
    // log it directly; pass it through a typed narrow boundary. The CLI
    // mode below intentionally never prints it.
    config: ok
      ? {
          accountId: accountRaw,
          databaseId: databaseRaw,
        }
      : null,
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
  const result = resolveManagedD1Config(process.env);
  if (result.ok) {
    process.stdout.write("D1_RESOLVE_PASS\n");
    process.exitCode = 0;
  } else {
    const names = [...new Set([...result.missing, ...result.invalid])];
    process.stdout.write(`BLOCKED_OWNER_ONLY_ACTION\nD1_MISSING_OR_INVALID=${names.join(",")}\n`);
    process.exitCode = 1;
  }
}
