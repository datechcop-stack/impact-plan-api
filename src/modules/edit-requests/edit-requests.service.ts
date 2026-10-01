import type { ComponentType, PrismaClient } from "@prisma/client";
import { applyTransition } from "../../domain/lifecycle.js";
import { badRequest, notFound } from "../../lib/errors.js";

export class EditRequestsService {
  constructor(private readonly db: PrismaClient) {}

  async list(tab: "pending" | "unlocked" | "history") {
    if (tab === "pending") {
      const items = await this.db.editRequest.findMany({
        where: { status: "PENDING" },
        include: {
          requester: { select: { id: true, fullName: true } },
          plan: { select: { id: true, year: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return { items };
    }

    if (tab === "unlocked") {
      const plans = await this.db.plan.findMany({
        where: { status: { in: ["UNLOCKED", "PARTLY_UNLOCKED"] } },
        include: {
          owner: { select: { id: true, fullName: true } },
          components: true,
          editRequests: {
            where: { status: "UNLOCKED" },
            orderBy: { decidedAt: "desc" },
            take: 1,
          },
          changeLogs: {
            where: {
              action: { in: ["OWNER_SAVED_CHANGES", "PLAN_UNLOCKED", "COMPONENT_UNLOCKED"] },
            },
            orderBy: { createdAt: "desc" },
            take: 5,
          },
        },
      });
      return { items: plans };
    }

    const items = await this.db.editRequest.findMany({
      where: { status: { in: ["DECLINED", "COMPLETED"] } },
      include: {
        requester: { select: { id: true, fullName: true } },
        decidedBy: { select: { fullName: true } },
        plan: { select: { id: true, year: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return { items };
  }

  async decline(actorId: string, id: string) {
    const request = await this.db.editRequest.findUnique({ where: { id } });
    if (!request || request.status !== "PENDING") {
      throw notFound("Edit request not found.");
    }
    await this.db.$transaction([
      this.db.editRequest.update({
        where: { id },
        data: { status: "DECLINED", decidedById: actorId, decidedAt: new Date() },
      }),
      this.db.changeLog.create({
        data: {
          planId: request.planId,
          actorId,
          action: "EDIT_REQUEST_DECLINED",
          metadata: { editRequestId: id },
        },
      }),
    ]);
    return { ok: true };
  }

  async unlock(actorId: string, id: string, scope: "whole" | "component") {
    const request = await this.db.editRequest.findUnique({ where: { id } });
    if (!request || request.status !== "PENDING") {
      throw notFound("Edit request not found.");
    }
    const plan = await this.db.plan.findUnique({
      where: { id: request.planId },
      include: { components: true },
    });
    if (!plan) {
      throw notFound("Plan not found.");
    }

    const unlockWhole = scope === "whole" || request.scope === "WHOLE";
    const nextStatus = applyTransition(
      plan.status,
      unlockWhole ? "UNLOCK_WHOLE" : "UNLOCK_COMPONENT",
    );

    await this.db.$transaction(async (tx) => {
      await tx.plan.update({ where: { id: plan.id }, data: { status: nextStatus } });
      if (unlockWhole) {
        await tx.planComponent.updateMany({
          where: { planId: plan.id, enabled: true },
          data: { lockState: "UNLOCKED" },
        });
      } else {
        const type = request.componentType;
        if (!type) {
          throw badRequest("Component type required for component unlock.");
        }
        await tx.planComponent.update({
          where: { planId_type: { planId: plan.id, type } },
          data: { lockState: "UNLOCKED" },
        });
      }
      await tx.editRequest.update({
        where: { id },
        data: { status: "UNLOCKED", decidedById: actorId, decidedAt: new Date() },
      });
      await tx.changeLog.create({
        data: {
          planId: plan.id,
          actorId,
          action: unlockWhole ? "PLAN_UNLOCKED" : "COMPONENT_UNLOCKED",
          metadata: {
            editRequestId: id,
            componentType: unlockWhole ? null : request.componentType,
          },
        },
      });
    });

    return { ok: true };
  }

  async relock(actorId: string, planId: string) {
    const plan = await this.db.plan.findUnique({ where: { id: planId } });
    if (!plan) {
      throw notFound("Plan not found.");
    }
    const next = applyTransition(plan.status, "RELOCK");
    await this.db.$transaction([
      this.db.plan.update({ where: { id: planId }, data: { status: next } }),
      this.db.planComponent.updateMany({
        where: { planId },
        data: { lockState: "LOCKED" },
      }),
      this.db.editRequest.updateMany({
        where: { planId, status: "UNLOCKED" },
        data: { status: "COMPLETED" },
      }),
      this.db.changeLog.create({
        data: { planId, actorId, action: "PLAN_RELOCKED" },
      }),
    ]);
    return { ok: true };
  }

  // helper kept for type export usage in later phases
  componentLabel(type: ComponentType | null): string {
    switch (type) {
      case "PROJECTS":
        return "Projects";
      case "BD":
        return "Business Development";
      case "TECH_PERSONAL":
        return "Technical / Personal Dev";
      case "COP":
        return "Community of Practice";
      default:
        return "Whole plan";
    }
  }
}
