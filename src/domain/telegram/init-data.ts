/**
 * Platform-neutral Telegram Mini App initData verification.
 *
 * Implements the algorithm documented at https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app:
 *
 *   1. Parse the incoming `initData` URL-encoding.
 *   2. Pull out the `hash` field — the rest are `data-check-string` fields.
 *   3. Build the data-check-string: sort the remaining field=value pairs by
 *      field name, join with '\n'.
 *   4. Derive the secret key as HMAC-SHA256("WebAppData", bot_token) — NOT
 *      a raw SHA-256 of the bot token. The literal key string "WebAppData"
 *      is fixed by the Telegram Mini Apps specification.
 *   5. Compute HMAC-SHA256(secret_key, data_check_string) and compare the
 *      64-hex digest to the provided `hash` field in constant time.
 *   6. Check `auth_date` is within the freshness window.
 *
 * The module never throws for expected auth failures — it returns a typed
 * `InitDataVerification` result. Throws are reserved for "invalid argument
 * the caller should never have produced".
 *
 * Uses the global Web Crypto API (`crypto.subtle`) available in both
 * Cloudflare Workers and Node 20+ vitest environments, so it stays portable
 * to the Worker runtime without polyfills.
 */

export const INIT_DATA_HASH_FIELD = "hash";
export const INIT_DATA_USER_FIELD = "user";
export const INIT_DATA_AUTH_DATE_FIELD = "auth_date";

/** Maximum age (seconds) allowed for an initData payload before it is rejected. */
export const DEFAULT_INIT_DATA_MAX_AGE_SECONDS = 3600;

export type InitDataFailureCode = "MALFORMED" | "BAD_HASH" | "EXPIRED" | "MISSING_AUTH_DATE";

export interface InitDataVerified {
  readonly ok: true;
  readonly fields: Readonly<Record<string, string>>;
  readonly userId: string;
  readonly username: string | null;
}

export interface InitDataRejected {
  readonly ok: false;
  readonly code: InitDataFailureCode;
  readonly message: string;
}

export type InitDataVerification = InitDataVerified | InitDataRejected;

/** Lenient URL-encoded string → key/value map. Handles `%xx` hex escapes. */
export function parseInitDataRaw(initData: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof initData !== "string" || initData.length === 0) return out;

  for (const pair of initData.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const rawKey = pair.slice(0, eq);
    const rawVal = pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, "%20"));
    const val = decodeURIComponent(rawVal.replace(/\+/g, "%20"));
    out[key] = val;
  }
  return out;
}

/** Build the Telegram `data-check-string` from the parsed initData fields. */
export function buildDataCheckString(fields: Readonly<Record<string, string>>): string {
  return Object.keys(fields)
    .filter((k) => k !== INIT_DATA_HASH_FIELD)
    .sort()
    .map((k) => `${k}=${fields[k] ?? ""}`)
    .join("\n");
}

