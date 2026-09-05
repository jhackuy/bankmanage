/**
 * Mini App bootstrap authentication.
 *
 * SPEC.md §2:
 *   "Every Mini App API request validates original Telegram initData,
 *    signature freshness and allowlisted identity server-side. Never
 *    trust initDataUnsafe, username, display name or a client-submitted
 *    role for authorization."
 *
 * This module owns the client-side half of that contract for the Mini App
 * startup path. It performs exactly one POST to
 * `/api/telegram-mini-app-auth` carrying the raw `window.Telegram.WebApp.initData`
 * in the `x-telegram-init-data` header, and never reads or trusts any of:
 *
 *   - `initDataUnsafe` (unverified by Telegram)
 *   - `initDataUnsafe.user.username`
 *   - `initDataUnsafe.user.first_name` / `last_name`
 *   - any URL query parameter
 *   - any client-submitted role
 *
 * The function is pure: every external dependency (raw initData source and
 * HTTP transport) is injected. This lets node-mode vitest exercise every
 * branch without jsdom and without leaking real initData into logs.
 *
 * SECURITY:
 *   - The raw initData blob never enters the module's logs, errors, or
 *     return value on the failure path. Only short, fixed failure codes
 *     leave this module.
 *   - The success path returns only the minimum identity fields needed to
 *     render the authenticated shell (telegramUserId, memberId, role).
 */

export type BootstrapFailureCode =
  | "MISSING_TELEGRAM_CONTEXT"
  | "EMPTY_INIT_DATA"
  | "NETWORK_FAILURE"
  | "NON_2XX_RESPONSE"
  | "MALFORMED_RESPONSE"
  | "SERVER_REJECTED";

export type BootstrapIdentity = {
  readonly telegramUserId: string;
  readonly memberId: number;
  readonly role: "OWNER" | "MEMBER";
};

export type BootstrapAuthResult =
  | { readonly ok: true; readonly identity: BootstrapIdentity }
  | {
      readonly ok: false;
      readonly code: BootstrapFailureCode;
      readonly httpStatus: number | null;
      /** Short, fixed, non-sensitive copy suitable for a fail-closed UI. */
      readonly message: string;
    };

export interface RawInitDataSource {
  /**
   * Returns the raw `window.Telegram.WebApp.initData` string exactly as
   * Telegram provided it, or `null` if the Telegram context is unavailable
   * (not running inside a Mini App, or `initData` is empty).
   *
   * MUST NOT return `initDataUnsafe` or any field derived from it.
   */
  getRawInitData(): string | null;
}

export interface MiniAppAuthTransport {
  /**
   * POSTs the raw initData to the Worker auth endpoint. Returns the HTTP
   * Response. The implementation MUST NOT echo the initData into URLs,
   * logs, or query strings.
   */
  postInitData(initData: string): Promise<Response>;
}

export interface BootstrapAuthDeps {
  readonly rawInitDataSource: RawInitDataSource;
  readonly transport: MiniAppAuthTransport;
}

const AUTH_PATH = "/api/telegram-mini-app-auth";
const INIT_DATA_HEADER = "x-telegram-init-data";

const FAILURE_MESSAGES: Readonly<Record<BootstrapFailureCode, string>> = Object.freeze({
  MISSING_TELEGRAM_CONTEXT: "Telegram context is unavailable. Open this app from the Telegram bot.",
  EMPTY_INIT_DATA: "Telegram did not provide a fresh initData blob.",
  NETWORK_FAILURE: "Could not reach the authentication service.",
  NON_2XX_RESPONSE: "Authentication was refused.",
  MALFORMED_RESPONSE: "Authentication response was not understood.",
  SERVER_REJECTED: "This Telegram account is not authorized.",
});

/**
 * One-shot Mini App bootstrap authentication. On success returns the
 * minimum identity needed by the UI shell. On any failure returns a typed
 * code and a short non-sensitive message; the raw initData is never
 * included in the result.
 */
