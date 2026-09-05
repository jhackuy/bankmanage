/**
 * tests/unit/telegram-mini-app-url.test.ts
 *
 * Verifies `miniAppUrlFromEnv` fails closed when `MINI_APP_URL` is missing,
 * empty, non-string, malformed, or non-HTTPS. The function must never
 * silently substitute a placeholder that would produce a dead or insecure
 * Mini App button.
 */

import { describe, expect, it } from "vitest";
import { miniAppUrlFromEnv } from "../../src/worker/index.js";
import type { Env } from "../../src/worker/env.js";

function envWith(miniAppUrl: unknown): Env {
  const base: Record<string, unknown> = {
    TELEGRAM_WEBHOOK_SECRET: "synthetic_secret",
    TELEGRAM_BOT_TOKEN: "synthetic_bot_token",
    TELEGRAM_ALLOWED_USER_IDS: "111111111,222222222",
    APP_ENV: "test",
    DB: {},
    DOCUMENTS: {},
  };
  if (miniAppUrl !== undefined) {
    base["MINI_APP_URL"] = miniAppUrl;
  }
  return base as unknown as Env;
}

describe("miniAppUrlFromEnv", () => {
  it("accepts a valid HTTPS URL", () => {
    const url = miniAppUrlFromEnv(envWith("https://mini-app.example.com/"));
    expect(url).toBe("https://mini-app.example.com/");
  });

  it("accepts a valid HTTPS URL with a deep path", () => {
    const url = miniAppUrlFromEnv(envWith("https://mini-app.example.com/path/to/app"));
    expect(url).toBe("https://mini-app.example.com/path/to/app");
  });

  it("throws when MINI_APP_URL is missing", () => {
    const env = { ...envWith(undefined) };
    delete (env as unknown as Record<string, unknown>)["MINI_APP_URL"];
    expect(() => miniAppUrlFromEnv(env)).toThrow("MINI_APP_URL");
  });

  it("throws when MINI_APP_URL is an empty string", () => {
    expect(() => miniAppUrlFromEnv(envWith(""))).toThrow("MINI_APP_URL");
  });

  it("throws when MINI_APP_URL is not a string", () => {
    expect(() => miniAppUrlFromEnv(envWith(123))).toThrow("MINI_APP_URL");
    expect(() => miniAppUrlFromEnv(envWith(null))).toThrow("MINI_APP_URL");
    expect(() => miniAppUrlFromEnv(envWith({}))).toThrow("MINI_APP_URL");
  });

  it("throws when MINI_APP_URL is malformed (unparseable)", () => {
    expect(() => miniAppUrlFromEnv(envWith("not a url at all"))).toThrow("not a valid URL");
  });

  it("throws when MINI_APP_URL uses http:// instead of https://", () => {
    expect(() => miniAppUrlFromEnv(envWith("http://mini-app.example.com/"))).toThrow("HTTPS");
  });

  it("throws when MINI_APP_URL uses an unsupported protocol", () => {
    expect(() => miniAppUrlFromEnv(envWith("ftp://mini-app.example.com/"))).toThrow("HTTPS");
  });

  it("error messages do not echo the URL value (no secret/config leakage)", () => {
    const sensitive = "https://internal.mini-app.example.com/private/path?token=secret";
    let caught: Error | null = null;
    try {
      miniAppUrlFromEnv(envWith("http://" + sensitive.replace("https://", "")));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain("internal.mini-app.example.com");
    expect(caught!.message).not.toContain("private/path");
  });
});
