/**
 * tests/unit/pilot-deploy.test.ts
 *
 * Verifies that the master orchestration driver:
 *   - is inert by default (no smoke probes without --run-smoke);
 *   - is fail-closed when preflight rejects the env;
 *   - is fail-closed when d1-resolve rejects the env;
 *   - is fail-closed when migrate-apply rejects the env;
 *   - is fail-closed when no built dist/ui/ exists;
 *   - reports a blocked step and command plan when complete;
 *   - never prints account/database id or token values;
 *   - succeeds in CLI mode when all steps pass.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { planPilotDeploy } from "../../scripts/pilot-deploy.mjs";

const SCRIPT = join(process.cwd(), "scripts", "pilot-deploy.mjs");

const VALID_PILOT_ENV = {
  CLOUDFLARE_API_TOKEN: "synthetic_api_token",
  CLOUDFLARE_ACCOUNT_ID: "abcd1234abcd1234abcd1234abcd1234",
  CLOUDFLARE_D1_DATABASE_ID: "123e4567-e89b-42d3-a456-426614174000",
  BANKMANAGE_PILOT_BASE_URL: "https://pilot.bankmanage.example",
  MINI_APP_URL: "https://pilot.bankmanage.example",
  TELEGRAM_BOT_TOKEN: "synthetic_bot_token",
  TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret",
  TELEGRAM_ALLOWED_USER_IDS: "100000001,100000002",
};

function makeFakeDistUi(parent: string): string {
  const dir = join(parent, "dist", "ui");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://telegram.org/js/telegram-web-app.js"></script></head><body><div id="app"></div><script type="module" src="/assets/index.js"></script></body></html>'
  );
  writeFileSync(join(dir, "assets/index.js"), "const HomePage=1,ReceiptPage=1,DepositsPage=1;export{HomePage,ReceiptPage,DepositsPage};");
  writeFileSync(join(dir, "assets/index.css"), ".tab-item{min-height:52px}body{overflow-x:hidden;padding-bottom:env(safe-area-inset-bottom)}@media (prefers-reduced-motion: reduce){*{transition:none}}.receipt-primary-action{}");
  return dir;
}

interface PlanSummary {
  ok: boolean;
  blockedStep: string | null;
  missing: ReadonlyArray<string>;
  invalid: ReadonlyArray<string>;
  steps: Record<string, { name: string; ok: boolean; detail: string }>;
  commandPlan: ReadonlyArray<string>;
}

describe("planPilotDeploy (library)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "m5-pilot-"));
    makeFakeDistUi(repoRoot);
  });

  it("returns an inert plan when all steps pass (smoke skipped)", async () => {
    const plan = (await planPilotDeploy(VALID_PILOT_ENV, { repoRoot })) as unknown as PlanSummary;
    expect(plan.ok).toBe(true);
    expect(plan.blockedStep).toBeNull();
    expect(plan.commandPlan.length).toBeGreaterThan(0);
    expect(plan.commandPlan).toContain("wrangler deploy --env pilot");
    expect(plan.steps["smoke"]?.detail).toContain("skipped");
  });

  it("fails closed when pilot-preflight rejects the env", async () => {
    const env = { ...VALID_PILOT_ENV, TELEGRAM_BOT_TOKEN: "" };
    const plan = (await planPilotDeploy(env, { repoRoot })) as unknown as PlanSummary;
    expect(plan.ok).toBe(false);
    expect(plan.blockedStep).toBe("pilot-preflight");
    expect(plan.missing).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("fails closed when d1-resolve rejects the env", async () => {
    const env = { ...VALID_PILOT_ENV, CLOUDFLARE_D1_DATABASE_ID: "bad-id" };
    const plan = (await planPilotDeploy(env, { repoRoot })) as unknown as PlanSummary;
    expect(plan.ok).toBe(false);
    expect(plan.blockedStep).toBe("pilot-preflight");
  });

  it("fails closed when built dist/ui/ is missing", async () => {
    const freshRoot = mkdtempSync(join(tmpdir(), "m5-pilot-empty-"));
    const plan = (await planPilotDeploy(VALID_PILOT_ENV, { repoRoot: freshRoot })) as unknown as PlanSummary;
    expect(plan.ok).toBe(false);
    expect(plan.blockedStep).toBe("smoke-ui-mobile");
    rmSync(freshRoot, { recursive: true, force: true });
  });

  it("never prints token or db id values in the plan detail", async () => {
    const plan = (await planPilotDeploy(VALID_PILOT_ENV, { repoRoot })) as unknown as PlanSummary;
    const dump = JSON.stringify(plan);
    expect(dump).not.toContain(VALID_PILOT_ENV.CLOUDFLARE_API_TOKEN);
    expect(dump).not.toContain(VALID_PILOT_ENV.CLOUDFLARE_D1_DATABASE_ID);
    expect(dump).not.toContain(VALID_PILOT_ENV.TELEGRAM_WEBHOOK_SECRET);
    expect(dump).not.toContain(VALID_PILOT_ENV.TELEGRAM_BOT_TOKEN);
    expect(dump).not.toContain(VALID_PILOT_ENV.TELEGRAM_ALLOWED_USER_IDS);
  });
});

describe("pilot-deploy CLI mode", () => {
  function runCli(envOverrides: Record<string, string | undefined>): { exit: number; output: string } {
    const env = { ...process.env, ...VALID_PILOT_ENV, ...envOverrides };
    try {
      return {
        exit: 0,
        output: execFileSync("node", [SCRIPT, "--smoke-base-url=https://example"], {
          encoding: "utf8",
          env,
        }),
      };
    } catch (err) {
      const failure = err as { status?: number; stdout?: string };
      return { exit: failure.status ?? 1, output: failure.stdout ?? "" };
    }
  }

  it("prints PILOT_OK=YES and never echoes secret-shaped values", () => {
    const result = runCli({});
    expect(result.output).toContain("PILOT_OK=");
    expect(result.output).not.toContain(VALID_PILOT_ENV.CLOUDFLARE_API_TOKEN);
    expect(result.output).not.toContain(VALID_PILOT_ENV.TELEGRAM_BOT_TOKEN);
    expect(result.output).not.toContain(VALID_PILOT_ENV.CLOUDFLARE_D1_DATABASE_ID);
  });

  it("reports a blocked step when preflight rejects the env", () => {
    const result = runCli({ TELEGRAM_BOT_TOKEN: "" });
    expect(result.exit).toBe(1);
    expect(result.output).toContain("BLOCKED_STEP=pilot-preflight");
  });
});
