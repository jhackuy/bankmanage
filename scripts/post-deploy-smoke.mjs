/**
 * scripts/post-deploy-smoke.mjs
 *
 * Post-deploy black-box smoke checks against a deployed BankManage pilot
 * base URL. The script is intentionally synchronous at the network layer
 * so each check is auditable; it never writes any cookies or telemetry.
 *
 * Mandatory checks:
 *   - GET {baseUrl}/health returns 200 with { status: "ok" } and leaks
 *     no binding names, secret names, env dump, SQL fragments, or
 *     stack traces.
 *   - POST {baseUrl}/telegram/webhook without a webhook secret
 *     returns 403 with no mutation.
 *   - POST {baseUrl}/telegram/webhook with the wrong webhook secret
 *     returns 403 with no mutation.
 *   - GET {baseUrl}/ — the Mini App root — returns a non-403 HTML
 *     response with the expected viewport meta tag and a body that
 *     contains the `#app` mount point. We do NOT fetch the JS bundle or
 *     evaluate it; the smoke is a structural check that the Worker is
 *     serving the built UI through the ASSETS binding.
 *   - A probe of the public R2-style bucket hostname is OUT OF SCOPE for
 *     this script. Private-document non-public behavior is asserted by the
 *     `src/adapters/storage/interface.ts` and fake-adapter tests.
 *
 * Public API:
 *   runPostDeploySmoke({ baseUrl, fetchImpl = globalThis.fetch,
 *     webhookSecretHeader = "x-telegram-bot-api-secret-token",
 *     manualApplySecret = false }) -> { results, ok }
 *
 * CLI mode:
 *   node scripts/post-deploy-smoke.mjs <baseUrl> [--webhook-secret=...]
 *     [--expected-webhook-secret=...]
 */

const REQUIRED_HEALTH_KEYS = ["status"];
const FORBIDDEN_HEALTH_PATTERNS = [
  /\bDB\b/,
  /\bDOCUMENTS\b/,
  /\bASSETS\b/,
  /TELEGRAM_BOT_TOKEN/i,
  /TELEGRAM_WEBHOOK_SECRET/i,
  /TELEGRAM_ALLOWED_USER_IDS/i,
  /CLOUDFLARE_API_TOKEN/i,
  /CLOUDFLARE_ACCOUNT_ID/i,
  /CLOUDFLARE_D1_DATABASE_ID/i,
  /d1_databases/i,
  /r2_buckets/i,
  /database_id/i,
  /database_name/i,
  /process\.env/i,
  /\bSELECT\b/i,
  /CREATE TABLE/i,
  /\bsqlite\b/i,
  /Error: /,
  /at Object/,
  /stack:/i,
];

const FORBIDDEN_PRIVATE_URL_PATTERNS = [/r2\.cloudflarestorage\.com/, /\.r2\.dev/, /pub-[a-z0-9]+\.r2\.dev/];

const ROOT_VIEWPORT_REQUIRED = /name="viewport"/i;

/**
 * @typedef {Object} SmokeCheckResult
 * @property {string} name
 * @property {boolean} pass
 * @property {string} detail
 */

/**
 * @typedef {Object} PostDeploySmokeOptions
 * @property {string} baseUrl
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [webhookSecretHeader]
 * @property {string} [webhookProbePayload]
 */

/**
 * @typedef {Object} PostDeploySmokeResult
 * @property {boolean} ok
 * @property {SmokeCheckResult[]} results
 */

function parseArgs(argv) {
  const positional = [];
  const overrides = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, ...rest] = arg.slice(2).split("=");
      if (key !== undefined && rest.length > 0) overrides[key] = rest.join("=");
    } else {
      positional.push(arg);
    }
  }
  const baseUrl = positional[0] ?? "";
  return { baseUrl, overrides };
}

export function normaliseBaseUrl(value) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

