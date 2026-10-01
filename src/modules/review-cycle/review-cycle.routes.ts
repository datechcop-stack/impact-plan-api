import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { requireAdmin } from "../auth/require-admin.js";
import { requireCsrf } from "../auth/auth.routes.js";
import { ReviewCycleService } from "./review-cycle.service.js";

const upsertSchema = z.object({
  windowOpens: z.string().date(),
  selfAssessmentDeadline: z.string().date(),
  pmScoringDeadline: z.string().date(),
  finalizeDeadline: z.string().date(),
  audience: z.enum(["ALL_WITH_PLAN", "SELECTED"]),
  remindOnOpen: z.boolean(),
  remindBeforeDeadlines: z.boolean(),
  weeklyLmSummary: z.boolean(),
  participantIds: z.array(z.string().cuid()).optional(),
});

export const reviewCycleRoutes: FastifyPluginAsync<{ env: Env }> = async (app) => {
  const service = new ReviewCycleService(prisma);

  app.get("/admin/review-cycles/:year", { preHandler: requireAdmin }, async (request) => {
    const year = Number((request.params as { year: string }).year);
    await service.ensureYear(year);
    return service.get(year);
  });

  app.put(
    "/admin/review-cycles/:year",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const year = Number((request.params as { year: string }).year);
      await service.ensureYear(year);
      return service.upsert(year, upsertSchema.parse(request.body));
    },
  );

  app.post(
    "/admin/review-cycles/:year/open-now",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const year = Number((request.params as { year: string }).year);
      await service.ensureYear(year);
      return service.openNow(request.authUser!.id, year);
    },
  );
};
