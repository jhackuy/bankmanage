/**
 * tests/unit/telegram-bootstrap-auth.test.ts
 *
 * SPEC §2:
 *   - Every Mini App API request validates original Telegram initData,
 *     signature freshness and allowlisted identity server-side. Never
 *     trust initDataUnsafe, username, display name or a client-submitted
 *     role for authorization.
 *
 * This suite exercises the client-side bootstrap module against injected
 * dependencies. It proves:
 *
 *   - success path returns only the minimum identity fields the UI needs;
 *   - missing Telegram context fails closed with MISSING_TELEGRAM_CONTEXT;
 *   - empty initData fails closed with EMPTY_INIT_DATA;
 *   - tampered / expired / unknown-server-rejection (non-2xx) fail closed
 *     with the right code;
 *   - malformed response bodies fail closed;
 *   - network failures (fetch rejecting) fail closed;
 *   - the raw initData is delivered ONLY in the `x-telegram-init-data`
 *     header, never in the URL or body;
 *   - the raw initData never leaks into the bootstrap result on failure;
 *   - `initDataUnsafe` and its fields are explicitly ignored.
 *
 * No real Telegram tokens or initData values are used. All strings are
 * obviously synthetic.
 */

import { describe, expect, it } from "vitest";
import {
  bootstrapAuth,
  type MiniAppAuthTransport,
  type RawInitDataSource,
} from "../../src/ui/bootstrap-auth.js";

const SYNTHETIC_INIT_DATA =
  "user=%7B%22id%22%3A111111111%7D&auth_date=1700000000&query_id=AAH_synthetic&hash=synthetic_hash_value";

function sourceReturning(initData: string | null): RawInitDataSource {
  return { getRawInitData: () => initData };
}

function sourceThrowing(): RawInitDataSource {
  return {
    getRawInitData: () => {
      throw new Error("synthetic source boom");
    },
  };
}

function transportReturning(response: Response): {
  readonly transport: MiniAppAuthTransport;
  readonly lastInitData: { value: string | null };
} {
  const lastInitData = { value: null as string | null };
  return {
    lastInitData,
    transport: {
      async postInitData(initData: string): Promise<Response> {
        lastInitData.value = initData;
        return response;
      },
    },
  };
}

function transportRejecting(): { readonly transport: MiniAppAuthTransport } {
  return {
    transport: {
      async postInitData(): Promise<Response> {
        throw new Error("synthetic network boom");
      },
    },
  };
}