/** Constant-time comparison of two hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Decode a JSON-encoded `user` field from initData. Returns (id, username). */
export function parseInitDataUser(
  fields: Readonly<Record<string, string>>
): { id: string; username: string | null; displayName: string | null } | null {
  const userRaw = fields[INIT_DATA_USER_FIELD];
  if (userRaw === undefined || userRaw.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(userRaw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  const id = (obj as Record<string, unknown>)["id"];
  if (typeof id !== "number" && typeof id !== "string") return null;
  const usernameVal = (obj as Record<string, unknown>)["username"];
  const username = typeof usernameVal === "string" ? usernameVal : null;
  const firstName = (obj as Record<string, unknown>)["first_name"];
  const lastName = (obj as Record<string, unknown>)["last_name"];
  const parts: string[] = [];
  if (typeof firstName === "string") parts.push(firstName);
  if (typeof lastName === "string" && lastName.length > 0) parts.push(lastName);
  const displayName = parts.length > 0 ? parts.join(" ") : null;
  return { id: String(id), username, displayName };
}

function hexFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === undefined) continue;
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function bytesFromHex(hex: string): Uint8Array {
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256Bytes(data: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return new Uint8Array(digest);
}

async function hmacSha256Bytes(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

/**
 * Verify a raw initData string against the bot token. Performs signature
 * check and freshness check in one call. `nowSeconds` defaults to the
 * current epoch and is exposed for deterministic tests.
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  options: { maxAgeSeconds?: number; nowSeconds?: number } = {}
): Promise<InitDataVerification> {
  if (typeof initData !== "string" || initData.length === 0) {
    return { ok: false, code: "MALFORMED", message: "initData must be a non-empty string" };
  }
  if (typeof botToken !== "string" || botToken.length === 0) {
    return { ok: false, code: "MALFORMED", message: "botToken must be a non-empty string" };
  }

  const fields = parseInitDataRaw(initData);
  const providedHash = fields[INIT_DATA_HASH_FIELD];
  if (providedHash === undefined || providedHash.length === 0) {
    return { ok: false, code: "MALFORMED", message: "initData missing required 'hash' field" };
  }

  const dataCheckString = buildDataCheckString(fields);
  const secretKey = await hmacSha256BytesFromString(WEB_APP_DATA_KEY, botToken);
  const computed = await hmacSha256Bytes(secretKey, dataCheckString);
  const computedHex = hexFromBytes(computed);

  if (!timingSafeEqualHex(computedHex, providedHash.toLowerCase())) {
    return { ok: false, code: "BAD_HASH", message: "initData signature does not match" };
  }

  const authDateRaw = fields[INIT_DATA_AUTH_DATE_FIELD];
  if (authDateRaw === undefined) {
    return { ok: false, code: "MISSING_AUTH_DATE", message: "initData missing required 'auth_date' field" };
  }
  const authDate = Number.parseInt(authDateRaw, 10);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return {
      ok: false,
      code: "MISSING_AUTH_DATE",
      message: "initData 'auth_date' is not a valid epoch number",
    };
  }
  const maxAge = options.maxAgeSeconds ?? DEFAULT_INIT_DATA_MAX_AGE_SECONDS;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > maxAge) {
    return { ok: false, code: "EXPIRED", message: "initData is older than the allowed freshness window" };
  }
  if (authDate - nowSeconds > maxAge) {
    // Allow some clock skew forward but not unbounded replay-from-future
    return { ok: false, code: "EXPIRED", message: "initData auth_date is unreasonably far in the future" };
  }

  const user = parseInitDataUser(fields);
  if (user === null) {
    return { ok: false, code: "MALFORMED", message: "initData missing or unparseable 'user' field" };
  }

  return {
    ok: true,
    fields,
    userId: user.id,
    username: user.username,
  };
}

/**
 * Exposed for tests / advanced callers: construct the encrypted `hash` for
 * a synthetic initData payload. Used to build deterministic test vectors.
 */
export async function signInitData(initData: string, botToken: string): Promise<string> {
  const fields = parseInitDataRaw(initData);
  const dataCheckString = buildDataCheckString(fields);
  const secretKey = await hmacSha256BytesFromString(WEB_APP_DATA_KEY, botToken);
  const computed = await hmacSha256Bytes(secretKey, dataCheckString);
  return hexFromBytes(computed);
}

/** Fixed key string for the first HMAC step in Telegram Mini App verification. */
const WEB_APP_DATA_KEY = "WebAppData";

/** HMAC-SHA256 with a UTF-8 string key and UTF-8 string data. */
async function hmacSha256BytesFromString(keyString: string, dataString: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyString) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(dataString));
  return new Uint8Array(sig);
}

// Re-export the helpers for tests that prefer to exercise intermediate steps.
export const __internal = { bytesFromHex, hexFromBytes, sha256Bytes, hmacSha256Bytes };
