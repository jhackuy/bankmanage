const REQUIRED_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_D1_DATABASE_ID",
  "BANKMANAGE_PILOT_BASE_URL",
  "MINI_APP_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_ALLOWED_USER_IDS",
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLACEHOLDER_UUID = "00000000-0000-0000-0000-000000000000";

function parseHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function validatePilotConfig(env) {
  const missing = REQUIRED_NAMES.filter((name) => !env[name]?.trim());
  const invalid = [];

  const d1Id = env.CLOUDFLARE_D1_DATABASE_ID?.trim() ?? "";
  if (d1Id && (d1Id === PLACEHOLDER_UUID || !UUID_PATTERN.test(d1Id))) {
    invalid.push("CLOUDFLARE_D1_DATABASE_ID");
  }

  const baseUrlValue = env.BANKMANAGE_PILOT_BASE_URL?.trim() ?? "";
  const miniAppUrlValue = env.MINI_APP_URL?.trim() ?? "";
  const baseUrl = baseUrlValue ? parseHttpsUrl(baseUrlValue) : null;
  const miniAppUrl = miniAppUrlValue ? parseHttpsUrl(miniAppUrlValue) : null;
  if (baseUrlValue && !baseUrl) invalid.push("BANKMANAGE_PILOT_BASE_URL");
  if (miniAppUrlValue && !miniAppUrl) invalid.push("MINI_APP_URL");
  if (baseUrl && miniAppUrl && baseUrl.origin !== miniAppUrl.origin) {
    invalid.push("MINI_APP_URL");
  }

  const allowlistValue = env.TELEGRAM_ALLOWED_USER_IDS?.trim() ?? "";
  if (allowlistValue) {
    const ids = allowlistValue.split(",").map((value) => value.trim());
    if (ids.length !== 2 || ids.some((id) => !/^\d+$/.test(id)) || new Set(ids).size !== 2) {
      invalid.push("TELEGRAM_ALLOWED_USER_IDS");
    }
  }

  return {
    ok: missing.length === 0 && invalid.length === 0,
    missing,
    invalid: [...new Set(invalid)],
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = validatePilotConfig(process.env);
  if (result.ok) {
    process.stdout.write("PREFLIGHT_PASS\n");
  } else {
    const names = [...new Set([...result.missing, ...result.invalid])];
    process.stdout.write(`BLOCKED_OWNER_ONLY_ACTION\nMISSING_OR_INVALID=${names.join(",")}\n`);
    process.exitCode = 1;
  }
}
