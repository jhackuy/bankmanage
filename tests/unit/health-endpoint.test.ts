/**
 * health-endpoint.test.ts
 *
 * Verifies that the /health endpoint:
 * - Returns 200 with { status: "ok" }.
 * - Leaks no binding names, secrets or environment dump.
 * - Never includes error details, SQL, or config values.
 */

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index.js";

const SENSITIVE_PATTERNS = [
  // Binding names
  /\bDB\b/,
  /\bDOCUMENTS\b/,
  /\bASSETS\b/,
  // Secret names
  /TELEGRAM_BOT_TOKEN/i,
  /TELEGRAM_WEBHOOK_SECRET/i,
  /TELEGRAM_ALLOWED_USER_IDS/i,
  // Database details
  /d1_databases/i,
  /r2_buckets/i,
  /database_id/i,
  /database_name/i,
  // Environment dump patterns
  /process\.env/i,
  /env\s*=/i,
  /APP_ENV/i,
  /LOG_LEVEL/i,
  // SQL-related
  /SELECT/i,
  /CREATE TABLE/i,
  /sqlite/i,
  // Error objects / stack traces
  /Error:/,
  /at Object/,
  /stack:/i,
];

describe("GET /health", () => {
  it("returns 200", async () => {
    const req = new Request("http://localhost/health");
    const res = await app.fetch(req, {} as never, {} as never);
    expect(res.status).toBe(200);
  });

  it("returns JSON with status: ok", async () => {
    const req = new Request("http://localhost/health");
    const res = await app.fetch(req, {} as never, {} as never);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
  });

  it("response body contains no sensitive information", async () => {
    const req = new Request("http://localhost/health");
    const res = await app.fetch(req, {} as never, {} as never);
    const text = await res.text();

    for (const pattern of SENSITIVE_PATTERNS) {
      expect(text, `Response must not contain pattern: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("response body contains only expected keys", async () => {
    const req = new Request("http://localhost/health");
    const res = await app.fetch(req, {} as never, {} as never);
    const body = (await res.json()) as Record<string, unknown>;
    const keys = Object.keys(body);
    // Only allow the minimal set: { status }
    // Any extra key could be an accidental config/env dump
    expect(keys).toEqual(["status"]);
  });

  it("returns Content-Type application/json", async () => {
    const req = new Request("http://localhost/health");
    const res = await app.fetch(req, {} as never, {} as never);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});
