import type { PrismaClient } from "@prisma/client";
import { applyTransition } from "../../domain/lifecycle.js";
import { badRequest, notFound } from "../../lib/errors.js";
import type { Mailer } from "../emails/mailer.js";
import { reviewWindowOpenedEmailHtml, sendMail } from "../emails/mailer.js";

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
      purpose: "MIDYEAR_PLAN_UPDATE" | "YEAR_END_REVIEW";
      remindOnOpen: boolean;
      remindBeforeDeadlines: boolean;
      weeklyLmSummary: boolean;
      participantIds?: string[];
    },
  ) {
    if (
      input.audience === "SELECTED" &&
      (!input.participantIds || input.participantIds.length === 0)
    ) {
      throw badRequest("Select at least one person when using Selected people only.");
    }

    const cycle = await this.db.reviewCycle.upsert({
      where: { year },
      create: {
        year,
        windowOpens: new Date(input.windowOpens),
        selfAssessmentDeadline: new Date(input.selfAssessmentDeadline),
        pmScoringDeadline: new Date(input.pmScoringDeadline),
        finalizeDeadline: new Date(input.finalizeDeadline),
        audience: input.audience,
        purpose: input.purpose,
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
        purpose: input.purpose,
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

  async openNow(actorId: string, year: number, mailer?: Mailer) {
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

    const plans = await this.db.plan.findMany({
      where: planFilter,
      include: { owner: { select: { id: true, fullName: true, email: true } } },
    });
    const midyear = cycle.purpose === "MIDYEAR_PLAN_UPDATE";
    await this.db.$transaction(async (tx) => {
      for (const plan of plans) {
        const next = applyTransition(plan.status, midyear ? "UNLOCK_WHOLE" : "OPEN_REVIEW");
        await tx.plan.update({ where: { id: plan.id }, data: { status: next } });
        if (midyear) {
          await tx.planComponent.updateMany({
            where: { planId: plan.id, enabled: true },
            data: { lockState: "UNLOCKED" },
          });
        }
        await tx.changeLog.create({
          data: {
            planId: plan.id,
            actorId,
            action: midyear ? "MIDYEAR_REVIEW_OPENED" : "REVIEW_WINDOW_OPENED",
            metadata: { purpose: cycle.purpose },
          },
        });
      }
      await tx.reviewCycle.update({
        where: { id: cycle.id },
        data: { status: "OPEN" },
      });
    });

    if (mailer && cycle.remindOnOpen) {
      const windowLabel = midyear
        ? "Mid-year plan update window"
        : "Year-end self-assessment window";
      for (const plan of plans) {
        const html = reviewWindowOpenedEmailHtml({
          firstName: plan.owner.fullName.split(" ")[0] ?? plan.owner.fullName,
          year,
          windowLabel,
          deadline: midyear
            ? cycle.selfAssessmentDeadline.toISOString().slice(0, 10)
            : cycle.selfAssessmentDeadline.toISOString().slice(0, 10),
        });
        await sendMail(mailer, {
          to: plan.owner.email,
          subject: `${windowLabel} · Impact Plan ${year}`,
          html,
          text: `${windowLabel} for ${year} is now open. Sign in to Impact Plan to continue.`,
        });
      }
    }

    return { opened: plans.length, purpose: cycle.purpose };
  }

  async prepareNewYear(actorId: string, year: number, mailer?: Mailer) {
    await this.ensureYear(year);
    const users = await this.db.user.findMany({
      where: { status: "ACTIVE", role: "STAFF" },
      select: { id: true, fullName: true, email: true },
    });
    await this.db.reviewCycle.upsert({
      where: { year },
      create: {
        year,
        windowOpens: new Date(`${year}-01-15`),
        selfAssessmentDeadline: new Date(`${year}-06-30`),
        pmScoringDeadline: new Date(`${year}-11-15`),
        finalizeDeadline: new Date(`${year}-12-31`),
        audience: "ALL_WITH_PLAN",
        purpose: "YEAR_END_REVIEW",
        status: "SCHEDULED",
      },
      update: { status: "SCHEDULED" },
    });

    if (mailer) {
      for (const user of users) {
        const html = reviewWindowOpenedEmailHtml({
          firstName: user.fullName.split(" ")[0] ?? user.fullName,
          year,
          windowLabel: "New Impact Plan cycle",
          deadline: `${year}-12-31`,
        });
        await sendMail(mailer, {
          to: user.email,
          subject: `Prepare your Impact Plan for ${year}`,
          html,
          text: `Please sign in and create your Impact Plan for ${year}.`,
        });
      }
    }

    await this.db.changeLog.create({
      data: {
        actorId,
        action: "NEW_CYCLE_PREPARED",
        metadata: { year, notified: users.length },
      },
    });

    return { year, notified: users.length };
  }

  async ensureYear(year: number) {
    if (!Number.isFinite(year)) {
      throw badRequest("Invalid year.");
    }
    return year;
  }
}
