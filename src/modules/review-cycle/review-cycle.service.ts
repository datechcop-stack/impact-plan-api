import type { PrismaClient } from "@prisma/client";
import { applyTransition } from "../../domain/lifecycle.js";
import { badRequest, notFound } from "../../lib/errors.js";

export class ReviewCycleService {
  constructor(private readonly db: PrismaClient) {}

  async get(year: number) {
    const cycle = await this.db.reviewCycle.findUnique({
      where: { year },
      include: { participants: { include: { user: { select: { id: true, fullName: true } } } } },
    });
    const plansWithPlan = await this.db.plan.count({ where: { year, status: { not: "DRAFT" } } });
    return { cycle, plansWithPlan };
  }

  async upsert(
    year: number,
    input: {
      windowOpens: string;
      selfAssessmentDeadline: string;
      pmScoringDeadline: string;
      finalizeDeadline: string;
      audience: "ALL_WITH_PLAN" | "SELECTED";
      remindOnOpen: boolean;
      remindBeforeDeadlines: boolean;
      weeklyLmSummary: boolean;
      participantIds?: string[];
    },
  ) {
    const cycle = await this.db.reviewCycle.upsert({
      where: { year },
      create: {
        year,
        windowOpens: new Date(input.windowOpens),
        selfAssessmentDeadline: new Date(input.selfAssessmentDeadline),
        pmScoringDeadline: new Date(input.pmScoringDeadline),
        finalizeDeadline: new Date(input.finalizeDeadline),
        audience: input.audience,
        remindOnOpen: input.remindOnOpen,
        remindBeforeDeadlines: input.remindBeforeDeadlines,
        weeklyLmSummary: input.weeklyLmSummary,
      },
      update: {
        windowOpens: new Date(input.windowOpens),
        selfAssessmentDeadline: new Date(input.selfAssessmentDeadline),
        pmScoringDeadline: new Date(input.pmScoringDeadline),
        finalizeDeadline: new Date(input.finalizeDeadline),
        audience: input.audience,
        remindOnOpen: input.remindOnOpen,
        remindBeforeDeadlines: input.remindBeforeDeadlines,
        weeklyLmSummary: input.weeklyLmSummary,
      },
    });

    if (input.audience === "SELECTED" && input.participantIds) {
      await this.db.reviewCycleParticipant.deleteMany({ where: { reviewCycleId: cycle.id } });
      if (input.participantIds.length > 0) {
        await this.db.reviewCycleParticipant.createMany({
          data: input.participantIds.map((userId) => ({
            reviewCycleId: cycle.id,
            userId,
          })),
        });
      }
    }

    return this.get(year);
  }

  async openNow(actorId: string, year: number) {
    const cycle = await this.db.reviewCycle.findUnique({
      where: { year },
      include: { participants: true },
    });
    if (!cycle) {
      throw notFound("Review cycle not found. Save a schedule first.");
    }

    const planFilter =
      cycle.audience === "SELECTED"
        ? {
            year,
            status: "LOCKED" as const,
            ownerId: { in: cycle.participants.map((p) => p.userId) },
          }
        : { year, status: "LOCKED" as const };

    const plans = await this.db.plan.findMany({ where: planFilter });
    await this.db.$transaction(async (tx) => {
      for (const plan of plans) {
        const next = applyTransition(plan.status, "OPEN_REVIEW");
        await tx.plan.update({ where: { id: plan.id }, data: { status: next } });
        await tx.changeLog.create({
          data: {
            planId: plan.id,
            actorId,
            action: "REVIEW_WINDOW_OPENED",
          },
        });
      }
      await tx.reviewCycle.update({
        where: { id: cycle.id },
        data: { status: "OPEN" },
      });
    });

    return { opened: plans.length };
  }

  async ensureYear(year: number) {
    if (!Number.isFinite(year)) {
      throw badRequest("Invalid year.");
    }
    return year;
  }
}
