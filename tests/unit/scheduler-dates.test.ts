import { describe, expect, it } from "vitest";
import { daysBetweenFixture } from "./scheduler-helpers.js";

// lightweight date helper test via local fixture to keep domain pure
function daysUntil(target: Date, now: Date): number {
  const start = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((start(target) - start(now)) / (24 * 60 * 60 * 1000));
}

describe("review scheduler date math", () => {
  it("detects 3 days before deadline", () => {
    const deadline = new Date("2026-12-15T00:00:00Z");
    const now = new Date("2026-12-12T10:00:00Z");
    expect(daysUntil(deadline, now)).toBe(3);
    expect(daysBetweenFixture(deadline, now)).toBe(3);
  });
});
