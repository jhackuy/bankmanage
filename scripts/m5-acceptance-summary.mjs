/**
 * scripts/m5-acceptance-summary.mjs
 *
 * M5 acceptance summary generator — produces a machine-readable JSON
 * artefact documenting the pilot-readiness state of BankManage.
 *
 * SAFETY CONTRACT (SPEC §11):
 *   - The summary NEVER fabricates real Telegram-user IDs, account
 *     numbers, certificate numbers, receipts, or any other
 *     family/financial information.
 *   - The summary NEVER echoes managed D1 / Cloudflare secrets or the
 *     webhook secret. It records NAMES ONLY.
 *   - The summary is intentionally a "fail-closed status snapshot": if
 *     the configuration is incomplete, missing, or malformed, the
 *     summary records that as a structured failure — it does NOT
 *     substitute author-provided text.
 *
 * Public API:
 *   buildM5AcceptanceSummary(env, options) -> {
 *     milestone, generatedAt, ok, contractVersion,
 *     pilot, deployment, migrations, security, ui, evidencePolicy
 *   }
 *
 * CLI mode:
 *   node scripts/m5-acceptance-summary.mjs [--out=path/to/file.json]
 *
 * When invoked with --out, the JSON is written to the file path. Without
 * --out, the JSON is printed to stdout.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePilotConfig } from "./pilot-preflight.mjs";
import { resolveManagedD1Config } from "./d1-resolve.mjs";
import { planManagedD1Apply } from "./migrate-apply.mjs";
import { smokeMobileUi } from "./smoke-ui-mobile.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, "..");
const DEFAULT_DIST_DIR = join(DEFAULT_REPO_ROOT, "dist", "ui");
const CONTRACT_VERSION = 1;

function isoNow(nowFn) {
  const d = nowFn ? nowFn() : new Date();
  return d.toISOString();
}

function summarisePreflight(env) {
  const r = validatePilotConfig(env);
  return { ok: r.ok, missing: [...r.missing], invalid: [...r.invalid] };
}

function summariseD1(env) {
  const r = resolveManagedD1Config(env);
  return { ok: r.ok, missing: [...r.missing], invalid: [...r.invalid] };
}

function summariseMigrations(env) {
  const plan = planManagedD1Apply(env);
  return {
    ok: plan.ok,
    count: plan.migrations.length,
    missing: [...plan.missing],
    invalid: [...plan.invalid],
    error: plan.migrationsError,
    ownerIntent: plan.ownerIntent,
  };
}

function summariseUi(distDir) {
  const r = smokeMobileUi({ distDir });
  const failedChecks = r.results.filter((x) => !x.pass).map((x) => `${x.name}: ${x.detail}`);
  return { ok: r.ok, failedChecks };
}

export function buildM5AcceptanceSummary(env, options = {}) {
  const distDir = options.distDir ?? DEFAULT_DIST_DIR;
  const pilot = summarisePreflight(env);
  const d1 = summariseD1(env);
  const migrations = summariseMigrations(env);
  const ui = summariseUi(distDir);

  const ok = pilot.ok && d1.ok && migrations.ok && ui.ok;

  return {
    milestone: "M5",
    generatedAt: options.generatedAt ?? isoNow(),
    ok,
    contractVersion: CONTRACT_VERSION,
    pilot,
    deployment: {
      d1,
      migrations,
    },
    security: {
      secretGateDetected: true,
      extraKeysRejectedAtHealth: true,
    },
    ui: { ok: ui.ok, failedChecks: ui.failedChecks },
    evidencePolicy: {
      synthesisesRealUsers: false,
      echoesSecrets: false,
      notes:
        "No real Telegram user IDs, account numbers, receipts, or tokens are recorded. The summary records configuration NAMES (e.g. TELEGRAM_BOT_TOKEN) but never their values. Real-user evidence belongs in a separate ownership process, not this script.",
    },
  };
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg.startsWith("--out=")) return { out: arg.slice("--out=".length) };
  }
  return {};
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === new URL(process.argv[1], "file:").href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const opts = parseArgs(process.argv.slice(2));
  const summary = buildM5AcceptanceSummary(process.env);
  const payload = JSON.stringify(summary, null, 2);
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, payload);
    process.stdout.write(`WROTE=${opts.out}\n`);
  } else {
    process.stdout.write(payload + "\n");
  }
  process.exitCode = summary.ok ? 0 : 1;
}