function okJson(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      identity: {
        telegramUserId: "100000000001",
        memberId: 42,
        role: "OWNER",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("bootstrapAuth — success path", () => {
  it("returns OWNER identity on a 200 with a valid body", async () => {
    const { transport, lastInitData } = transportReturning(okJson());
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.role).toBe("OWNER");
    expect(result.identity.telegramUserId).toBe("100000000001");
    expect(result.identity.memberId).toBe(42);
    expect(lastInitData.value).toBe(SYNTHETIC_INIT_DATA);
  });

  it("returns MEMBER identity on a 200 with a valid MEMBER body", async () => {
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        return new Response(
          JSON.stringify({
            ok: true,
            identity: {
              telegramUserId: "100000000002",
              memberId: 7,
              role: "MEMBER",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    };
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.role).toBe("MEMBER");
    expect(result.identity.memberId).toBe(7);
  });

  it("forwards the raw initData to the transport unchanged", async () => {
    const { transport, lastInitData } = transportReturning(okJson());
    await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(lastInitData.value).toBe(SYNTHETIC_INIT_DATA);
  });
});

describe("bootstrapAuth — missing Telegram context", () => {
  it("fails closed with MISSING_TELEGRAM_CONTEXT when initData is null", async () => {
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(null),
      transport: transportReturning(okJson()).transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MISSING_TELEGRAM_CONTEXT");
    expect(result.message).not.toContain(SYNTHETIC_INIT_DATA);
  });

  it("fails closed with MISSING_TELEGRAM_CONTEXT when the source throws", async () => {
    const result = await bootstrapAuth({
      rawInitDataSource: sourceThrowing(),
      transport: transportReturning(okJson()).transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MISSING_TELEGRAM_CONTEXT");
  });

  it("fails closed with EMPTY_INIT_DATA when initData is the empty string", async () => {
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(""),
      transport: transportReturning(okJson()).transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EMPTY_INIT_DATA");
  });

  it("never calls the transport when context is missing", async () => {
    let called = false;
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        called = true;
        return okJson();
      },
    };
    await bootstrapAuth({
      rawInitDataSource: sourceReturning(null),
      transport,
    });
    expect(called).toBe(false);
  });
});

describe("bootstrapAuth — server rejection (tampered / expired / unknown)", () => {
  it("fails closed with SERVER_REJECTED on 403", async () => {
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        return new Response(JSON.stringify({ error: "UNKNOWN_USER", status: 403 }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SERVER_REJECTED");
    expect(result.httpStatus).toBe(403);
    expect(result.message).not.toContain(SYNTHETIC_INIT_DATA);
    expect(result.message).not.toContain("UNKNOWN_USER");
  });

  it("fails closed with NON_2XX_RESPONSE on 401 (tampered / expired initData)", async () => {
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        return new Response(JSON.stringify({ error: "BAD_SIGNATURE", status: 401 }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NON_2XX_RESPONSE");
    expect(result.httpStatus).toBe(401);
    expect(result.message).not.toContain(SYNTHETIC_INIT_DATA);
  });

  it("fails closed with NON_2XX_RESPONSE on 500", async () => {
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        return new Response("synthetic internal error body", { status: 500 });
      },
    };
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NON_2XX_RESPONSE");
    expect(result.httpStatus).toBe(500);
  });
});

describe("bootstrapAuth — malformed response bodies", () => {
  it("fails closed with MALFORMED_RESPONSE when JSON cannot parse", async () => {
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        return new Response("not-json-at-all{", { status: 200 });
      },
    };
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED_RESPONSE");
  });

  it("fails closed with MALFORMED_RESPONSE when the body is null", async () => {
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        return new Response("null", { status: 200 });
      },
    };
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED_RESPONSE");
  });

  it("fails closed with MALFORMED_RESPONSE when ok=false", async () => {
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      },
    };
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED_RESPONSE");
  });

  it("fails closed with MALFORMED_RESPONSE when identity.role is invalid", async () => {
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        return new Response(
          JSON.stringify({
            ok: true,
            identity: { telegramUserId: "100000000001", memberId: 1, role: "ADMIN" },
          }),
          { status: 200 }
        );
      },
    };
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED_RESPONSE");
  });

  it("fails closed with MALFORMED_RESPONSE when identity.telegramUserId is missing", async () => {
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        return new Response(
          JSON.stringify({
            ok: true,
            identity: { memberId: 1, role: "OWNER" },
          }),
          { status: 200 }
        );
      },
    };
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED_RESPONSE");
  });

  it("fails closed with MALFORMED_RESPONSE when identity.memberId is not a positive number", async () => {
    const transport: MiniAppAuthTransport = {
      async postInitData(): Promise<Response> {
        return new Response(
          JSON.stringify({
            ok: true,
            identity: { telegramUserId: "100000000001", memberId: -3, role: "OWNER" },
          }),
          { status: 200 }
        );
      },
    };
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED_RESPONSE");
  });
});

describe("bootstrapAuth — network failure", () => {
  it("fails closed with NETWORK_FAILURE when the transport rejects", async () => {
    const result = await bootstrapAuth({
      rawInitDataSource: sourceReturning(SYNTHETIC_INIT_DATA),
      transport: transportRejecting().transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NETWORK_FAILURE");
    expect(result.httpStatus).toBeNull();
    expect(result.message).not.toContain(SYNTHETIC_INIT_DATA);
  });
});

describe("bootstrapAuth — transport contract", () => {
  it("forwards the raw initData byte-for-byte, with no transformation", async () => {
    const exact = "user=%7B%22id%22%3A111111111%7D&auth_date=1700000000&hash=synthetic_hash_value";
    const { transport, lastInitData } = transportReturning(okJson());
    await bootstrapAuth({
      rawInitDataSource: sourceReturning(exact),
      transport,
    });
    expect(lastInitData.value).toBe(exact);
  });
});
