/**
 * tests/unit/post-deploy-smoke.test.ts
 *
 * Verifies the M5 post-deploy smoke script:
 *   - normalises the base URL to an HTTPS/HTTP origin;
 *   - passes all checks against a fake fetch that returns the production
 *     Worker contract;
 *   - fails the health check if the response leaks secret-shaped strings;
 *   - fails the webhook checks if the secret gate is bypassed;
 *   - fails the Mini App root check if the viewport/meta are absent;
 *   - fails the privacy guard if the rendered HTML embeds public R2 URL
 *     patterns;
 *   - uses a fake `fetch` so the suite never connects to the network.
 */

import { describe, expect, it } from "vitest";
import {
  normaliseBaseUrl,
  runPostDeploySmoke,
  type PostDeploySmokeOptions,
} from "../../scripts/post-deploy-smoke.mjs";

interface FakeResponseInit {
  status: number;
  body: string;
}

function makeFakeFetch(
  handler: (url: string, init: RequestInit | undefined) => FakeResponseInit
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const res = handler(url, init);
    return new Response(res.body, { status: res.status });
  }) as unknown as typeof fetch;
}

const HEALTHY_BODY = JSON.stringify({ status: "ok" });
const APP_HTML =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '</head><body><div id="app"></div></body></html>';

const PROBE_PAYLOAD = JSON.stringify({
  update_id: 1,
  message: { message_id: 1, date: 1700000000, chat: { id: 1, type: "private" } },
});

function options(overrides: Partial<PostDeploySmokeOptions> = {}): PostDeploySmokeOptions {
  return {
    baseUrl: "https://pilot.bankmanage.example",
    webhookProbePayload: PROBE_PAYLOAD,
    ...overrides,
  };
}