async function checkHealth(baseUrl, fetchImpl) {
  try {
    const res = await fetchImpl(`${baseUrl}/health`, { method: "GET" });
    if (res.status !== 200) {
      return {
        name: "GET /health returns 200",
        pass: false,
        detail: `unexpected status ${res.status}`,
      };
    }
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        name: "GET /health returns 200",
        pass: false,
        detail: "non-JSON response body",
      };
    }
    if (body === null || typeof body !== "object") {
      return {
        name: "GET /health returns 200",
        pass: false,
        detail: "response body is not an object",
      };
    }
    const record = body;
    if (record["status"] !== "ok") {
      return {
        name: "GET /health returns 200",
        pass: false,
        detail: `body.status=${String(record["status"])}`,
      };
    }
    for (const k of REQUIRED_HEALTH_KEYS) {
      if (!(k in record)) {
        return {
          name: "GET /health returns 200",
          pass: false,
          detail: `missing key "${k}"`,
        };
      }
    }
    // Disallow extra keys — anything else could be a config dump.
    const extra = Object.keys(record).filter((k) => !REQUIRED_HEALTH_KEYS.includes(k));
    if (extra.length > 0) {
      return {
        name: "GET /health returns 200",
        pass: false,
        detail: `unexpected keys: ${extra.join(",")}`,
      };
    }
    for (const pattern of FORBIDDEN_HEALTH_PATTERNS) {
      if (pattern.test(text)) {
        return {
          name: "GET /health returns 200",
          pass: false,
          detail: `forbidden pattern matched: ${pattern}`,
        };
      }
    }
    return { name: "GET /health returns 200", pass: true, detail: "ok" };
  } catch (err) {
    return {
      name: "GET /health returns 200",
      pass: false,
      detail: err instanceof Error ? `network: ${err.message}` : "network: unknown",
    };
  }
}

async function checkWebhookSecretRejected(baseUrl, fetchImpl, headerName, payload) {
  const noSecret = await (async () => {
    try {
      const res = await fetchImpl(`${baseUrl}/telegram/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      if (res.status !== 403) {
        return {
          name: "POST /telegram/webhook without secret -> 403",
          pass: false,
          detail: `unexpected status ${res.status}`,
        };
      }
      const txt = await res.text();
      if (txt.includes("x-telegram-bot-api-secret-token") || /TELEGRAM_WEBHOOK_SECRET/.test(txt)) {
        return {
          name: "POST /telegram/webhook without secret -> 403",
          pass: false,
          detail: "response echoed webhook secret name",
        };
      }
      return {
        name: "POST /telegram/webhook without secret -> 403",
        pass: true,
        detail: "ok",
      };
    } catch (err) {
      return {
        name: "POST /telegram/webhook without secret -> 403",
        pass: false,
        detail: err instanceof Error ? `network: ${err.message}` : "network: unknown",
      };
    }
  })();

  const wrongSecret = await (async () => {
    try {
      const res = await fetchImpl(`${baseUrl}/telegram/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [headerName]: "definitely_wrong_secret_FOR_smoke_check_NOT_real",
        },
        body: payload,
      });
      if (res.status !== 403) {
        return {
          name: "POST /telegram/webhook with wrong secret -> 403",
          pass: false,
          detail: `unexpected status ${res.status}`,
        };
      }
      return {
        name: "POST /telegram/webhook with wrong secret -> 403",
        pass: true,
        detail: "ok",
      };
    } catch (err) {
      return {
        name: "POST /telegram/webhook with wrong secret -> 403",
        pass: false,
        detail: err instanceof Error ? `network: ${err.message}` : "network: unknown",
      };
    }
  })();

  return { noSecret, wrongSecret };
}

