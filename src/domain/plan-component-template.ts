import type { ComponentType } from "@prisma/client";
import { z } from "zod";
import { DEFAULT_PROGRAMME_COMPONENTS, type DefaultComponentInput } from "./default-components.js";
import { validateWeights } from "./scoring.js";

const componentTemplateItem = z.object({
  type: z.enum(["PROJECTS", "BD", "TECH_PERSONAL", "COP"]),
  enabled: z.boolean(),
  weight: z.number().int().min(0).max(100),
});

export const planComponentTemplateSchema = z.array(componentTemplateItem).length(4);

export function normalizePlanComponentTemplate(input: unknown): DefaultComponentInput[] {
  const parsed = planComponentTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return DEFAULT_PROGRAMME_COMPONENTS;
  }
  const weightCheck = validateWeights(parsed.data);
  if (!weightCheck.ok) {
    return DEFAULT_PROGRAMME_COMPONENTS;
  }
  return parsed.data;
}

export function componentsForOwner(
  ownerTemplate: unknown,
  explicit?: DefaultComponentInput[],
): DefaultComponentInput[] {
  if (explicit?.length) {
    return explicit;
  }
  return normalizePlanComponentTemplate(ownerTemplate);
}

export type DraftEntryInput = {
  type: ComponentType;
  title: string;
  objectives: Array<{ text: string; successCriteria: Array<{ text: string }> }>;
  managerId?: string;
  dueDate?: string;
};

export function defaultDueDateForYear(year: number): string {
  return `${year}-12-31`;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Persist only entries the owner started; default missing due dates for drafts. */
export function entriesForDraftSave(
  entries: DraftEntryInput[],
  year: number,
  ownerId: string,
): Array<{
  type: ComponentType;
  title: string;
  objectives: DraftEntryInput["objectives"];
  managerId: string;
  dueDate: string;
}> {
  const dueDefault = defaultDueDateForYear(year);
  const result: Array<{
    type: ComponentType;
    title: string;
    objectives: DraftEntryInput["objectives"];
    managerId: string;
    dueDate: string;
  }> = [];

  for (const entry of entries) {
    const title = entry.title.trim();
    if (!title) continue;
    const managerId = entry.managerId?.trim() ?? "";
    if (!managerId || managerId === ownerId) continue;
    const dueDate = entry.dueDate && isIsoDate(entry.dueDate) ? entry.dueDate : dueDefault;
    result.push({
      type: entry.type,
      title,
      objectives: entry.objectives,
      managerId,
      dueDate,
    });
  }
  return result;
}

export function assertObjectivesValidForDraft(
  objectives: DraftEntryInput["objectives"],
): string | null {
  if (objectives.length === 0) {
    return null;
  }
  const hasAnyContent = objectives.some(
    (objective) =>
      objective.text.trim() || objective.successCriteria.some((criterion) => criterion.text.trim()),
  );
  if (!hasAnyContent) {
    return null;
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
        return `Success criterion ${criterionIndex + 1} for objective ${index + 1} cannot be empty.`;
      }
    }
  }
  return null;
}
