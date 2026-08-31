/**
 * bank-seed.test.ts
 *
 * Verifies that the bank seed configuration contains all required banks
 * and that banks are data (not an enum), so new banks can be added without
 * a code deployment.
 */

import { describe, it, expect } from "vitest";
import { SYSTEM_BANKS, SYSTEM_BANK_SLUGS, findSystemBank } from "../../data/config/banks.js";

describe("Bank seed data", () => {
  it("contains BDO", () => {
    expect(findSystemBank("bdo")).toBeDefined();
    expect(findSystemBank("bdo")?.shortName).toBe("BDO");
  });

  it("contains BPI", () => {
    expect(findSystemBank("bpi")).toBeDefined();
    expect(findSystemBank("bpi")?.shortName).toBe("BPI");
  });

  it("contains Metrobank", () => {
    expect(findSystemBank("metrobank")).toBeDefined();
    expect(findSystemBank("metrobank")?.shortName).toBe("Metrobank");
  });

  it("contains PNB", () => {
    expect(findSystemBank("pnb")).toBeDefined();
    expect(findSystemBank("pnb")?.shortName).toBe("PNB");
  });

  it("contains HSBC", () => {
    expect(findSystemBank("hsbc")).toBeDefined();
    expect(findSystemBank("hsbc")?.shortName).toBe("HSBC");
  });

  it("contains Other/custom bank boundary", () => {
    expect(findSystemBank("other")).toBeDefined();
    expect(findSystemBank("other")?.name).toMatch(/other/i);
  });

  it("all system banks are marked isSystem=true", () => {
    for (const bank of SYSTEM_BANKS) {
      expect(bank.isSystem).toBe(true);
    }
  });

  it("SYSTEM_BANK_SLUGS contains all six required slugs", () => {
    const required = ["bdo", "bpi", "metrobank", "pnb", "hsbc", "other"];
    for (const slug of required) {
      expect(SYSTEM_BANK_SLUGS).toContain(slug);
    }
  });

  it("banks are data — findSystemBank returns undefined for unknown slug", () => {
    // Unknown bank is not in enum; custom banks are added via the DB, not code
    expect(findSystemBank("does-not-exist")).toBeUndefined();
    expect(findSystemBank("eastwest")).toBeUndefined();
  });

  it("does not hard-code bank logic as TypeScript enum", () => {
    // SYSTEM_BANKS is a plain readonly array, not an enum.
    // Adding a new bank is done by pushing to the array + SQL migration;
    // no TypeScript recompilation needed to add data-only banks.
    expect(Array.isArray(SYSTEM_BANKS)).toBe(true);
    expect(SYSTEM_BANKS.length).toBeGreaterThanOrEqual(6);
  });
});
