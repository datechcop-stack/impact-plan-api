import type { FastifyPluginAsync } from "fastify";
import { isPmScoreComplete } from "../../domain/lifecycle.js";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { authenticateRequest } from "../auth/auth.routes.js";

export const navRoutes: FastifyPluginAsync<{ env: Env }> = async (app) => {
  app.get("/me/nav-counts", { preHandler: authenticateRequest }, async (request) => {
    const userId = request.authUser!.id;
    const year = new Date().getFullYear();

    const [goalAwaiting, scoringEntries, peopleCount, yearEndPlans, pendingEditRequests] =
      await Promise.all([
        prisma.planEntry.count({
          where: {
            managerId: userId,
            component: { enabled: true, plan: { year, status: "LOCKED" } },
            OR: [{ pmReview: { is: null } }, { pmReview: { is: { status: { not: "REVIEWED" } } } }],
          },
        }),
        prisma.planEntry.findMany({
          where: {
            managerId: userId,
            component: {
              enabled: true,
              plan: { year, status: "IN_REVIEW", submittedAt: { not: null } },
            },
          },
          select: { pmReview: { select: { status: true, score: true } } },
        }),
        prisma.user.count({
          where: { lineManagerId: userId, status: { in: ["ACTIVE", "INVITED"] } },
        }),
        prisma.plan.findMany({
          where: {
            year,
            status: { in: ["REVIEW_OPEN", "IN_REVIEW"] },
            owner: { lineManagerId: userId },
          },
          select: { id: true },
        }),
        request.authUser!.role === "ADMIN"
          ? prisma.editRequest.count({ where: { status: "PENDING" } })
          : Promise.resolve(0),
      ]);

    const scoringAwaiting = scoringEntries.filter(
      (entry) => !isPmScoreComplete(entry.pmReview),
    ).length;

    return {
      projectsAwaiting: goalAwaiting + scoringAwaiting,
      peopleCount,
      peopleAttention: yearEndPlans.length,
      pendingEditRequests,
    };
  });
};
