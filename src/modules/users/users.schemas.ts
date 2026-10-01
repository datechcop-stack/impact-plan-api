import { z } from "zod";

export const inviteUserSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  jobTitle: z.string().min(1).optional(),
  lineManagerId: z.string().cuid().nullable().optional(),
  role: z.enum(["STAFF", "ADMIN"]).default("STAFF"),
  remindCreatePlan: z.boolean().default(true),
});

export const updateUserSchema = z.object({
  fullName: z.string().min(2).optional(),
  jobTitle: z.string().nullable().optional(),
  lineManagerId: z.string().cuid().nullable().optional(),
  role: z.enum(["STAFF", "ADMIN"]).optional(),
  authMethod: z.enum(["PASSWORD", "OTP", "UNSET"]).optional(),
  status: z.enum(["INVITED", "ACTIVE", "DISABLED"]).optional(),
});

export const listUsersQuerySchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
