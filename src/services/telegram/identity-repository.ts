/**
 * Telegram identity repository — service-layer port for resolving a Telegram
 * user ID to a household member (and therefore an authorization role).
 *
 * SPEC.md §2: exactly two Telegram identities are configured for the pilot
 * (OWNER, MEMBER). No public registration. The repository MUST be the only
 * place where a Telegram ID is mapped to a role — never trust a client-
 * supplied role, username, display name, or `initDataUnsafe` value.
 *
 * The interface is platform-neutral. The D1 adapter implements this port
 * against Cloudflare D1; tests use the same port against the FakeD1Database
 * binding.
 */

import type { MemberRole } from "../../adapters/telegram/interface.js";

/**
 * Resolved identity: the Telegram user ID is on the allowlist and is bound
 * to exactly one active household member. `memberId` is the internal
 * household_member.id row, never the Telegram user ID.
 */
export interface ResolvedTelegramIdentity {
  readonly telegramUserId: string;
  readonly memberId: number;
  readonly role: MemberRole;
}

export interface TelegramIdentityRepository {
  /**
   * Look up a Telegram user ID. Returns `null` if:
   *   - the Telegram ID is not on the allowlist;
   *   - the linked member no longer exists;
   *   - the linked member is inactive.
   *
   * Returns the canonical record when the user is allowed.
   */
  findByTelegramUserId(telegramUserId: string): Promise<ResolvedTelegramIdentity | null>;

  /**
   * Look up the Telegram identity bound to a given household member id.
   * Returns `null` if the member has no bound Telegram identity, the member
   * does not exist, or the linked identity is inactive.
   */
  findByMemberId(memberId: number): Promise<ResolvedTelegramIdentity | null>;

  /**
   * List every resolved, active Telegram identity. Used by services that
   * need to resolve member -> Telegram ID without a round trip per call.
   * Pilot scale (exactly two users) makes this cheap. Adapters MUST
   * return only active identities and bound roles.
   */
  listAll(): Promise<ReadonlyArray<ResolvedTelegramIdentity>>;
}
