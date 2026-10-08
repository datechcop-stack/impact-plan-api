import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { requireAdmin } from "../auth/require-admin.js";
import { requireCsrf } from "../auth/auth.routes.js";
import { createPlanSchema, listPlansQuerySchema, updatePlanDraftSchema } from "./plans.schemas.js";
import { PlansService } from "./plans.service.js";

export const plansRoutes: FastifyPluginAsync<{ env: Env }> = async (app) => {
  const service = new PlansService(prisma);

  app.get("/admin/plans", { preHandler: requireAdmin }, async (request) =>
    service.list(listPlansQuerySchema.parse(request.query)),
  );

  app.get("/admin/plans/:id", { preHandler: requireAdmin }, async (request) =>
    service.getById((request.params as { id: string }).id),
  );

  app.post(
    "/admin/plans",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = createPlanSchema.parse(request.body);
      return service.create(request.authUser!.id, body);
    },
  );

  app.patch(
    "/admin/plans/:id",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = updatePlanDraftSchema.parse(request.body);
      return service.updateDraft(request.authUser!.id, (request.params as { id: string }).id, body);
    },
  );

  app.patch(
    "/admin/plans/:id/entries/:entryId/manager",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const { id, entryId } = request.params as { id: string; entryId: string };
      const body = z.object({ managerId: z.string().cuid() }).parse(request.body);
      return service.reassignEntryManager(request.authUser!.id, id, entryId, body.managerId);
    },
  );

  app.post(
    "/admin/plans/:id/lock",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => service.lock(request.authUser!.id, (request.params as { id: string }).id),
  );

  app.get("/admin/plans/export", { preHandler: requireAdmin }, async (request) => {
    const year = Number((request.query as { year?: string }).year ?? new Date().getFullYear());
    const csv = await service.exportYearCsv(year);
    return { filename: `impact-plans-${year}.csv`, csv };
  });

  app.get("/admin/plans/templates/previous-year", { preHandler: requireAdmin }, async (request) => {
    const query = request.query as { ownerId?: string; year?: string };
    if (!query.ownerId || !query.year) {
      return null;
    }
    return service.previousYearTemplate(query.ownerId, Number(query.year));
  });
};
