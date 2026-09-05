/**
 * tests/unit/telegram-no-secrets.test.ts
 *
 * Static guard: the M4 implementation files (and the test files) MUST NOT
 * commit real Telegram tokens, real chat IDs, real initData payloads, or
 * keys that look like production secrets.
 *
 * SPEC §13: "Never commit real Telegram IDs/chat IDs/tokens ...
 * Use only synthetic/anonymized test fixtures."
 *
 * The fake adapter already exposes synthetic constants for tests; M4 test
 * data uses values prefixed `synthetic_` or `FAKE_` so accidental commits
 * of real tokens would be obvious.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REAL_TOKEN_PATTERN = /[0-9]{8,}:[A-Za-z0-9_-]{30,}/g; // real Telegram bot tokens look like "123456789:AAEh...-..."
const REAL_INITDATA_FRAGMENT = /telegram\.org\/initData/i;

function walk(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

const TARGET_FILES = [
  "src/domain/telegram/init-data.ts",
  "src/services/telegram/bot-service.ts",
  "src/services/telegram/reminder-delivery.ts",
  "src/services/telegram/mini-app-auth.ts",
  "src/services/telegram/identity-repository.ts",
  "src/services/telegram/d1-identity-repository.ts",
  "src/services/telegram/update-parser.ts",
  "src/services/telegram/update-envelope.ts",
  "src/services/telegram/update-deduper.ts",
  "src/services/telegram/update-parser-errors.ts",
  "src/services/telegram/index.ts",
  "src/worker/routes/telegram-webhook.ts",
  "src/worker/routes/telegram-mini-app.ts",
  "src/worker/index.ts",
  "src/adapters/telegram/cloudflare-http.ts",
  "src/adapters/telegram/interface.ts",
  "src/adapters/telegram/fake.ts",
  "tests/unit/telegram-init-data.test.ts",
  "tests/unit/telegram-webhook.test.ts",
  "tests/unit/telegram-bot-service.test.ts",
  "tests/unit/telegram-mini-app-auth.test.ts",
  "tests/unit/telegram-identity-repository.test.ts",
  "tests/unit/telegram-reminder-delivery.test.ts",
  "tests/unit/telegram-update-deduper.test.ts",
  "tests/unit/telegram-update-parser.test.ts",
  "tests/unit/telegram-no-secrets.test.ts",
].map((p) => join(process.cwd(), p));

describe("no secrets in M4 implementation or test files", () => {
  for (const path of TARGET_FILES) {
    it(`${path.replace(process.cwd(), "<root>")} contains no real Telegram bot tokens`, () => {
      const text = readFileSync(path, "utf-8");
      text.match(REAL_TOKEN_PATTERN);
      const matches = text.match(REAL_TOKEN_PATTERN);
      expect(matches ?? []).toEqual([]);
    });

    it(`${path.replace(process.cwd(), "<root>")} contains no initData URL fragment`, () => {
      const text = readFileSync(path, "utf-8");
      expect(text.match(REAL_INITDATA_FRAGMENT)).toBeNull();
    });
  }
});

describe("added M4 source files all exist", () => {
  it("file listing under src/services/telegram does not regress", () => {
    const acc = walk(join(process.cwd(), "src/services/telegram"), []);
    const names = acc.map((f) => f.split("/").pop());
    expect(names).toEqual(
      expect.arrayContaining([
        "bot-service.ts",
        "reminder-delivery.ts",
        "mini-app-auth.ts",
        "identity-repository.ts",
        "d1-identity-repository.ts",
        "update-parser.ts",
        "update-envelope.ts",
        "update-deduper.ts",
        "update-parser-errors.ts",
        "index.ts",
      ])
    );
  });
});
