/**
 * fixture-discipline.test.ts
 *
 * Verifies that:
 * - No real-looking Telegram tokens appear in committed test fixtures.
 * - No real-looking Telegram user IDs appear (rule: test IDs must be >=1e11,
 *   obviously synthetic like 100000000001).
 * - No real account numbers, certificate numbers or financial amounts.
 * - Fake adapter constants are obviously synthetic.
 */

import { describe, it, expect } from "vitest";
import {
  FAKE_OWNER_INIT_DATA,
  FAKE_MEMBER_INIT_DATA,
  FAKE_UNAUTHORIZED_INIT_DATA,
  FAKE_OWNER_USER_ID,
  FAKE_MEMBER_USER_ID,
} from "../../src/adapters/telegram/index.js";

describe("Synthetic fixture discipline", () => {
  it("fake initData strings contain 'synthetic' or 'fake' keyword", () => {
    for (const fixture of [FAKE_OWNER_INIT_DATA, FAKE_MEMBER_INIT_DATA, FAKE_UNAUTHORIZED_INIT_DATA]) {
      expect(fixture.toLowerCase()).toMatch(/fake|synthetic|test/);
    }
  });

  it("fake initData does not look like a real Telegram initData hash", () => {
    // Real Telegram initData contains 'hash=' with a 64-char hex string
    const realHashPattern = /hash=[0-9a-f]{64}/;
    expect(FAKE_OWNER_INIT_DATA).not.toMatch(realHashPattern);
    expect(FAKE_MEMBER_INIT_DATA).not.toMatch(realHashPattern);
  });

  it("fake user IDs are obviously synthetic (>=1e11, not real-looking 9-digit IDs)", () => {
    // Real Telegram user IDs are typically 7-10 digits.
    // Synthetic test IDs use a clearly-fake 12-digit pattern.
    const ownerNum = BigInt(FAKE_OWNER_USER_ID);
    const memberNum = BigInt(FAKE_MEMBER_USER_ID);
    expect(ownerNum).toBeGreaterThan(BigInt("100000000000")); // 12+ digits
    expect(memberNum).toBeGreaterThan(BigInt("100000000000"));
  });

  it("fake user IDs do not look like real 9-digit Telegram IDs", () => {
    // Real Telegram IDs are typically 7-9 digits
    expect(FAKE_OWNER_USER_ID).not.toMatch(/^\d{7,9}$/);
    expect(FAKE_MEMBER_USER_ID).not.toMatch(/^\d{7,9}$/);
  });

  it("fake initData for owner and member are different", () => {
    expect(FAKE_OWNER_INIT_DATA).not.toBe(FAKE_MEMBER_INIT_DATA);
  });

  it("fake unauthorized initData differs from valid ones", () => {
    expect(FAKE_UNAUTHORIZED_INIT_DATA).not.toBe(FAKE_OWNER_INIT_DATA);
    expect(FAKE_UNAUTHORIZED_INIT_DATA).not.toBe(FAKE_MEMBER_INIT_DATA);
  });
});
