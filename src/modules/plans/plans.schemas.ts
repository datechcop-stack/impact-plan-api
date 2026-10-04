import { z } from "zod";

const componentInput = z.object({
  type: z.enum(["PROJECTS", "BD", "TECH_PERSONAL", "COP"]),
  enabled: z.boolean(),
  weight: z.number().int().min(0).max(100),
});

const entryInput = z.object({
  type: z.enum(["PROJECTS", "BD", "TECH_PERSONAL", "COP"]),
  title: z.string().min(1),
  objective: z.string().min(1),
  successCriteria: z.string().min(1),
  managerId: z.string().cuid(),
  dueDate: z.string().date(),
});

export const createPlanSchema = z.object({
  ownerId: z.string().cuid(),
  year: z.number().int().min(2020).max(2100),
  components: z.array(componentInput).length(4),
  entries: z.array(entryInput).default([]),
  lock: z.boolean().default(false),
});

/** Staff self-create: owner is always the authenticated user. */
export const createMyPlanSchema = createPlanSchema.omit({ ownerId: true });

export const updatePlanDraftSchema = z.object({
  components: z.array(componentInput).length(4).optional(),
  entries: z.array(entryInput).optional(),
});

export const listPlansQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
  q: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
