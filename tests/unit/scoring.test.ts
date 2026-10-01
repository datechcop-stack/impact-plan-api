import { describe, expect, it } from "vitest";
import {
  computePlanScore,
  roundDisplay,
  validateWeights,
  type ComponentWeight,
  type ScoredEntry,
} from "../../src/domain/scoring.js";

const amakaWeights: ComponentWeight[] = [
  { type: "PROJECTS", weight: 40, enabled: true },
  { type: "BD", weight: 10, enabled: true },
  { type: "TECH_PERSONAL", weight: 30, enabled: true },
  { type: "COP", weight: 20, enabled: true },
];

const amakaEntries: ScoredEntry[] = [
  { componentType: "PROJECTS", score: 85 },
  { componentType: "PROJECTS", score: 90 },
  { componentType: "BD", score: 60 },
  { componentType: "TECH_PERSONAL", score: 80 },
  { componentType: "COP", score: 65 },
];

describe("computePlanScore", () => {
  it("matches page 14 final score of 78.0", () => {
    const result = computePlanScore(amakaWeights, amakaEntries);

    expect(result.isComplete).toBe(true);
    expect(roundDisplay(result.finalScore ?? 0)).toBe(78);
    expect(roundDisplay(result.components[0]?.score ?? 0)).toBe(87.5);
    expect(roundDisplay(result.components[0]?.points ?? 0)).toBe(35);
    expect(roundDisplay(result.components[1]?.points ?? 0)).toBe(6);
    expect(roundDisplay(result.components[2]?.points ?? 0)).toBe(24);
    expect(roundDisplay(result.components[3]?.points ?? 0)).toBe(13);
  });

  it("matches page 10 provisional 54.0 of 70", () => {
    const weights: ComponentWeight[] = [
      { type: "PROJECTS", weight: 50, enabled: true },
      { type: "BD", weight: 20, enabled: true },
      { type: "TECH_PERSONAL", weight: 20, enabled: true },
      { type: "COP", weight: 10, enabled: true },
    ];
    const entries: ScoredEntry[] = [
      { componentType: "PROJECTS", score: 85 },
      { componentType: "PROJECTS", score: 75 },
      { componentType: "BD", score: 70 },
    ];

    const result = computePlanScore(weights, entries);

    expect(result.isComplete).toBe(false);
    expect(roundDisplay(result.provisionalPoints)).toBe(54);
    expect(result.scoredWeightTotal).toBe(70);
    expect(roundDisplay(result.components[0]?.score ?? 0)).toBe(80);
  });

  it("validates weights total 100", () => {
    expect(validateWeights(amakaWeights)).toEqual({ ok: true, total: 100 });
    expect(
      validateWeights([
        { type: "PROJECTS", weight: 50, enabled: true },
        { type: "BD", weight: 20, enabled: true },
        { type: "TECH_PERSONAL", weight: 20, enabled: false },
        { type: "COP", weight: 10, enabled: true },
      ]),
    ).toEqual({ ok: false, total: 80 });
  });
});
