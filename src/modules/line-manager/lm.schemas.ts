import { z } from "zod";

export const lmListQuerySchema = z.object({
  status: z.enum(["ALL", "DRAFT", "LOCKED", "IN_REVIEW", "FINALIZED"]).default("ALL"),
  year: z.coerce.number().int().optional(),
});

export const lmCommentSchema = z.object({
  comment: z.string().min(1).max(5000),
  recommendation: z.string().max(5000).optional(),
});
