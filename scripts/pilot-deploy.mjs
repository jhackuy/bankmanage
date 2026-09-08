/**
 * scripts/pilot-deploy.mjs
 *
 * Master orchestration driver for the M5 pilot deployment.
 *
 * This script coordinates the existing fail-closed steps:
 *   1. `pilot-preflight.mjs` — full pilot config validation
 *   2. `d1-resolve.mjs` — managed D1 configuration resolution
 *   3. `migrate-apply.mjs` — forward migration plan (names-only)
 *   4. `post-deploy-smoke.mjs` — post-deploy black-box smoke probes
 *   5. `smoke-ui-mobile.mjs` — static Mini App UI contract check
 *
 * SAFETY CONTRACT (SPEC §11, ADR-001):
 *   - The script is INERT by default. It never invokes `wrangler deploy`
 *     or `wrangler d1 migrations apply` itself. It prints a structured
 *     plan including the ordered child steps, and the deployment runner
 *     (a future managed workflow, OWNER-driven) is responsible for
 *     actually invoking Wrangler.
 *   - Every step inherits the fail-closed semantics of the underlying
 *     scripts. Missing/invalid configuration stops the script BEFORE any
 *     external mutation.
 *   - The script never prints secret-shaped values. Account ids,
 *     database ids, API tokens, webhook secrets, and Telegram user IDs
 *     are NAMES ONLY in its output.
 *   - When `--run-smoke` is provided, the script will probe the deployed
 *     base URL with the synthetic webhook payload and the Mini App root;
 *     those probes never carry a valid webhook secret and never persist.
 *
 * Public API:
 *   planPilotDeploy(env, options) -> {
 *     ok, blockedStep, missing[], invalid[],
 *     steps: { preflight, d1, migrations, smoke, ui },
 *     commandPlan: string[]
 *   }
 *
 * CLI mode:
 *   node scripts/pilot-deploy.mjs [--run-smoke] [--smoke-base-url=...]
 *   Exits 0 only when every step is OK.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePilotConfig } from "./pilot-preflight.mjs";
import { resolveManagedD1Config } from "./d1-resolve.mjs";
import { planManagedD1Apply, listForwardMigrations } from "./migrate-apply.mjs";
import { runPostDeploySmoke } from "./post-deploy-smoke.mjs";
import { smokeMobileUi } from "./smoke-ui-mobile.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, "..");

function summarisePreflight(env) {
  const r = validatePilotConfig(env);
  if (r.ok) return { name: "pilot-preflight", ok: true, detail: "ok" };
  return {
    name: "pilot-preflight",
    ok: false,
    detail: `missing=[${r.missing.join(",")}] invalid=[${r.invalid.join(",")}]`,
  };
}

function summariseD1(env) {
  const r = resolveManagedD1Config(env);
  if (r.ok) return { name: "d1-resolve", ok: true, detail: "ok" };
  const names = [...new Set([...r.missing, ...r.invalid])];
  return { name: "d1-resolve", ok: false, detail: `missing_or_invalid=[${names.join(",")}]` };
}

function summariseMigrations(env) {
  const r = planManagedD1Apply(env);
  if (r.ok) return { name: "migrate-apply", ok: true, detail: `count=${r.migrations.length}` };
  const names = [...new Set([...r.missing, ...r.invalid])];
  return {
    name: "migrate-apply",
    ok: false,
    detail:
      names.length > 0
        ? `missing_or_invalid=[${names.join(",")}]`
        : `migrations_error=${r.migrationsError ?? "unknown"}`,
  };
}

function summariseCommandPlan(steps) {
  const plan = [];
  if (steps["preflight"]?.ok) plan.push("scripts/pilot-preflight.mjs");
  if (steps["d1"]?.ok) plan.push("scripts/d1-resolve.mjs");
  if (steps["migrations"]?.ok) plan.push("scripts/migrate-apply.mjs --plan-only");
  plan.push("wrangler deploy --env pilot");
  if (steps["smoke"]?.ok) plan.push("scripts/post-deploy-smoke.mjs <baseUrl>");
  if (steps["ui"]?.ok) plan.push("scripts/smoke-ui-mobile.mjs");
  return plan;
}

async function summariseRun(internals) {
  const steps = {};
  steps["preflight"] = summarisePreflight(internals.env);
  steps["d1"] = summariseD1(internals.env);
  steps["migrations"] = summariseMigrations(internals.env);
  steps["ui"] = summariseStaticUiStep(internals.options.repoRoot ?? DEFAULT_REPO_ROOT);

  let smokeResult;
  if (internals.options.runSmoke) {
    const baseUrl = internals.options.smokeBaseUrl ?? "";
    const result = await runPostDeploySmoke({
      baseUrl,
      ...(internals.fetchImpl ? { fetchImpl: internals.fetchImpl } : {}),
    });
    smokeResult = { ok: result.ok, results: [...result.results] };
    steps["smoke"] = {
      name: "post-deploy-smoke",
      ok: result.ok,
      detail: result.ok
        ? `passed=${result.results.length}`
        : `failed_count=${result.results.filter((r) => !r.pass).length}`,
    };
  } else {
    steps["smoke"] = {
      name: "post-deploy-smoke",
      ok: true,
      detail: "skipped (--run-smoke not provided)",
    };
  }

  return { steps, smokeResult };
}

function summariseStaticUiStep(repoRoot) {
  const distDir = join(repoRoot, "dist", "ui");
  if (!existsSync(distDir)) {
    return { name: "smoke-ui-mobile", ok: false, detail: `missing ${distDir}` };
  }
  const r = smokeMobileUi({ distDir });
  if (r.ok) return { name: "smoke-ui-mobile", ok: true, detail: `results=${r.results.length}` };
  return {
    name: "smoke-ui-mobile",
    ok: false,
    detail: `failed_count=${r.results.filter((x) => !x.pass).length}`,
  };
}

export async function planPilotDeploy(env, options = {}) {
  const { steps } = await summariseRun({
    env,
    options: { ...options, runSmoke: options.runSmoke ?? false },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const blocked = Object.values(steps).find((s) => !s.ok) ?? null;
  const missingEnv = [];
  const invalidEnv = [];
  const missingFromPreflight = steps["preflight"]?.detail.match(/missing=\[([^\]]*)\]/u)?.[1] ?? "";
  if (missingFromPreflight) missingEnv.push(...missingFromPreflight.split(",").filter(Boolean));
  const invalidFromPreflight = steps["preflight"]?.detail.match(/invalid=\[([^\]]*)\]/u)?.[1] ?? "";
  if (invalidFromPreflight) invalidEnv.push(...invalidFromPreflight.split(",").filter(Boolean));

  if (!steps["migrations"]?.ok) {
    const d = steps["migrations"]?.detail ?? "";
    const m = d.match(/missing_or_invalid=\[([^\]]*)\]/u)?.[1];
    if (m) {
      for (const name of m.split(",").filter(Boolean)) {
        if (!missingEnv.includes(name)) missingEnv.push(name);
      }
    }
  }

  return {
    ok: blocked === null,
    blockedStep: blocked?.name ?? null,
    missing: missingEnv,
    invalid: invalidEnv,
    steps,
    commandPlan: summariseCommandPlan(steps),
  };
}

function parseArgs(argv) {
  let runSmoke = false;
  let smokeBaseUrl;
  for (const arg of argv) {
    if (arg === "--run-smoke") {
      runSmoke = true;
    } else if (arg.startsWith("--smoke-base-url=")) {
      smokeBaseUrl = arg.slice("--smoke-base-url=".length);
    }
  }
  return { runSmoke, ...(smokeBaseUrl ? { smokeBaseUrl } : {}) };
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
  const parsed = parseArgs(process.argv.slice(2));
  planPilotDeploy(process.env, parsed).then((plan) => {
    process.stdout.write(`PILOT_OK=${plan.ok ? "YES" : "NO"}\n`);
    if (plan.blockedStep) process.stdout.write(`BLOCKED_STEP=${plan.blockedStep}\n`);
    for (const step of Object.values(plan.steps)) {
      process.stdout.write(`${step.ok ? "PASS" : "FAIL"}\t${step.name}\t${step.detail}\n`);
    }
    process.stdout.write(`COMMAND_PLAN_COUNT=${plan.commandPlan.length}\n`);
    process.exitCode = plan.ok ? 0 : 1;
  });
}
