import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Env } from "../../env.js";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { authenticateRequest, requireCsrf } from "../auth/auth.routes.js";
import { createMailer } from "../emails/mailer.js";
import { createMyPlanSchema, updatePlanDraftSchema } from "../plans/plans.schemas.js";
import { normalizePlanComponentTemplate } from "../../domain/plan-component-template.js";
import { PlansService } from "../plans/plans.service.js";
import {
  editRequestCreateSchema,
  employeeFeedbackSchema,
  saveEntriesSchema,
  selfAssessmentSchema,
} from "./staff-plan.schemas.js";
import { StaffPlanService } from "./staff-plan.service.js";

export const staffPlanRoutes: FastifyPluginAsync<{ env: Env }> = async (app, opts) => {
  const service = new StaffPlanService(prisma);
  const plansService = new PlansService(prisma);
  const mailer = createMailer(opts.env);

  app.get("/me/plan/create-template", { preHandler: authenticateRequest }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.authUser!.id },
      select: { planComponentTemplate: true },
    });
    return {
      components: normalizePlanComponentTemplate(user?.planComponentTemplate),
    };
  });

  app.get("/me/plans/years", { preHandler: authenticateRequest }, async (request) => {
    const userId = request.authUser!.id;
    const plans = await prisma.plan.findMany({
      where: { ownerId: userId },
      select: { year: true, status: true },
      orderBy: { year: "desc" },
    });
    return { plans };
  });

  app.get("/me/plan", { preHandler: authenticateRequest }, async (request) => {
    const year = z.coerce
      .number()
      .int()
      .optional()
      .parse((request.query as { year?: string }).year);
    return service.getMyPlan(request.authUser!.id, year ?? new Date().getFullYear());
  });

  app.post(
    "/me/plan",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = createMyPlanSchema.parse(request.body);
      const userId = request.authUser!.id;
      return plansService.create(userId, {
        ...body,
        ownerId: userId,
      });
    },
  );

  app.patch(
    "/me/plan",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = updatePlanDraftSchema.parse(request.body);
      const userId = request.authUser!.id;
      const year =
        z.coerce
          .number()
          .int()
          .optional()
          .parse((request.body as { year?: number }).year) ?? new Date().getFullYear();
      const owned = await prisma.plan.findUnique({
        where: { ownerId_year: { ownerId: userId, year } },
      });
      if (!owned) {
        throw notFound("Plan not found.");
      }
      const { components: _ignored, ...staffDraft } = body;
      return plansService.updateDraft(userId, owned.id, staffDraft);
    },
  );

  app.post(
    "/me/plan/lock",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const userId = request.authUser!.id;
      const year =
        z.coerce
          .number()
          .int()
          .optional()
          .parse((request.body as { year?: number }).year) ?? new Date().getFullYear();
      const owned = await prisma.plan.findUnique({
        where: { ownerId_year: { ownerId: userId, year } },
      });
      if (!owned) {
        throw notFound("Plan not found.");
      }
      return plansService.lock(userId, owned.id);
    },
  );

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
    async (request) => service.submit(request.authUser!.id, new Date().getFullYear(), mailer),
  );

  app.post(
    "/me/plan/feedback",
    {
      preHandler: [
        authenticateRequest,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = employeeFeedbackSchema.parse(request.body);
      return service.submitEmployeeFeedback(
        request.authUser!.id,
        body.feedback,
        body.year ?? new Date().getFullYear(),
      );
    },
  );
};
