/**
 * BankManage Cloudflare Worker entry point.
 *
 * Hono handles routing. Cloudflare-specific bindings (D1, R2) are accessed
 * only through typed adapters — never directly in route handlers.
 *
 * M4 wiring strategy:
 *   - Service objects that close over SECRET bindings (e.g. bot token) are
 *     constructed per-request, inside the handler, so no secret leaks into
 *     the module top level. The route factories themselves are pure.
 *   - Database-backed repositories are also constructed per-request from
 *     c.env.DB. There is no shared mutable state across requests in this
 *     worker; the only one-process mutable is the in-process update
 *     deduper (acceptable for M4 — see SPEC §9 idempotency note).
 */

import { Hono } from "hono";
import { healthRouter } from "./routes/health.js";
import { buildTelegramWebhookRouter, miniAppLauncherFromEnv } from "./routes/telegram-webhook.js";
import { buildMiniAppAuthRouter } from "./routes/telegram-mini-app.js";
import { CloudflareTelegramAdapter } from "../adapters/telegram/cloudflare-http.js";
import { D1TelegramIdentityRepository } from "../services/telegram/d1-identity-repository.js";
import { D1UpdateDeduper } from "../services/telegram/d1-update-deduper.js";
import { TelegramReminderCallbackActions } from "../services/telegram/callback-actions.js";
import { D1ReminderRepository } from "../services/term-deposit/d1-reminder-repository.js";
import { D1TermDepositRepository } from "../services/term-deposit/d1-repository.js";
import { TermDepositReminderService } from "../services/term-deposit/reminder-service.js";
import { readAllowedUserIds } from "../services/telegram/allowed-user-ids.js";
import type { D1Database } from "../adapters/d1/types.js";
import type { Env } from "./env.js";

const app = new Hono<{ Bindings: Env }>();

// ── API routes ────────────────────────────────────────────────────────────────
app.route("/health", healthRouter);

// ── Telegram Mini App auth (M4) ────────────────────────────────────────────────
// The bot token + identity repo come from request context. We mount a tiny
// inline handler so the factory doesn't pre-construct a service.
app.post("/api/telegram-mini-app-auth", async (c) => {
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  if (typeof botToken !== "string" || botToken.length === 0) {
    return c.json({ error: "Bot token not configured" }, 503);
  }
  const allowed = readAllowedUserIds(c.env as unknown as Record<string, unknown>);
  if (allowed === null) {
    return c.json({ error: "Allowlist not configured" }, 503);
  }
  const router = buildMiniAppAuthRouter({
    botToken,
    identityRepository: new D1TelegramIdentityRepository(c.env.DB as unknown as D1Database),
    allowedUserIds: allowed,
  });
  return router.fetch(c.req.raw, c.env, c.executionCtx as never);
});

app.get("/api/telegram-mini-app-auth", (c) => c.json({ ok: true, service: "telegram-mini-app-auth" }, 200));

// ── Telegram webhook (M4) ─────────────────────────────────────────────────────
app.post("/telegram/webhook", async (c) => {
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  if (typeof botToken !== "string" || botToken.length === 0) {
    return c.json({ error: "Bot token not configured" }, 503);
  }
  const allowed = readAllowedUserIds(c.env as unknown as Record<string, unknown>);
  if (allowed === null) {
    return c.json({ error: "Allowlist not configured" }, 503);
  }
  const db = c.env.DB as unknown as D1Database;
  const adapter = new CloudflareTelegramAdapter({ botToken });
  const identityRepository = new D1TelegramIdentityRepository(db);
  let miniAppLauncher: ReturnType<typeof miniAppLauncherFromEnv>;
  try {
    miniAppLauncher = miniAppLauncherFromEnv(miniAppUrlFromEnv(c.env));
  } catch {
    // Fail closed: a missing/malformed/non-HTTPS MINI_APP_URL would
    // otherwise cause the /start reply to advertise a dead or insecure
    // Mini App button.
    return c.json({ error: "Mini App URL not configured" }, 503);
  }
  // D1-backed deduper: the UNIQUE constraint on update_id (migration 0014)
  // is the race-safe boundary across Worker isolates. An in-memory deduper
  // would be wiped by isolate recycling and never span isolates.
  const deduper = new D1UpdateDeduper(db);
  // Per-request callback-action handler. Uses the existing M1 reminder /
  // deposit repositories and TermDepositReminderService so no new
  // financial surface is introduced.
  const buildCallbackActions =
    (): import("../services/telegram/callback-actions.js").ReminderCallbackActions => {
      const reminderRepository = new D1ReminderRepository(db);
      const depositRepository = new D1TermDepositRepository(db);
      const reminderService = new TermDepositReminderService(reminderRepository, depositRepository);
      return new TelegramReminderCallbackActions({
        adapter,
        reminderRepository,
        depositRepository,
        reminderService,
      });
    };
  const router = buildTelegramWebhookRouter({
    adapter,
    identityRepository,
    miniAppLauncher,
    deduper,
    allowedUserIds: allowed,
    buildCallbackActions,
  });
  return router.fetch(c.req.raw, c.env, c.executionCtx as never);
});

/**
 * Resolve the Mini App URL from the env binding. Fails closed: the value
 * must be present, parseable as a URL, and HTTPS. This prevents the
 * welcome reply from advertising a dead/insecure Mini App button when the
 * non-secret `MINI_APP_URL` binding is misconfigured.
 *
 * Exported for unit testing.
 */
export function miniAppUrlFromEnv(env: Env): string {
  const raw = (env as unknown as Record<string, unknown>)["MINI_APP_URL"];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("MINI_APP_URL is missing or empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("MINI_APP_URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("MINI_APP_URL must use HTTPS");
  }
  return parsed.toString();
}

// ── Static UI (served by Cloudflare ASSETS binding) ──────────────────────────
app.get("/*", async (c) => {
  // In production the ASSETS binding serves the Vite-built UI.
  // During wrangler dev the asset directory is served directly.
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text("UI not available", 503);
});

export default app;
