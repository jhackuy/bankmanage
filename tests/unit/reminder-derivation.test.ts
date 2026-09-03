/**
 * Reminder domain tests — pure derivation of target dates around calendar
 * boundaries.
 *
 * Covers SPEC §5 D-30 / D-7 / D-1 / D0 around month boundaries, leap years
 * and year boundaries.
 */

import { describe, it, expect } from "vitest";
import {
  REMINDER_OFFSETS,
  REMINDER_OFFSET_KINDS,
  computeTargetDate,
  isReminderDue,
} from "../../src/domain/term-deposit/index.js";

describe("REMINDER_OFFSETS", () => {
  it("maps each offset kind to its day count", () => {
    expect(REMINDER_OFFSETS.D_MINUS_30).toBe(30);
    expect(REMINDER_OFFSETS.D_MINUS_7).toBe(7);
    expect(REMINDER_OFFSETS.D_MINUS_1).toBe(1);
    expect(REMINDER_OFFSETS.D0).toBe(0);
  });

  it("REMINDER_OFFSET_KINDS enumerates the four offsets", () => {
    expect(REMINDER_OFFSET_KINDS).toEqual(["D_MINUS_30", "D_MINUS_7", "D_MINUS_1", "D0"]);
  });
});

describe("computeTargetDate", () => {
  it("D_MINUS_30 for a mid-quarter maturity", () => {
    expect(computeTargetDate("2026-04-01", "D_MINUS_30")).toBe("2026-03-02");
  });

  it("D_MINUS_7 for a mid-quarter maturity", () => {
    expect(computeTargetDate("2026-04-01", "D_MINUS_7")).toBe("2026-03-25");
  });

  it("D_MINUS_1 for a mid-quarter maturity", () => {
    expect(computeTargetDate("2026-04-01", "D_MINUS_1")).toBe("2026-03-31");
  });

  it("D0 returns the maturity date verbatim", () => {
    expect(computeTargetDate("2026-04-01", "D0")).toBe("2026-04-01");
  });

  it("handles cross-month boundaries correctly", () => {
    // maturity=2026-03-01 → D_MINUS_30 is 2026-01-30 (30 days before in Jan)
    expect(computeTargetDate("2026-03-01", "D_MINUS_30")).toBe("2026-01-30");
    // maturity=2026-03-01 → D_MINUS_7 is 2026-02-22 (crosses into Feb)
    expect(computeTargetDate("2026-03-01", "D_MINUS_7")).toBe("2026-02-22");
    // maturity=2026-03-01 → D_MINUS_1 is 2026-02-28 (non-leap)
    expect(computeTargetDate("2026-03-01", "D_MINUS_1")).toBe("2026-02-28");
  });

  it("handles February in a leap year correctly", () => {
    // 2024 is a leap year; D_MINUS_1 from 2024-03-01 is 2024-02-29
    expect(computeTargetDate("2024-03-01", "D_MINUS_1")).toBe("2024-02-29");
    // 2024-03-01 D_MINUS_7 -> 2024-02-23
    expect(computeTargetDate("2024-03-01", "D_MINUS_7")).toBe("2024-02-23");
    // 2024-03-01 D_MINUS_30 -> 2024-01-31
    expect(computeTargetDate("2024-03-01", "D_MINUS_30")).toBe("2024-01-31");
  });

  it("handles cross-year boundaries correctly", () => {
    // maturity=2026-01-15 -> D_MINUS_30 = 2025-12-16
    expect(computeTargetDate("2026-01-15", "D_MINUS_30")).toBe("2025-12-16");
    // maturity=2026-01-15 -> D_MINUS_7 = 2026-01-08
    expect(computeTargetDate("2026-01-15", "D_MINUS_7")).toBe("2026-01-08");
    // maturity=2026-01-15 -> D_MINUS_1 = 2026-01-14
    expect(computeTargetDate("2026-01-15", "D_MINUS_1")).toBe("2026-01-14");
  });

  it("handles February 28 maturity in a leap year", () => {
    // 2024 is a leap year; maturity=2024-02-28 -> D_MINUS_30 = 2024-01-29
    expect(computeTargetDate("2024-02-28", "D_MINUS_30")).toBe("2024-01-29");
  });

  it("handles February 28 maturity in a non-leap year", () => {
    // 2026 is not a leap year; maturity=2026-02-28 -> D_MINUS_30 = 2026-01-29
    expect(computeTargetDate("2026-02-28", "D_MINUS_30")).toBe("2026-01-29");
    // maturity=2026-02-28 -> D_MINUS_7 = 2026-02-21
    expect(computeTargetDate("2026-02-28", "D_MINUS_7")).toBe("2026-02-21");
  });

  it("D0 returns the maturity date verbatim even at year boundary", () => {
    expect(computeTargetDate("2026-01-01", "D0")).toBe("2026-01-01");
    expect(computeTargetDate("2026-12-31", "D0")).toBe("2026-12-31");
  });

  it("rejects malformed maturity date", () => {
    expect(() => computeTargetDate("not-a-date", "D0")).toThrow();
    expect(() => computeTargetDate("2026-13-01", "D0")).toThrow();
    expect(() => computeTargetDate("2026-02-30", "D0")).toThrow();
  });
});

describe("isReminderDue", () => {
  it("today equals target_date: due", () => {
    expect(isReminderDue("2026-04-01", "2026-04-01")).toBe(true);
  });

  it("today after target_date: due", () => {
    expect(isReminderDue("2026-04-01", "2026-04-15")).toBe(true);
  });

  it("today before target_date: not due", () => {
    expect(isReminderDue("2026-04-01", "2026-03-25")).toBe(false);
  });

  it("rejects malformed today", () => {
    expect(() => isReminderDue("2026-04-01", "04/01/2026")).toThrow();
  });

  it("rejects malformed target_date", () => {
    expect(() => isReminderDue("not-a-date", "2026-04-01")).toThrow();
  });

  it("rejects impossible calendar today (regex-pass but not a real date)", () => {
    expect(() => isReminderDue("2026-04-01", "2026-99-99")).toThrow();
    expect(() => isReminderDue("2026-04-01", "2026-02-30")).toThrow();
    expect(() => isReminderDue("2026-04-01", "2026-13-01")).toThrow();
  });

  it("rejects impossible calendar target_date (regex-pass but not a real date)", () => {
    expect(() => isReminderDue("2026-99-99", "2026-04-01")).toThrow();
    expect(() => isReminderDue("2026-02-30", "2026-04-01")).toThrow();
    expect(() => isReminderDue("2026-13-01", "2026-04-01")).toThrow();
  });
});
