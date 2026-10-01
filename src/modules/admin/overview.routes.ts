import type { FastifyPluginAsync } from "fastify";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { requireAdmin } from "../auth/require-admin.js";

export const adminOverviewRoutes: FastifyPluginAsync<{ env: Env }> = async (app) => {
  app.get("/admin/overview", { preHandler: requireAdmin }, async () => {
    const year = new Date().getFullYear();
    const [
      activeStaff,
      plansCreated,
      locked,
      inReview,
      finalized,
      noPlanYet,
      pendingEditRequests,
      pendingInvites,
      recentActivity,
      reviewCycle,
    ] = await Promise.all([
      prisma.user.count({ where: { status: "ACTIVE", role: "STAFF" } }),
      prisma.plan.count({ where: { year } }),
      prisma.plan.count({
        where: { year, status: { in: ["LOCKED", "PARTLY_UNLOCKED", "UNLOCKED"] } },
      }),
      prisma.plan.count({ where: { year, status: { in: ["REVIEW_OPEN", "IN_REVIEW"] } } }),
      prisma.plan.count({ where: { year, status: "FINALIZED" } }),
      prisma.user.count({
        where: {
          status: "ACTIVE",
          role: "STAFF",
          ownedPlans: { none: { year } },
        },
      }),
      prisma.editRequest.count({ where: { status: "PENDING" } }),
      prisma.user.count({ where: { status: "INVITED" } }),
      prisma.changeLog.findMany({
        take: 10,
        orderBy: { createdAt: "desc" },
        include: { actor: { select: { fullName: true } } },
      }),
      prisma.reviewCycle.findUnique({ where: { year } }),
    ]);

    return {
      year,
      stats: {
        activeStaff,
        plansCreated,
        locked,
        inReview,
        finalized,
        noPlanYet,
      },
      attention: {
        pendingEditRequests,
        staffWithoutPlan: noPlanYet,
        pendingInvites,
        reviewWindowOpens: reviewCycle?.windowOpens?.toISOString().slice(0, 10) ?? null,
      },
      recentActivity: recentActivity.map((item) => ({
        id: item.id,
        action: item.action,
        actorName: item.actor.fullName,
        metadata: item.metadata,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  });
};
