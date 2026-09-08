/**
 * tests/unit/d1-resolve.test.ts
 *
 * Verifies that managed D1 resolution is fail-closed and never prints
 * or returns account/database identifiers on the failure path.
 *
 * Covers:
 *   - complete valid config -> ok with structured config;
 *   - missing each required name -> named, never the value;
 *   - placeholder account id rejected;
 *   - placeholder database id rejected;
 *   - malformed account id rejected;
 *   - malformed database id rejected;
 *   - CLI mode prints NAMES ONLY and never the secret-like values.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveManagedD1Config } from "../../scripts/d1-resolve.mjs";

const SCRIPT = join(process.cwd(), "scripts", "d1-resolve.mjs");

const VALID_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "abcd1234abcd1234abcd1234abcd1234",
  CLOUDFLARE_D1_DATABASE_ID: "123e4567-e89b-42d3-a456-426614174000",
};

function runCli(overrides: Record<string, string | undefined> = {}): { exit: number; output: string } {
  const env = { ...process.env, ...VALID_ENV, ...overrides };
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

describe("resolveManagedD1Config (library)", () => {
  it("accepts a complete valid managed D1 configuration", () => {
    const result = resolveManagedD1Config(VALID_ENV);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(result.config).toEqual({
      accountId: VALID_ENV.CLOUDFLARE_ACCOUNT_ID,
      databaseId: VALID_ENV.CLOUDFLARE_D1_DATABASE_ID,
    });
  });

  it("reports a missing account id without echoing it", () => {
    const env = { ...VALID_ENV, CLOUDFLARE_ACCOUNT_ID: "" };
    const result = resolveManagedD1Config(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(result.config).toBeNull();
  });

  it("reports a missing database id without echoing it", () => {
    const env = { ...VALID_ENV, CLOUDFLARE_D1_DATABASE_ID: "" };
    const result = resolveManagedD1Config(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("CLOUDFLARE_D1_DATABASE_ID");
    expect(result.config).toBeNull();
  });

  it("rejects the placeholder database identifier", () => {
    const env = {
      ...VALID_ENV,
      CLOUDFLARE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000",
    };
    const result = resolveManagedD1Config(env);
    expect(result.ok).toBe(false);
    expect(result.invalid).toContain("CLOUDFLARE_D1_DATABASE_ID");
  });

  it("rejects the placeholder all-zeros account id", () => {
    const env = {
      ...VALID_ENV,
      CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    };
    const result = resolveManagedD1Config(env);
    expect(result.ok).toBe(false);
    expect(result.invalid).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("rejects a malformed account id (not 32 hex chars)", () => {
    const env = {
      ...VALID_ENV,
      CLOUDFLARE_ACCOUNT_ID: "not-hex-id",
    };
    const result = resolveManagedD1Config(env);
    expect(result.ok).toBe(false);
    expect(result.invalid).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("rejects a malformed database id (not UUID)", () => {
    const env = {
      ...VALID_ENV,
      CLOUDFLARE_D1_DATABASE_ID: "not-a-uuid",
    };
    const result = resolveManagedD1Config(env);
    expect(result.ok).toBe(false);
    expect(result.invalid).toContain("CLOUDFLARE_D1_DATABASE_ID");
  });

  it("reports missing and invalid without echoing values", () => {
    const env = {
      CLOUDFLARE_ACCOUNT_ID: "",
      CLOUDFLARE_D1_DATABASE_ID: "bad",
    };
    const result = resolveManagedD1Config(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(result.invalid).toContain("CLOUDFLARE_D1_DATABASE_ID");
    expect(result.config).toBeNull();
  });
});

describe("d1-resolve CLI mode (inert)", () => {
  it("passes a complete valid managed configuration", () => {
    const result = runCli();
    expect(result.exit).toBe(0);
    expect(result.output).toBe("D1_RESOLVE_PASS\n");
  });

  it("reports named missing configuration without echoing values", () => {
    const result = runCli({ CLOUDFLARE_ACCOUNT_ID: "" });
    expect(result.exit).toBe(1);
    expect(result.output).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(result.output).not.toContain(VALID_ENV.CLOUDFLARE_ACCOUNT_ID);
    expect(result.output).not.toContain(VALID_ENV.CLOUDFLARE_D1_DATABASE_ID);
  });

  it("reports a placeholder database id without echoing it", () => {
    const placeholder = "00000000-0000-0000-0000-000000000000";
    const result = runCli({ CLOUDFLARE_D1_DATABASE_ID: placeholder });
    expect(result.exit).toBe(1);
    expect(result.output).toContain("CLOUDFLARE_D1_DATABASE_ID");
    expect(result.output).not.toContain(placeholder);
  });

  it("never prints configured values on failure", () => {
    const result = runCli({ CLOUDFLARE_ACCOUNT_ID: "not-hex-id" });
    expect(result.exit).toBe(1);
    for (const value of Object.values(VALID_ENV)) {
      expect(result.output).not.toContain(value);
    }
  });
});
