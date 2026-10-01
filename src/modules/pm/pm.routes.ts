import type { FastifyPluginAsync } from "fastify";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { authenticateRequest, requireCsrf } from "../auth/auth.routes.js";
import { pmListQuerySchema, pmReviewSchema } from "./pm.schemas.js";
import { PmService } from "./pm.service.js";

export const pmRoutes: FastifyPluginAsync<{ env: Env }> = async (app) => {
  const service = new PmService(prisma);

  app.get("/pm/entries", { preHandler: authenticateRequest }, async (request) =>
    service.list(request.authUser!.id, pmListQuerySchema.parse(request.query)),
  );

  app.get("/pm/entries/:id", { preHandler: authenticateRequest }, async (request) =>
    service.getEntry(request.authUser!.id, (request.params as { id: string }).id),
  );

  app.put(
    "/pm/entries/:id/review",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = pmReviewSchema.parse(request.body);
      return service.saveDraft(request.authUser!.id, (request.params as { id: string }).id, body);
    },
  );

  app.post(
    "/pm/entries/:id/mark-reviewed",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = pmReviewSchema.parse(request.body);
      return service.markReviewed(
        request.authUser!.id,
        (request.params as { id: string }).id,
        body,
      );
    },
  );
};
