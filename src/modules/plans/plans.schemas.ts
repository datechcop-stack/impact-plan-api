import { z } from "zod";

export const componentInput = z.object({
  type: z.enum(["PROJECTS", "BD", "TECH_PERSONAL", "COP"]),
  enabled: z.boolean(),
  weight: z.number().int().min(0).max(100),
});

const successCriterionInput = z.object({
  text: z.string().min(1),
});

const objectiveInput = z.object({
  text: z.string().min(1),
  successCriteria: z.array(successCriterionInput).min(1),
});

const entryInput = z.object({
  type: z.enum(["PROJECTS", "BD", "TECH_PERSONAL", "COP"]),
  title: z.string().min(1),
  objectives: z.array(objectiveInput).min(1),
  managerId: z.string().cuid(),
  dueDate: z.string().date(),
});

/** Relaxed validation for draft saves — server filters incomplete rows and defaults due dates. */
export const draftEntryInput = z.object({
  type: z.enum(["PROJECTS", "BD", "TECH_PERSONAL", "COP"]),
  title: z.string(),
  objectives: z.array(objectiveInput).default([]),
  managerId: z.union([z.string().cuid(), z.literal("")]).optional(),
  dueDate: z.union([z.string().date(), z.literal("")]).optional(),
});

export const createPlanSchema = z.object({
  ownerId: z.string().cuid(),
  year: z.number().int().min(2020).max(2100),
  components: z.array(componentInput).length(4),
  entries: z.array(entryInput).default([]),
  lock: z.boolean().default(false),
});

/** Staff self-create: owner is always the authenticated user. Components optional (admin defaults). */
export const createMyPlanSchema = createPlanSchema.omit({ ownerId: true }).extend({
  components: z.array(componentInput).length(4).optional(),
  entries: z.array(draftEntryInput).default([]),
});

export const updatePlanDraftSchema = z.object({
  components: z.array(componentInput).length(4).optional(),
  entries: z.array(draftEntryInput).optional(),
});

export const listPlansQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
  q: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
