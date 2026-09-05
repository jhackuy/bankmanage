/**
 * Telegram webhook route (/telegram/webhook).
 *
 * SPEC.md §2: "Every Bot command/callback and webhook update is checked
 * against the allowlist. Unauthorized requests return 403 with zero
 * financial mutation."
 *
 * SPEC.md §9: "The Bot must acknowledge callbacks promptly before slow
 * work. Duplicate button taps must not duplicate financial writes."
 *
 * SPEC.md §13: "Never commit real Telegram IDs/chat IDs/tokens. Log
 * responses must not contain tokens, complete initData, raw financial
 * documents or sensitive document text."
 *
 * Routing contract:
 *   POST /telegram/webhook
 *     header X-Telegram-Bot-Api-Secret-Token MUST match the configured
 *       webhook secret exactly (constant-time). Otherwise 403 with zero
 *       mutation.
 *     body MUST be a valid Telegram Update JSON. Malformed body → 400.
 *     replayed update_id (already claimed) → 200, no side-effects.
 *     update from non-allowlisted user → 200, no reply, no mutation.
 *
 * The handler is purely Hono-shaped — business logic lives in the
 * TelegramBotService and is reused by tests directly.
 */

import { Hono } from "hono";
import type { Env } from "../env.js";
import { TelegramBotService } from "../../services/telegram/index.js";
import type { MiniAppLauncher } from "../../services/telegram/bot-service.js";
import type { TelegramAdapter } from "../../adapters/telegram/interface.js";
import type { TelegramIdentityRepository } from "../../services/telegram/identity-repository.js";
import type { AllowedUserIds } from "../../services/telegram/allowed-user-ids.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

const MIN_PAYLOAD_BYTES = 32;
const MAX_PAYLOAD_BYTES = 256 * 1024; // Telegram hard cap per Update is ~256 KB.

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface TelegramWebhookBuildInput {
  /** Concrete adapter wired to the bot token (real implementation). */
  readonly adapter: TelegramAdapter;
  readonly identityRepository: TelegramIdentityRepository;
  readonly miniAppLauncher: MiniAppLauncher;
  /** Parsed allowlist — typically obtained via `readAllowedUserIds(env)`. */
  readonly allowedUserIds: AllowedUserIds | null;
  /** Optional override for the in-memory update deduper. */
  readonly deduper?: import("../../services/telegram/update-deduper.js").UpdateDeduper;
}

/**
 * Build a Hono router with all M4 webhook dependencies already bound.
 * This is the factory used by the Worker entry point — it keeps
 * `src/worker/index.ts` free of wiring code and makes the dependency
 * tree testable.
 */
export function buildTelegramWebhookRouter(input: TelegramWebhookBuildInput): Hono<{ Bindings: Env }> {
  if (input.allowedUserIds === null) {
    throw new Error("TelegramWebhook: TELEGRAM_ALLOWED_USER_IDS is missing or malformed");
  }
  const botService = new TelegramBotService({
    adapter: input.adapter,
    identityRepository: input.identityRepository,
    miniAppLauncher: input.miniAppLauncher,
    allowedUserIds: input.allowedUserIds,
    ...(input.deduper !== undefined ? { deduper: input.deduper } : {}),
  });
  const router = new Hono<{ Bindings: Env }>();

  router.post("*", async (c) => {
    const expectedSecret = c.env.TELEGRAM_WEBHOOK_SECRET;
    if (typeof expectedSecret !== "string" || expectedSecret.length === 0) {
      return c.json({ error: "Webhook secret not configured" }, 503);
    }
    const provided = c.req.header(SECRET_HEADER) ?? "";
    if (!timingSafeEqualString(provided, expectedSecret)) {
      // Fail closed. The body is intentionally NOT parsed so we never log
      // payload fragments from a forged caller.
      return c.json({ error: "Forbidden" }, 403);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return c.json({ error: "Payload too large" }, 413);
    }

    const rawText = await c.req.text();
    if (rawText.length < MIN_PAYLOAD_BYTES) {
      return c.json({ error: "Empty or too-short update payload" }, 400);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return c.json({ error: "Malformed JSON payload" }, 400);
    }

    const result = await botService.dispatchUpdate(parsed);
    return c.json(
      {
        ok: true,
        updateId: result.updateId,
        handled: result.handled,
        bot: result.bot?.kind ?? null,
      },
      200
    );
  });

  return router;
}

/**
 * A tiny launcher that always points at the configured Mini App URL.
 * The chat id is intentionally unused — opening the Mini App is independent
 * of which Telegram chat issued the request.
 */
export function miniAppLauncherFromEnv(miniAppUrl: string): MiniAppLauncher {
  return {
    buildLaunchButton: (_chatId: string) => ({ text: "Open BankManage", url: miniAppUrl }),
  };
}
