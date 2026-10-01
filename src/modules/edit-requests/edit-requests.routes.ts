import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { requireAdmin } from "../auth/require-admin.js";
import { requireCsrf } from "../auth/auth.routes.js";
import { EditRequestsService } from "./edit-requests.service.js";

export const editRequestsRoutes: FastifyPluginAsync<{ env: Env }> = async (app) => {
  const service = new EditRequestsService(prisma);

  app.get("/admin/edit-requests", { preHandler: requireAdmin }, async (request) => {
    const tab = z
      .enum(["pending", "unlocked", "history"])
      .default("pending")
      .parse((request.query as { tab?: string }).tab ?? "pending");
    return service.list(tab);
  });

  app.post(
    "/admin/edit-requests/:id/decline",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => service.decline(request.authUser!.id, (request.params as { id: string }).id),
  );

  app.post(
    "/admin/edit-requests/:id/unlock",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = z.object({ scope: z.enum(["whole", "component"]) }).parse(request.body);
      return service.unlock(
        request.authUser!.id,
        (request.params as { id: string }).id,
        body.scope,
      );
    },
  );

  app.post(
    "/admin/plans/:id/relock",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => service.relock(request.authUser!.id, (request.params as { id: string }).id),
  );
};