describe("normaliseBaseUrl", () => {
  it("accepts an https URL and strips trailing slash", () => {
    expect(normaliseBaseUrl("https://pilot.example/")).toBe("https://pilot.example");
  });

  it("accepts an http URL for local wrangler dev", () => {
    expect(normaliseBaseUrl("http://localhost:8787/")).toBe("http://localhost:8787");
  });

  it("rejects empty / non-URL / non-HTTP schemes", () => {
    expect(normaliseBaseUrl("")).toBeNull();
    expect(normaliseBaseUrl("not-a-url")).toBeNull();
    expect(normaliseBaseUrl("ftp://example.com")).toBeNull();
    expect(normaliseBaseUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("runPostDeploySmoke", () => {
  it("passes all checks against a conforming fake fetch", async () => {
    const fetchImpl = makeFakeFetch((url) => {
      if (url.endsWith("/health")) {
        return { status: 200, body: HEALTHY_BODY };
      }
      if (url.endsWith("/telegram/webhook")) {
        return { status: 403, body: JSON.stringify({ error: "Forbidden" }) };
      }
      if (url.endsWith("/")) {
        return { status: 200, body: APP_HTML };
      }
      return { status: 404, body: "" };
    });
    const result = await runPostDeploySmoke(options({ fetchImpl }));
    expect(result.ok).toBe(true);
    for (const r of result.results) {
      expect(r.pass, `${r.name}: ${r.detail}`).toBe(true);
    }
    expect(result.results.map((r) => r.name)).toEqual([
      "GET /health returns 200",
      "POST /telegram/webhook without secret -> 403",
      "POST /telegram/webhook with wrong secret -> 403",
      "GET / serves the Mini App shell",
      "private-document URLs never exposed",
    ]);
  });

  it("fails when the health endpoint leaks a secret-shaped string", async () => {
    const leaked = JSON.stringify({ status: "ok", TELEGRAM_BOT_TOKEN: "secret" });
    const fetchImpl = makeFakeFetch((url) => {
      if (url.endsWith("/health")) return { status: 200, body: leaked };
      if (url.endsWith("/")) return { status: 200, body: APP_HTML };
      return { status: 403, body: "{}" };
    });
    const result = await runPostDeploySmoke(options({ fetchImpl }));
    expect(result.ok).toBe(false);
    const health = result.results.find((r) => r.name === "GET /health returns 200");
    expect(health?.pass).toBe(false);
  });

  it("fails when health returns extra keys (config dump suspect)", async () => {
    const tooMany = JSON.stringify({ status: "ok", APP_ENV: "pilot" });
    const fetchImpl = makeFakeFetch((url) => {
      if (url.endsWith("/health")) return { status: 200, body: tooMany };
      if (url.endsWith("/")) return { status: 200, body: APP_HTML };
      return { status: 403, body: "{}" };
    });
    const result = await runPostDeploySmoke(options({ fetchImpl }));
    expect(result.ok).toBe(false);
    const health = result.results.find((r) => r.name === "GET /health returns 200");
    expect(health?.pass).toBe(false);
    expect(health?.detail).toContain("APP_ENV");
  });

  it("fails when /health returns the wrong status code", async () => {
    const fetchImpl = makeFakeFetch((url) => {
      if (url.endsWith("/health")) return { status: 503, body: "{}" };
      if (url.endsWith("/")) return { status: 200, body: APP_HTML };
      return { status: 403, body: "{}" };
    });
    const result = await runPostDeploySmoke(options({ fetchImpl }));
    expect(result.ok).toBe(false);
    expect(result.results[0]?.pass).toBe(false);
  });

  it("fails the webhook secret checks when the route accepts the body", async () => {
    const fetchImpl = makeFakeFetch((url) => {
      if (url.endsWith("/health")) return { status: 200, body: HEALTHY_BODY };
      if (url.endsWith("/telegram/webhook")) return { status: 200, body: "{}" };
      if (url.endsWith("/")) return { status: 200, body: APP_HTML };
      return { status: 404, body: "" };
    });
    const result = await runPostDeploySmoke(options({ fetchImpl }));
    expect(result.ok).toBe(false);
    const noSecret = result.results.find((r) => r.name === "POST /telegram/webhook without secret -> 403");
    const wrongSecret = result.results.find(
      (r) => r.name === "POST /telegram/webhook with wrong secret -> 403"
    );
    expect(noSecret?.pass).toBe(false);
    expect(wrongSecret?.pass).toBe(false);
  });

  it("fails the Mini App root check when viewport meta is missing", async () => {
    const noViewport = "<!doctype html><html><head></head><body><div id='app'></div></body></html>";
    const fetchImpl = makeFakeFetch((url) => {
      if (url.endsWith("/health")) return { status: 200, body: HEALTHY_BODY };
      if (url.endsWith("/telegram/webhook")) return { status: 403, body: "{}" };
      if (url.endsWith("/")) return { status: 200, body: noViewport };
      return { status: 404, body: "" };
    });
    const result = await runPostDeploySmoke(options({ fetchImpl }));
    expect(result.ok).toBe(false);
    const root = result.results.find((r) => r.name === "GET / serves the Mini App shell");
    expect(root?.pass).toBe(false);
  });

  it("fails the privacy guard when a public R2 URL is embedded", async () => {
    const leaked = APP_HTML.replace("</body>", "<a href='https://pub-abc123.r2.dev/x'>x</a></body>");
    const fetchImpl = makeFakeFetch((url) => {
      if (url.endsWith("/health")) return { status: 200, body: HEALTHY_BODY };
      if (url.endsWith("/telegram/webhook")) return { status: 403, body: "{}" };
      if (url.endsWith("/")) return { status: 200, body: leaked };
      return { status: 404, body: "" };
    });
    const result = await runPostDeploySmoke(options({ fetchImpl }));
    expect(result.ok).toBe(false);
    const privacy = result.results.find((r) => r.name === "private-document URLs never exposed");
    expect(privacy?.pass).toBe(false);
  });

  it("refuses a missing base URL up front", async () => {
    const result = await runPostDeploySmoke(options({ baseUrl: "" }));
    expect(result.ok).toBe(false);
    expect(result.results[0]?.name).toBe("post-deploy smoke configuration");
  });
});

describe("runPostDeploySmoke: payload shape", () => {
  it("default payload is a syntactically valid Telegram-looking JSON larger than the minimum", async () => {
    // The smoke checks only inspect the secret gate, but they pass a
    // payload through; verify it parses and is well-formed.
    expect(() => JSON.parse(PROBE_PAYLOAD)).not.toThrow();
    expect(PROBE_PAYLOAD.length).toBeGreaterThanOrEqual(32);
  });
});
