import { z } from "zod";

export const editRequestCreateSchema = z.object({
  scope: z.enum(["WHOLE", "COMPONENT"]),
  componentType: z.enum(["PROJECTS", "BD", "TECH_PERSONAL", "COP"]).optional(),
  changeTypes: z
    .array(z.enum(["ADD_ENTRY", "EDIT_OBJECTIVE_CRITERIA", "CHANGE_MANAGER", "REMOVE_ENTRY"]))
    .min(1),
  reason: z.string().min(5).max(2000),
});

export const entryUpsertSchema = z.object({
  id: z.string().cuid().optional(),
  componentType: z.enum(["PROJECTS", "BD", "TECH_PERSONAL", "COP"]),
  title: z.string().min(1),
  objective: z.string().min(1),
  successCriteria: z.string().min(1),
  managerId: z.string().cuid(),
  dueDate: z.string().date(),
  sortOrder: z.number().int().nonnegative().optional(),
});

export const saveEntriesSchema = z.object({
  entries: z.array(entryUpsertSchema),
  removedEntryIds: z.array(z.string().cuid()).default([]),
});

export const selfAssessmentSchema = z.object({
  result: z.enum(["ACHIEVED", "PARTLY", "NOT"]),
  resultText: z.string().min(1).max(5000),
  evidenceUrl: z.string().url().optional().or(z.literal("")),
});
