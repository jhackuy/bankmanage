/**
 * Centralized parser for the `TELEGRAM_ALLOWED_USER_IDS` managed binding.
 *
 * SPEC.md §2: only the two household members (OWNER + MEMBER) may send
 * Telegram commands or open the Mini App. The binding is the deploy-time
 * configuration that names those two Telegram numeric user IDs.
 *
 * Fail-closed contract:
 *   - Missing binding     → fail closed (empty set).
 *   - Non-string binding  → fail closed (empty set).
 *   - Fewer than two IDs  → fail closed (empty set).
 *   - More than two IDs   → fail closed (empty set).
 *   - Duplicates          → fail closed (empty set).
 *   - Non-numeric IDs     → fail closed (empty set).
 *
 * We never throw on a malformed binding — the caller can decide whether to
 * fail-closed at the request boundary. `parseAllowedUserIds(raw)` returns
 * the parsed set on success or `null` when the binding is malformed.
 *
 * The parsed result is a Set of strings (Telegram user IDs are 64-bit and
 * do not fit safely into JavaScript Number, so we keep them as strings).
 */

const REQUIRED_ID_COUNT = 2;

export interface AllowedUserIds {
  /** Two numeric Telegram user IDs as strings, frozen for safe iteration. */
  readonly ids: ReadonlySet<string>;
  /** True when both IDs parsed cleanly and the set has exactly two entries. */
  readonly ok: true;
}

export function parseAllowedUserIds(raw: unknown): AllowedUserIds | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  const tokens = raw
    .split(/[\s,]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length !== REQUIRED_ID_COUNT) return null;

  const seen = new Set<string>();
  for (const tok of tokens) {
    if (!/^\d+$/u.test(tok)) return null;
    // Guard against pathological inputs that parse as digits but overflow
    // JS number range (Telegram IDs are 64-bit unsigned).
    if (!isPlausibleTelegramUserId(tok)) return null;
    if (seen.has(tok)) return null; // duplicates fail closed
    seen.add(tok);
  }

  return Object.freeze({ ids: seen, ok: true as const });
}

/**
 * Reject the binding if anything is wrong: missing, malformed, wrong count,
 * duplicates, or non-numeric. This is the "fail closed" boundary at the
 * HTTP edge.
 */
export function readAllowedUserIds(env: Readonly<Record<string, unknown>>): AllowedUserIds | null {
  const raw = env["TELEGRAM_ALLOWED_USER_IDS"];
  return parseAllowedUserIds(raw);
}

/**
 * Conservative upper bound for a Telegram user ID. The platform has used
 * values up to ~9×10⁹ in practice; we accept up to 10¹⁸ to leave headroom
 * without admitting obviously-wrong inputs.
 */
function isPlausibleTelegramUserId(s: string): boolean {
  if (s.length > 19) return false;
  // Compare against BigInt ceiling so we don't lose precision.
  try {
    const v = BigInt(s);
    return v >= 1n && v <= 10n ** 18n;
  } catch {
    return false;
  }
}
