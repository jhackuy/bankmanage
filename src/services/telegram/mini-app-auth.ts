/**
 * Telegram Mini App authentication service.
 *
 * SPEC.md §2: "Every Mini App API request validates original Telegram
 * `initData`, signature freshness and allowlisted identity server-side.
 * Never trust `initDataUnsafe`, username, display name or a client-submitted
 * role for authorization."
 *
 * The service composes:
 *   1. `verifyInitData` from `src/domain/telegram/init-data.ts` — performs
 *      HMAC-SHA256 signature verification and freshness check.
 *   2. `TelegramIdentityRepository` — applies the allowlist and resolves
 *      the Telegram user ID to the household member role.
 *
 * Tampered / expired / unknown identities return a typed failure with a
 * 403-equivalent status. The service performs zero mutation on the
 * database: authorization is read-only.
 */

import { verifyInitData, type InitDataVerification } from "../../domain/telegram/init-data.js";
import type { ResolvedTelegramIdentity, TelegramIdentityRepository } from "./identity-repository.js";
import type { AllowedUserIds } from "./allowed-user-ids.js";

export type MiniAppAuthResult =
  | {
      readonly ok: true;
      readonly identity: ResolvedTelegramIdentity;
      readonly verification: InitDataVerification & { ok: true };
    }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 503;
      readonly code: MiniAppAuthFailure;
      readonly message: string;
    };

export type MiniAppAuthFailure =
  | "MALFORMED_INIT_DATA"
  | "BAD_SIGNATURE"
  | "EXPIRED_INIT_DATA"
  | "UNKNOWN_USER"
  | "ALLOWLIST_NOT_CONFIGURED";

export interface TelegramMiniAppAuthServiceOptions {
  readonly botToken: string;
  readonly identityRepository: TelegramIdentityRepository;
  /**
   * Parsed allowlist from `TELEGRAM_ALLOWED_USER_IDS`. Required: the
   * service refuses to bind an identity whose Telegram user ID is not in
   * this set, even if the persisted identity row exists.
   */
  readonly allowedUserIds: AllowedUserIds;
  /** Maximum age (seconds) allowed for the initData payload. */
  readonly maxAgeSeconds?: number;
  /** "now" override (epoch seconds) for deterministic tests. */
  readonly nowSeconds?: number;
}

export class TelegramMiniAppAuthService {
  private readonly _botToken: string;
  private readonly _identities: TelegramIdentityRepository;
  private readonly _allowed: AllowedUserIds;
  private readonly _maxAgeSeconds: number | undefined;
  private readonly _nowSeconds: number | undefined;

  constructor(opts: TelegramMiniAppAuthServiceOptions) {
    if (typeof opts.botToken !== "string" || opts.botToken.length === 0) {
      throw new Error("TelegramMiniAppAuthService: botToken must be a non-empty string");
    }
    this._botToken = opts.botToken;
    this._identities = opts.identityRepository;
    this._allowed = opts.allowedUserIds;
    this._maxAgeSeconds = opts.maxAgeSeconds;
    this._nowSeconds = opts.nowSeconds;
  }

  /**
   * Verify a raw initData string. Returns the resolved household member
   * identity (with role) ONLY when:
   *   - the HMAC signature matches the configured bot token;
   *   - the auth_date is within `maxAgeSeconds` of `nowSeconds` (or wall-clock now);
   *   - the Telegram user ID is in the managed `TELEGRAM_ALLOWED_USER_IDS` set;
   *   - the persisted `telegram_identities` row resolves that ID to an
   *     active household member with a role.
   *
   * Otherwise the typed `MiniAppAuthResult` failure carries:
   *   - 401 for "initData corrupted / unparseable / wrong bot token";
   *   - 403 for "initData well-formed but user is not on the allowlist";
   *   - 503 for "allowlist mis-configured at deploy time".
   */
  async verifyAndBind(initData: string): Promise<MiniAppAuthResult> {
    const opts: Parameters<typeof verifyInitData>[2] = {};
    if (this._maxAgeSeconds !== undefined) opts.maxAgeSeconds = this._maxAgeSeconds;
    if (this._nowSeconds !== undefined) opts.nowSeconds = this._nowSeconds;

    const verification = await verifyInitData(initData, this._botToken, opts);
    if (!verification.ok) {
      switch (verification.code) {
        case "MALFORMED":
          return { ok: false, status: 401, code: "MALFORMED_INIT_DATA", message: verification.message };
        case "BAD_HASH":
          return { ok: false, status: 401, code: "BAD_SIGNATURE", message: verification.message };
        case "EXPIRED":
          return { ok: false, status: 401, code: "EXPIRED_INIT_DATA", message: verification.message };
        case "MISSING_AUTH_DATE":
          return { ok: false, status: 401, code: "MALFORMED_INIT_DATA", message: verification.message };
      }
    }

    // Intersect the managed allowlist with the persisted identity. Both
    // checks must pass: an admin can have added a row without updating the
    // binding, or the binding can include an ID whose row was deleted.
    if (!this._allowed.ids.has(verification.userId)) {
      return {
        ok: false,
        status: 403,
        code: "UNKNOWN_USER",
        message: "Telegram user is not on the managed allowlist",
      };
    }

    const identity = await this._identities.findByTelegramUserId(verification.userId);
    if (identity === null) {
      return {
        ok: false,
        status: 403,
        code: "UNKNOWN_USER",
        message: "Telegram user is not on the allowlist",
      };
    }

    return { ok: true, identity, verification };
  }
}
