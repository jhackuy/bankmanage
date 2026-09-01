/**
 * BankManage Cloudflare Worker entry point.
 *
 * Hono handles routing. Cloudflare-specific bindings (D1, R2) are accessed
 * only through typed adapters — never directly in route handlers.
 */

import { Hono } from "hono";
import { healthRouter } from "./routes/health.js";
import type { Env } from "./env.js";

const app = new Hono<{ Bindings: Env }>();

// ── API routes ────────────────────────────────────────────────────────────────
app.route("/health", healthRouter);

// ── Telegram webhook (M4) ─────────────────────────────────────────────────────
// Placeholder — full implementation in M4
app.post("/telegram/webhook", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

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
