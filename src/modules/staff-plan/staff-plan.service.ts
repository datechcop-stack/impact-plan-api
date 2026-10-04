import type { ComponentType, PrismaClient } from "@prisma/client";
import { applyTransition, isOwnerEditable, isSelfAssessmentOpen } from "../../domain/lifecycle.js";
import { computePlanScore } from "../../domain/scoring.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";

type EntryInput = {
  id?: string;
  componentType: ComponentType;
  title: string;
  objective: string;
  successCriteria: string;
  managerId: string;
  dueDate: string;
  sortOrder?: number;
};

export class StaffPlanService {
  constructor(private readonly db: PrismaClient) {}

  async getMyPlan(userId: string, year = new Date().getFullYear()) {
    const plan = await this.db.plan.findUnique({
      where: { ownerId_year: { ownerId: userId, year } },
      include: {
        owner: {
          select: {
            id: true,
            fullName: true,
            jobTitle: true,
            lineManager: { select: { id: true, fullName: true } },
          },
        },
        createdBy: { select: { fullName: true } },
        components: {
          include: {
            entries: {
              include: {
                manager: { select: { id: true, fullName: true } },
                selfAssessment: true,
                pmReview: {
                  include: { reviewer: { select: { id: true, fullName: true } } },
                },
              },
              orderBy: { sortOrder: "asc" },
            },
          },
          orderBy: { type: "asc" },
        },
        changeLogs: {
          take: 20,
          orderBy: { createdAt: "desc" },
          include: { actor: { select: { fullName: true } } },
        },
        editRequests: {
          where: { status: { in: ["PENDING", "UNLOCKED"] } },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
    });

    const reviewCycle = await this.db.reviewCycle.findUnique({ where: { year } });

    if (!plan) {
      return { plan: null, reviewCycle, score: null };
    }
    const scoredEntries = plan.components.flatMap((component) =>
      component.entries
        .filter((entry) => entry.pmReview?.status === "REVIEWED" && entry.pmReview.score != null)
        .map((entry) => ({
          componentType: component.type,
          score: entry.pmReview!.score!,
        })),
    );
    const score = computePlanScore(
      plan.components.map((c) => ({
        type: c.type,
        weight: c.weight,
        enabled: c.enabled,
      })),
      scoredEntries,
    );

    return { plan, reviewCycle, score };
  }

  async createEditRequest(
    userId: string,
    input: {
      scope: "WHOLE" | "COMPONENT";
      componentType?: ComponentType;
      changeTypes: string[];
      reason: string;
      year?: number;
    },
  ) {
    const year = input.year ?? new Date().getFullYear();
    const plan = await this.requireOwnedPlan(userId, year);
    if (plan.status !== "LOCKED") {
      throw badRequest("Edit requests are only available while the plan is locked.");
    }
    if (input.scope === "COMPONENT" && !input.componentType) {
      throw badRequest("Select a component to unlock.");
    }

    const pending = await this.db.editRequest.findFirst({
      where: { planId: plan.id, status: "PENDING" },
    });
    if (pending) {
      throw badRequest("You already have a pending edit request.");
    }

    const request = await this.db.$transaction(async (tx) => {
      const created = await tx.editRequest.create({
        data: {
          planId: plan.id,
          requesterId: userId,
          scope: input.scope,
          componentType: input.scope === "COMPONENT" ? input.componentType : null,
          changeTypes: input.changeTypes,
          reason: input.reason,
        },
      });
      await tx.changeLog.create({
        data: {
          planId: plan.id,
          actorId: userId,
          action: "EDIT_REQUESTED",
          metadata: {
            scope: input.scope,
            componentType: input.componentType ?? null,
            changeTypes: input.changeTypes,
          },
        },
      });
      return created;
    });

    return request;
  }

  async saveEntries(
    userId: string,
    input: { entries: EntryInput[]; removedEntryIds: string[]; year?: number },
  ) {
    const year = input.year ?? new Date().getFullYear();
    const plan = await this.db.plan.findUnique({
      where: { ownerId_year: { ownerId: userId, year } },
      include: { components: true },
    });
    if (!plan) {
      throw notFound("Plan not found.");
    }
    if (!isOwnerEditable(plan.status)) {
      throw forbidden("Plan is not unlocked for editing.");
    }

    const unlockedTypes = new Set(
      plan.components.filter((c) => c.lockState === "UNLOCKED" && c.enabled).map((c) => c.type),
    );
    if (plan.status === "UNLOCKED") {
      plan.components.filter((c) => c.enabled).forEach((c) => unlockedTypes.add(c.type));
    }

    for (const entry of input.entries) {
      if (!unlockedTypes.has(entry.componentType)) {
        throw forbidden(`Component ${entry.componentType} is locked.`);
      }
      if (entry.managerId === userId) {
        throw badRequest("Tagged manager cannot be the plan owner.");
      }
    }

    const componentByType = new Map(plan.components.map((c) => [c.type, c]));

    await this.db.$transaction(async (tx) => {
      if (input.removedEntryIds.length > 0) {
        const removable = await tx.planEntry.findMany({
          where: {
            id: { in: input.removedEntryIds },
            component: { planId: plan.id, type: { in: [...unlockedTypes] } },
          },
        });
        await tx.planEntry.deleteMany({
          where: { id: { in: removable.map((e) => e.id) } },
        });
      }

      for (const [index, entry] of input.entries.entries()) {
        const component = componentByType.get(entry.componentType);
        if (!component) {
          throw badRequest(`Unknown component ${entry.componentType}`);
        }
        if (entry.id) {
          await tx.planEntry.update({
            where: { id: entry.id },
            data: {
              title: entry.title,
              objective: entry.objective,
              successCriteria: entry.successCriteria,
              managerId: entry.managerId,
              dueDate: new Date(entry.dueDate),
              sortOrder: entry.sortOrder ?? index,
              componentId: component.id,
            },
          });
        } else {
          await tx.planEntry.create({
            data: {
              componentId: component.id,
              title: entry.title,
              objective: entry.objective,
              successCriteria: entry.successCriteria,
              managerId: entry.managerId,
              dueDate: new Date(entry.dueDate),
              sortOrder: entry.sortOrder ?? index,
            },
          });
        }
      }

      await tx.changeLog.create({
        data: {
          planId: plan.id,
          actorId: userId,
          action: "OWNER_SAVED_CHANGES",
          metadata: {
            entryCount: input.entries.length,
            removedCount: input.removedEntryIds.length,
          },
        },
      });
    });

    return this.requireMyPlan(userId, year);
  }

  async saveSelfAssessment(
    userId: string,
    entryId: string,
    input: { result: "ACHIEVED" | "PARTLY" | "NOT"; resultText: string; evidenceUrl?: string },
  ) {
    const entry = await this.db.planEntry.findUnique({
      where: { id: entryId },
      include: { component: { include: { plan: true } } },
    });
    if (!entry || entry.component.plan.ownerId !== userId) {
      throw notFound("Entry not found.");
    }
    if (!isSelfAssessmentOpen(entry.component.plan.status)) {
      throw forbidden("Self-assessment is not open for this plan.");
    }

    const evidenceUrl = input.evidenceUrl?.trim() ? input.evidenceUrl.trim() : null;
    await this.db.selfAssessment.upsert({
      where: { entryId },
      create: {
        entryId,
        result: input.result,
        resultText: input.resultText,
        evidenceUrl,
      },
      update: {
        result: input.result,
        resultText: input.resultText,
        evidenceUrl,
      },
    });

    return this.requireMyPlan(userId, entry.component.plan.year);
  }

  async submit(userId: string, year = new Date().getFullYear()) {
    const plan = await this.db.plan.findUnique({
      where: { ownerId_year: { ownerId: userId, year } },
      include: {
        components: {
          include: { entries: { include: { selfAssessment: true } } },
        },
      },
    });
    if (!plan) {
      throw notFound("Plan not found.");
    }
    if (!isSelfAssessmentOpen(plan.status)) {
      throw forbidden("Plan is not open for self-assessment submission.");
    }

    const entries = plan.components.filter((c) => c.enabled).flatMap((c) => c.entries);
    if (entries.length === 0) {
      throw badRequest("Plan has no entries to assess.");
    }
    const incomplete = entries.filter((e) => !e.selfAssessment);
    if (incomplete.length > 0) {
      throw badRequest("Every entry needs a result before you can submit.");
    }

    const next = applyTransition(plan.status, "SUBMIT_SELF_ASSESSMENT");
    await this.db.$transaction([
      this.db.plan.update({
        where: { id: plan.id },
        data: { status: next, submittedAt: new Date() },
      }),
      this.db.changeLog.create({
        data: {
          planId: plan.id,
          actorId: userId,
          action: "SELF_ASSESSMENT_SUBMITTED",
        },
      }),
    ]);

    return this.requireMyPlan(userId, year);
  }

  private async requireMyPlan(userId: string, year: number) {
    const result = await this.getMyPlan(userId, year);
    if (!result.plan) {
      throw notFound("Plan not found.");
    }
    return result;
  }

  private async requireOwnedPlan(userId: string, year: number) {
    const plan = await this.db.plan.findUnique({
      where: { ownerId_year: { ownerId: userId, year } },
    });
    if (!plan) {
      throw notFound("Plan not found.");
    }
    return plan;
  }
}
