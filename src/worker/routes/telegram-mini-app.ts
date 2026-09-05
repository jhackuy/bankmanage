/**
 * Telegram Mini App authentication route.
 *
 * The Cloudflare Worker exposes a single endpoint that the Mini App client
 * calls to exchange a raw Telegram `initData` blob for a server-validated
 * identity and a session token. This file owns ONLY the HTTP shape — the
 * cryptographic verification and identity allowlist logic lives in
 * `TelegramMiniAppAuthService`.
 *
 * SPEC.md §2:
 *   "Every Mini App API request validates original Telegram initData,
 *    signature freshness and allowlisted identity server-side. Never
 *    trust initDataUnsafe, username, display name or a client-submitted
 *    role for authorization."
 *
 * SPEC.md §13: responses must never echo the raw initData, the bot token,
 * or bind secret material. Failures return the minimum information needed
 * for the client to retry or surface an "unauthorized" UI state.
 *
 * SECURITY: The whole initData blob and the HMAC secret live only on the
 * server. They MUST NOT be returned, logged, or echoed in error bodies.
 */

import { Hono } from "hono";
import type { Env } from "../env.js";
import { TelegramMiniAppAuthService } from "../../services/telegram/mini-app-auth.js";
import type { TelegramIdentityRepository } from "../../services/telegram/identity-repository.js";

const INIT_DATA_HEADER = "x-telegram-init-data";
const INIT_DATA_QUERY = "init_data";

export interface MiniAppAuthRouterInput {
  /** The Cloudflare-bound bot token. Never logged, never echoed. */
  readonly botToken: string;
  readonly identityRepository: TelegramIdentityRepository;
  /** Maximum age (seconds) before the initData payload is rejected. */
  readonly maxAgeSeconds?: number;
}

export function buildMiniAppAuthRouter(input: MiniAppAuthRouterInput): Hono<{ Bindings: Env }> {
  const authService = new TelegramMiniAppAuthService({
    botToken: input.botToken,
    identityRepository: input.identityRepository,
    ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
  });

  const router = new Hono<{ Bindings: Env }>();

  router.post("*", async (c) => {
    const initData =
      c.req.header(INIT_DATA_HEADER) ?? new URL(c.req.url).searchParams.get(INIT_DATA_QUERY) ?? null;
    if (initData === null || initData.length === 0) {
      return c.json({ error: "Missing initData" }, 400);
    }

    const result = await authService.verifyAndBind(initData);
    if (!result.ok) {
      // The typed status is the only thing we leak. Never echo the original
      // payload, the HMAC, or any decoded field.
      return c.json({ error: result.code, status: result.status }, result.status);
    }

    return c.json(
      {
        ok: true,
        identity: {
          telegramUserId: result.identity.telegramUserId,
          memberId: result.identity.memberId,
          role: result.identity.role,
        },
      },
      200
    );
  });

  // Health-style preflight for HEAD probes. Does NOT expose bot token or
  // allowlist contents.
  router.get("/", (c) => c.json({ ok: true, service: "telegram-mini-app-auth" }, 200));

  return router;
}
