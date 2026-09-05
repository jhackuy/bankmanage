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
import { InMemoryUpdateDeduper } from "../services/telegram/update-deduper.js";
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
  const router = buildMiniAppAuthRouter({
    botToken,
    identityRepository: new D1TelegramIdentityRepository(c.env.DB),
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
  const adapter = new CloudflareTelegramAdapter({ botToken });
  const identityRepository = new D1TelegramIdentityRepository(c.env.DB);
  const launcher = miniAppLauncherFromEnv(miniAppUrlFromEnv(c.env));
  const router = buildTelegramWebhookRouter({
    adapter,
    identityRepository,
    launcher,
    deduper: new InMemoryUpdateDeduper(),
  });
  return router.fetch(c.req.raw, c.env, c.executionCtx as never);
});

function miniAppUrlFromEnv(env: Env): string {
  // Optional non-secret binding for the deployed Mini App URL. Falls back
  // to a deterministic placeholder when the binding is missing — the actual
  // UX lives in the Mini App, so an unconfigured URL only affects the
  // welcome button, not authorization.
  const url = (env as unknown as Record<string, unknown>)["MINI_APP_URL"];
  return typeof url === "string" && url.length > 0 ? url : "https://example.invalid/mini-app";
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
