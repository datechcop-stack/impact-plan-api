export type ComponentType = "PROJECTS" | "BD" | "TECH_PERSONAL" | "COP";

export type ScoredEntry = {
  componentType: ComponentType;
  score: number;
};

export type ComponentWeight = {
  type: ComponentType;
  weight: number;
  enabled: boolean;
};

export type ComponentScoreResult = {
  type: ComponentType;
  weight: number;
  score: number | null;
  points: number | null;
  entryScores: number[];
};

export type PlanScoreResult = {
  components: ComponentScoreResult[];
  provisionalPoints: number;
  scoredWeightTotal: number;
  finalScore: number | null;
  isComplete: boolean;
};

export function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

export function componentPoints(score: number, weight: number): number {
  return score * (weight / 100);
}

export function roundDisplay(value: number): number {
  return Math.round(value * 10) / 10;
}

export function computePlanScore(
  weights: ComponentWeight[],
  entries: ScoredEntry[],
): PlanScoreResult {
  const activeWeights = weights.filter((weight) => weight.enabled);
  const components: ComponentScoreResult[] = activeWeights.map((weight) => {
    const entryScores = entries
      .filter((entry) => entry.componentType === weight.type)
      .map((entry) => entry.score);
    const score = mean(entryScores);
    return {
      type: weight.type,
      weight: weight.weight,
      score,
      points: score === null ? null : componentPoints(score, weight.weight),
      entryScores,
    };
  });

  const scoredComponents = components.filter((component) => component.points !== null);
  const provisionalPoints = scoredComponents.reduce(
    (sum, component) => sum + (component.points ?? 0),
    0,
  );
  const scoredWeightTotal = scoredComponents.reduce((sum, component) => sum + component.weight, 0);
  const isComplete = components.every((component) => component.score !== null);
  const finalScore = isComplete ? provisionalPoints : null;

  return {
    components,
    provisionalPoints,
    scoredWeightTotal,
    finalScore,
    isComplete,
  };
}

export function validateWeights(weights: ComponentWeight[]): {
  ok: boolean;
  total: number;
} {
  const total = weights.filter((weight) => weight.enabled).reduce((sum, w) => sum + w.weight, 0);
  return { ok: total === 100, total };
}
