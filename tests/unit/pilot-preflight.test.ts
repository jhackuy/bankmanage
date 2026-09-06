import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "pilot-preflight.mjs");

const completeConfig = {
  CLOUDFLARE_API_TOKEN: "cf-token-sensitive",
  CLOUDFLARE_ACCOUNT_ID: "cf-account-sensitive",
  CLOUDFLARE_D1_DATABASE_ID: "123e4567-e89b-42d3-a456-426614174000",
  BANKMANAGE_PILOT_BASE_URL: "https://pilot.bankmanage.example",
  MINI_APP_URL: "https://pilot.bankmanage.example/app",
  TELEGRAM_BOT_TOKEN: "telegram-token-sensitive",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret-sensitive",
  TELEGRAM_ALLOWED_USER_IDS: "123456789,987654321",
};

function runPreflight(overrides: Record<string, string | undefined> = {}) {
  const env = { ...process.env, ...completeConfig, ...overrides };
  try {
    return {
      exit: 0,
      output: execFileSync("node", [SCRIPT], { encoding: "utf8", env }),
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { exit: failure.status ?? 1, output: failure.stdout ?? "" };
  }
}

describe("pilot configuration preflight", () => {
  it("passes a complete valid managed configuration", () => {
    expect(runPreflight()).toEqual({ exit: 0, output: "PREFLIGHT_PASS\n" });
  });

  it("reports only the name of a missing configuration", () => {
    const result = runPreflight({ TELEGRAM_WEBHOOK_SECRET: "" });
    expect(result.exit).toBe(1);
    expect(result.output).toContain("TELEGRAM_WEBHOOK_SECRET");
    expect(result.output).not.toContain(completeConfig.TELEGRAM_BOT_TOKEN);
    expect(result.output).not.toContain(
      completeConfig.TELEGRAM_ALLOWED_USER_IDS,
    );
  });

  it("rejects the placeholder D1 database identifier", () => {
    const result = runPreflight({
      CLOUDFLARE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.exit).toBe(1);
    expect(result.output).toContain("CLOUDFLARE_D1_DATABASE_ID");
    expect(result.output).not.toContain("00000000-0000-0000-0000-000000000000");
  });

  it("rejects non-HTTPS and cross-origin Mini App URLs", () => {
    expect(
      runPreflight({ MINI_APP_URL: "http://pilot.bankmanage.example/app" })
        .output,
    ).toContain("MINI_APP_URL");
    expect(
      runPreflight({ MINI_APP_URL: "https://other.example/app" }).output,
    ).toContain("MINI_APP_URL");
  });

  it("rejects malformed and duplicate two-user allowlists without echoing IDs", () => {
    for (const value of [
      "123456789",
      "123456789,123456789",
      "123456789,not-a-number",
    ]) {
      const result = runPreflight({ TELEGRAM_ALLOWED_USER_IDS: value });
      expect(result.exit).toBe(1);
      expect(result.output).toContain("TELEGRAM_ALLOWED_USER_IDS");
      expect(result.output).not.toContain(value);
    }
  });

  it("never prints configured values on failure", () => {
    const result = runPreflight({ MINI_APP_URL: "https://wrong.example/app" });
    for (const value of Object.values(completeConfig))
      expect(result.output).not.toContain(value);
  });
});