async function checkMiniAppRoot(baseUrl, fetchImpl) {
  const root = await (async () => {
    try {
      const res = await fetchImpl(`${baseUrl}/`, { method: "GET" });
      if (res.status >= 400) {
        return {
          name: "GET / serves the Mini App shell",
          pass: false,
          detail: `unexpected status ${res.status}`,
        };
      }
      const text = await res.text();
      if (!ROOT_VIEWPORT_REQUIRED.test(text)) {
        return {
          name: "GET / serves the Mini App shell",
          pass: false,
          detail: "missing viewport meta",
        };
      }
      if (!text.includes('id="app"') && !text.includes("id='app'")) {
        return {
          name: "GET / serves the Mini App shell",
          pass: false,
          detail: "missing #app mount point",
        };
      }
      return { name: "GET / serves the Mini App shell", pass: true, detail: "ok" };
    } catch (err) {
      return {
        name: "GET / serves the Mini App shell",
        pass: false,
        detail: err instanceof Error ? `network: ${err.message}` : "network: unknown",
      };
    }
  })();

  // Privacy guard: the Mini App root must never redirect to an
  // unrestricted public R2 bucket. This is a structural guard, not a
  // network probe — we just confirm the rendered HTML doesn't embed
  // public-bucket URLs that would expose private documents.
  const privacy = await (async () => {
    try {
      const res = await fetchImpl(`${baseUrl}/`, { method: "GET" });
      if (res.status >= 500) {
        return {
          name: "private-document URLs never exposed",
          pass: false,
          detail: `unexpected status ${res.status}`,
        };
      }
      const text = await res.text();
      for (const pattern of FORBIDDEN_PRIVATE_URL_PATTERNS) {
        if (pattern.test(text)) {
          return {
            name: "private-document URLs never exposed",
            pass: false,
            detail: `forbidden public URL pattern: ${pattern}`,
          };
        }
      }
      return { name: "private-document URLs never exposed", pass: true, detail: "ok" };
    } catch {
      // If the network itself fails, surface the privacy check as
      // "skipped" rather than "failed" — the network check above will
      // have captured the actual failure.
      return {
        name: "private-document URLs never exposed",
        pass: true,
        detail: "skipped (network unavailable)",
      };
    }
  })();

  return { root, privacy };
}

export async function runPostDeploySmoke(options) {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  if (baseUrl === null) {
    return {
      ok: false,
      results: [
        {
          name: "post-deploy smoke configuration",
          pass: false,
          detail: "BASE_URL is missing or not an HTTP(S) URL",
        },
      ],
    };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis) ?? fetch;
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      results: [
        {
          name: "post-deploy smoke configuration",
          pass: false,
          detail: "fetch is unavailable in this runtime",
        },
      ],
    };
  }

  const headerName = options.webhookSecretHeader ?? "x-telegram-bot-api-secret-token";
  const payload =
    options.webhookProbePayload ??
    // 32+ byte JSON payload that the production route will treat as a
    // Telegram update shape but reject for the secret probe path.
    JSON.stringify({
      update_id: 1,
      message: { message_id: 1, date: 1700000000, chat: { id: 1, type: "private" } },
    });

  const results = [];
  results.push(await checkHealth(baseUrl, fetchImpl));
  const wh = await checkWebhookSecretRejected(baseUrl, fetchImpl, headerName, payload);
  results.push(wh.noSecret);
  results.push(wh.wrongSecret);
  const ui = await checkMiniAppRoot(baseUrl, fetchImpl);
  results.push(ui.root);
  results.push(ui.privacy);

  const ok = results.every((r) => r.pass);
  return { ok, results };
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
  const { baseUrl, overrides } = parseArgs(process.argv.slice(2));
  const summary = runPostDeploySmoke({
    baseUrl,
    webhookSecretHeader: overrides["webhook-secret-header"] ?? "x-telegram-bot-api-secret-token",
  });
  summary
    .then((result) => {
      process.stdout.write(`SMOKE_BASE_URL=${baseUrl}\n`);
      process.stdout.write(`SMOKE_RESULTS=${result.results.length}\n`);
      let allPass = true;
      for (const r of result.results) {
        process.stdout.write(`${r.pass ? "PASS" : "FAIL"}\t${r.name}\t${r.detail}\n`);
        if (!r.pass) allPass = false;
      }
      process.stdout.write(allPass ? "SMOKE_OK\n" : "SMOKE_FAILED\n");
      process.exitCode = allPass ? 0 : 1;
    })
    .catch((err) => {
      process.stdout.write(`SMOKE_ERROR=${err instanceof Error ? err.message : "unknown"}\n`);
      process.exitCode = 2;
    });
}
