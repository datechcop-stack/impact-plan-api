import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { authenticateRequest, requireCsrf } from "../auth/auth.routes.js";
import { lmCommentSchema, lmListQuerySchema } from "./lm.schemas.js";
import { LineManagerService } from "./lm.service.js";

export const lineManagerRoutes: FastifyPluginAsync<{ env: Env }> = async (app) => {
  const service = new LineManagerService(prisma);

  app.get("/lm/people", { preHandler: authenticateRequest }, async (request) =>
    service.listPeople(request.authUser!.id, lmListQuerySchema.parse(request.query)),
  );

  app.get("/lm/people/:userId/plan", { preHandler: authenticateRequest }, async (request) => {
    const year = z.coerce
      .number()
      .int()
      .optional()
      .parse((request.query as { year?: string }).year);
    return service.getPersonPlan(
      request.authUser!.id,
      (request.params as { userId: string }).userId,
      year ?? new Date().getFullYear(),
    );
  });

  app.put(
    "/lm/people/:userId/plan/comment",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = lmCommentSchema.parse(request.body);
      return service.saveComment(
        request.authUser!.id,
        (request.params as { userId: string }).userId,
        body.comment,
        body.recommendation,
      );
    },
  );

  app.post(
    "/lm/people/:userId/plan/finalize",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = lmCommentSchema.partial().parse(request.body ?? {});
      return service.finalize(
        request.authUser!.id,
        (request.params as { userId: string }).userId,
        body.comment,
        body.recommendation,
      );
    },
  );

  app.post(
    "/lm/people/:userId/remind",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) =>
      service.sendReminder(request.authUser!.id, (request.params as { userId: string }).userId),
  );
};