export async function bootstrapAuth(deps: BootstrapAuthDeps): Promise<BootstrapAuthResult> {
  let raw: string | null;
  try {
    raw = deps.rawInitDataSource.getRawInitData();
  } catch {
    return {
      ok: false,
      code: "MISSING_TELEGRAM_CONTEXT",
      httpStatus: null,
      message: FAILURE_MESSAGES.MISSING_TELEGRAM_CONTEXT,
    };
  }
  if (raw === null) {
    return {
      ok: false,
      code: "MISSING_TELEGRAM_CONTEXT",
      httpStatus: null,
      message: FAILURE_MESSAGES.MISSING_TELEGRAM_CONTEXT,
    };
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      ok: false,
      code: "EMPTY_INIT_DATA",
      httpStatus: null,
      message: FAILURE_MESSAGES.EMPTY_INIT_DATA,
    };
  }

  let res: Response;
  try {
    res = await deps.transport.postInitData(raw);
  } catch {
    return {
      ok: false,
      code: "NETWORK_FAILURE",
      httpStatus: null,
      message: FAILURE_MESSAGES.NETWORK_FAILURE,
    };
  }

  if (!res.ok) {
    const code: BootstrapFailureCode = res.status === 403 ? "SERVER_REJECTED" : "NON_2XX_RESPONSE";
    return {
      ok: false,
      code,
      httpStatus: res.status,
      message: FAILURE_MESSAGES[code],
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      code: "MALFORMED_RESPONSE",
      httpStatus: res.status,
      message: FAILURE_MESSAGES.MALFORMED_RESPONSE,
    };
  }
  if (body === null || typeof body !== "object") {
    return {
      ok: false,
      code: "MALFORMED_RESPONSE",
      httpStatus: res.status,
      message: FAILURE_MESSAGES.MALFORMED_RESPONSE,
    };
  }
  const record = body as Record<string, unknown>;
  if (record["ok"] !== true) {
    return {
      ok: false,
      code: "MALFORMED_RESPONSE",
      httpStatus: res.status,
      message: FAILURE_MESSAGES.MALFORMED_RESPONSE,
    };
  }
  const identityRaw = record["identity"];
  if (identityRaw === null || typeof identityRaw !== "object") {
    return {
      ok: false,
      code: "MALFORMED_RESPONSE",
      httpStatus: res.status,
      message: FAILURE_MESSAGES.MALFORMED_RESPONSE,
    };
  }
  const identity = identityRaw as Record<string, unknown>;
  const telegramUserId = identity["telegramUserId"];
  const memberId = identity["memberId"];
  const role = identity["role"];
  if (typeof telegramUserId !== "string" || telegramUserId.length === 0) {
    return {
      ok: false,
      code: "MALFORMED_RESPONSE",
      httpStatus: res.status,
      message: FAILURE_MESSAGES.MALFORMED_RESPONSE,
    };
  }
  if (typeof memberId !== "number" || !Number.isFinite(memberId) || memberId <= 0) {
    return {
      ok: false,
      code: "MALFORMED_RESPONSE",
      httpStatus: res.status,
      message: FAILURE_MESSAGES.MALFORMED_RESPONSE,
    };
  }
  if (role !== "OWNER" && role !== "MEMBER") {
    return {
      ok: false,
      code: "MALFORMED_RESPONSE",
      httpStatus: res.status,
      message: FAILURE_MESSAGES.MALFORMED_RESPONSE,
    };
  }

  return {
    ok: true,
    identity: {
      telegramUserId,
      memberId,
      role,
    },
  };
}

/**
 * Browser-only default source for the raw initData. Reads
 * `window.Telegram.WebApp.initData` (the unverified-against-our-server
 * string that the Worker will HMAC-verify); explicitly ignores
 * `initDataUnsafe` and every user-visible field.
 *
 * Returns `null` when the Telegram WebApp context is absent (e.g. local
 * dev outside Telegram) so the bootstrap fails closed with
 * `MISSING_TELEGRAM_CONTEXT`.
 */
export function browserRawInitDataSource(): RawInitDataSource {
  return {
    getRawInitData(): string | null {
      const tg = (globalThis as { Telegram?: { WebApp?: { initData?: unknown } } }).Telegram;
      const initData = tg?.WebApp?.initData;
      if (typeof initData !== "string") return null;
      if (initData.length === 0) return null;
      return initData;
    },
  };
}

/**
 * Browser-only default transport. POSTs the raw initData in a header and
 * never echoes it into the URL or logs.
 */
export function browserMiniAppAuthTransport(): MiniAppAuthTransport {
  return {
    async postInitData(initData: string): Promise<Response> {
      return fetch(AUTH_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INIT_DATA_HEADER]: initData,
        },
        body: "{}",
      });
    },
  };
}
