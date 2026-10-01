import { z } from "zod";

export const pmListQuerySchema = z.object({
  q: z.string().optional(),
  component: z.enum(["PROJECTS", "BD", "TECH_PERSONAL", "COP", "ALL"]).default("ALL"),
  status: z.enum(["ALL", "AWAITING", "NOT_SUBMITTED", "REVIEWED"]).default("ALL"),
  year: z.coerce.number().int().optional(),
});

export const pmReviewSchema = z.object({
  score: z.number().int().min(0).max(100),
  comment: z.string().min(1).max(5000),
});
