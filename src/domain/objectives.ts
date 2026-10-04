export type ObjectiveInput = {
  text: string;
  successCriteria: Array<{ text: string }>;
};

export const entryObjectivesInclude = {
  objectives: {
    include: {
      successCriteria: {
        orderBy: { sortOrder: "asc" as const },
      },
    },
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

export function objectivesCreateData(objectives: ObjectiveInput[]) {
  return {
    create: objectives.map((objective, objectiveIndex) => ({
      text: objective.text,
      sortOrder: objectiveIndex,
      successCriteria: {
        create: objective.successCriteria.map((criterion, criterionIndex) => ({
          text: criterion.text,
          sortOrder: criterionIndex,
        })),
      },
    })),
  };
}

export function assertObjectivesValid(objectives: ObjectiveInput[]) {
  if (objectives.length === 0) {
    return "At least one objective is required.";
  }
  for (const [index, objective] of objectives.entries()) {
    if (!objective.text.trim()) {
      return `Objective ${index + 1} cannot be empty.`;
    }
    if (objective.successCriteria.length === 0) {
      return `Objective ${index + 1} needs at least one success criterion.`;
    }
    for (const [criterionIndex, criterion] of objective.successCriteria.entries()) {
      if (!criterion.text.trim()) {
        return `Success criterion ${criterionIndex + 1} on objective ${index + 1} cannot be empty.`;
      }
    }
  }
  return null;
}
