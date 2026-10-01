import type { FastifyPluginAsync } from "fastify";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { authenticateRequest } from "../auth/auth.routes.js";

export const navRoutes: FastifyPluginAsync<{ env: Env }> = async (app) => {
  app.get("/me/nav-counts", { preHandler: authenticateRequest }, async (request) => {
    const userId = request.authUser!.id;
    const year = new Date().getFullYear();

    const [awaitingPm, peopleCount, pendingEditRequests] = await Promise.all([
      prisma.planEntry.count({
        where: {
          managerId: userId,
          component: {
            enabled: true,
            plan: { year, status: "IN_REVIEW" },
          },
          OR: [{ pmReview: null }, { pmReview: { status: { not: "REVIEWED" } } }],
        },
      }),
      prisma.user.count({
        where: { lineManagerId: userId, status: { in: ["ACTIVE", "INVITED"] } },
      }),
      request.authUser!.role === "ADMIN"
        ? prisma.editRequest.count({ where: { status: "PENDING" } })
        : Promise.resolve(0),
    ]);

    return {
      projectsAwaiting: awaitingPm,
      peopleCount,
      pendingEditRequests,
    };
  });
};
