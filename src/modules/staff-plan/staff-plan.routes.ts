import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { authenticateRequest, requireCsrf } from "../auth/auth.routes.js";
import {
  editRequestCreateSchema,
  saveEntriesSchema,
  selfAssessmentSchema,
} from "./staff-plan.schemas.js";
import { StaffPlanService } from "./staff-plan.service.js";

export const staffPlanRoutes: FastifyPluginAsync<{ env: Env }> = async (app) => {
  const service = new StaffPlanService(prisma);

  app.get("/me/plan", { preHandler: authenticateRequest }, async (request) => {
    const year = z.coerce
      .number()
      .int()
      .optional()
      .parse((request.query as { year?: string }).year);
    return service.getMyPlan(request.authUser!.id, year ?? new Date().getFullYear());
  });

  app.post(
    "/me/plan/edit-requests",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = editRequestCreateSchema.parse(request.body);
      return service.createEditRequest(request.authUser!.id, body);
    },
  );

  app.patch(
    "/me/plan/entries",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = saveEntriesSchema.parse(request.body);
      return service.saveEntries(request.authUser!.id, body);
    },
  );

  app.post(
    "/me/plan/save-and-notify",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = saveEntriesSchema.parse(request.body);
      const result = await service.saveEntries(request.authUser!.id, body);
      await prisma.changeLog.create({
        data: {
          planId: result.plan.id,
          actorId: request.authUser!.id,
          action: "OWNER_NOTIFIED_ADMIN",
        },
      });
      return result;
    },
  );

  app.put(
    "/me/plan/entries/:id/self-assessment",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = selfAssessmentSchema.parse(request.body);
      return service.saveSelfAssessment(
        request.authUser!.id,
        (request.params as { id: string }).id,
        body,
      );
    },
  );

  app.post(
    "/me/plan/submit",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => service.submit(request.authUser!.id),
  );
};
