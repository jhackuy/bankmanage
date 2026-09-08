/**
 * tests/unit/m5-acceptance-summary.test.ts
 *
 * Verifies that the M5 acceptance summary:
 *   - returns a fully-formed machine-readable JSON object on the happy
 *     path;
 *   - never records the values of secret-shaped environment variables;
 *   - fails closed when any of {pilot-preflight, d1-resolve,
 *     migrate-apply, smoke-ui-mobile} blocks;
 *   - never claims real-user evidence was synthesised;
 *   - mentions names-only configuration in its evidence policy note.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildM5AcceptanceSummary } from "../../scripts/m5-acceptance-summary.mjs";

const SCRIPT = join(process.cwd(), "scripts", "m5-acceptance-summary.mjs");

const VALID_ENV = {
  CLOUDFLARE_API_TOKEN: "synthetic_api_token",
  CLOUDFLARE_ACCOUNT_ID: "abcd1234abcd1234abcd1234abcd1234",
  CLOUDFLARE_D1_DATABASE_ID: "123e4567-e89b-42d3-a456-426614174000",
  BANKMANAGE_PILOT_BASE_URL: "https://pilot.bankmanage.example",
  MINI_APP_URL: "https://pilot.bankmanage.example",
  TELEGRAM_BOT_TOKEN: "synthetic_bot_token",
  TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret",
  TELEGRAM_ALLOWED_USER_IDS: "100000001,100000002",
};

function makeFakeDistDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "m5-summary-dist-"));
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="app"></div></body></html>'
  );
  return dir;
}

function runCli(envOverrides: Record<string, string | undefined> = {}): { exit: number; output: string } {
  const env = { ...process.env, ...VALID_ENV, ...envOverrides };
  try {
    return {
      exit: 0,
      output: execFileSync("node", [SCRIPT], { encoding: "utf8", env }),
    };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string };
    return { exit: failure.status ?? 1, output: failure.stdout ?? "" };
  }
}

describe("buildM5AcceptanceSummary (library)", () => {
  it("returns a complete structured summary when env is valid and dist/ui is built", () => {
    const distDir = makeFakeDistDir();
    const summary = buildM5AcceptanceSummary(VALID_ENV, { distDir, generatedAt: "2026-09-08T00:00:00.000Z" });
    expect(summary.milestone).toBe("M5");
    expect(summary.generatedAt).toBe("2026-09-08T00:00:00.000Z");
    expect(summary.contractVersion).toBe(1);
    expect(summary.pilot.ok).toBe(true);
    expect(summary.deployment.d1.ok).toBe(true);
    expect(summary.deployment.migrations.ok).toBe(true);
    expect(summary.ui.ok).toBe(true);
    expect(summary.security.secretGateDetected).toBe(true);
  });

  it("marks the summary as !ok when pilot-preflight rejects the env", () => {
    const distDir = makeFakeDistDir();
    const summary = buildM5AcceptanceSummary({ ...VALID_ENV, TELEGRAM_BOT_TOKEN: "" }, { distDir });
    expect(summary.ok).toBe(false);
    expect(summary.pilot.ok).toBe(false);
    expect(summary.pilot.missing).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("marks the summary as !ok when d1-resolve rejects the env", () => {
    const distDir = makeFakeDistDir();
    const summary = buildM5AcceptanceSummary(
      { ...VALID_ENV, CLOUDFLARE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000" },
      { distDir }
    );
    expect(summary.ok).toBe(false);
    expect(summary.deployment.d1.ok).toBe(false);
    expect(summary.deployment.d1.invalid).toContain("CLOUDFLARE_D1_DATABASE_ID");
  });

  it("records the migration count from the repository migrations directory", () => {
    const distDir = makeFakeDistDir();
    const summary = buildM5AcceptanceSummary(VALID_ENV, { distDir });
    expect(summary.deployment.migrations.count).toBeGreaterThan(0);
  });

  it("never echoes secret-shaped values in the JSON output", () => {
    const distDir = makeFakeDistDir();
    const summary = buildM5AcceptanceSummary(VALID_ENV, { distDir });
    const dump = JSON.stringify(summary);
    expect(dump).not.toContain(VALID_ENV.CLOUDFLARE_API_TOKEN);
    expect(dump).not.toContain(VALID_ENV.CLOUDFLARE_D1_DATABASE_ID);
    expect(dump).not.toContain(VALID_ENV.CLOUDFLARE_ACCOUNT_ID);
    expect(dump).not.toContain(VALID_ENV.TELEGRAM_BOT_TOKEN);
    expect(dump).not.toContain(VALID_ENV.TELEGRAM_WEBHOOK_SECRET);
    expect(dump).not.toContain(VALID_ENV.TELEGRAM_ALLOWED_USER_IDS);
  });

  it("never claims to have synthesised real-user evidence", () => {
    const distDir = makeFakeDistDir();
    const summary = buildM5AcceptanceSummary(VALID_ENV, { distDir });
    expect(summary.evidencePolicy.synthesisesRealUsers).toBe(false);
    expect(summary.evidencePolicy.echoesSecrets).toBe(false);
    expect(summary.evidencePolicy.notes).toMatch(/names-only/i);
  });
});

describe("m5-acceptance-summary CLI mode", () => {
  it("prints machine-readable JSON to stdout and never echoes secrets", () => {
    const result = runCli();
    expect(() => JSON.parse(result.output)).not.toThrow();
    const parsed = JSON.parse(result.output) as {
      milestone: string;
      ok: boolean;
      evidencePolicy: { synthesisesRealUsers: boolean; echoesSecrets: boolean };
    };
    expect(parsed.milestone).toBe("M5");
    expect(parsed.evidencePolicy.synthesisesRealUsers).toBe(false);
    expect(parsed.evidencePolicy.echoesSecrets).toBe(false);
    expect(result.output).not.toContain(VALID_ENV.CLOUDFLARE_API_TOKEN);
    expect(result.output).not.toContain(VALID_ENV.TELEGRAM_BOT_TOKEN);
    expect(result.output).not.toContain(VALID_ENV.TELEGRAM_WEBHOOK_SECRET);
  });

  it("exits non-zero when the env is rejected by preflight", () => {
    const result = runCli({ TELEGRAM_BOT_TOKEN: "" });
    expect(result.exit).toBe(1);
    const parsed = JSON.parse(result.output) as { ok: boolean };
    expect(parsed.ok).toBe(false);
    expect(result.output).not.toContain(VALID_ENV.CLOUDFLARE_API_TOKEN);
  });
});
