/**
 * /health — minimal liveness endpoint.
 *
 * MUST NOT expose:
 * - binding names or values
 * - secret names or values
 * - environment variable dump
 * - SQL errors or schema details
 * - Telegram IDs or tokens
 */

import { Hono } from "hono";
import type { Env } from "../env.js";

export const healthRouter = new Hono<{ Bindings: Env }>();

healthRouter.get("/", (c) => {
  return c.json({ status: "ok" }, 200);
});
