import type { PrismaClient } from "@prisma/client";
import { applyTransition } from "../../domain/lifecycle.js";
import { statusesEligibleToOpen, type ReviewPurpose } from "../../domain/review-window.js";
import { badRequest, notFound } from "../../lib/errors.js";
import type { Mailer } from "../emails/mailer.js";
import {
  emailDistinct,
  firstName,
  reviewStepEmailHtml,
  reviewWindowOpenedEmailHtml,
  sendMail,
} from "../emails/mailer.js";

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

    const purpose = cycle.purpose as ReviewPurpose;
    const midyear = purpose === "MIDYEAR_PLAN_UPDATE";
    const ownerFilter =
      cycle.audience === "SELECTED"
        ? { ownerId: { in: cycle.participants.map((participant) => participant.userId) } }
        : {};
    const eligible = statusesEligibleToOpen(purpose);

    const [plans, alreadyOpen, skipped] = await Promise.all([
      this.db.plan.findMany({
        where: { year, status: { in: eligible }, ...ownerFilter },
        include: {
          owner: {
            select: {
              id: true,
              fullName: true,
              email: true,
              lineManager: { select: { id: true, fullName: true, email: true } },
            },
          },
          components: {
            where: { enabled: true },
            include: {
              entries: {
                include: { manager: { select: { id: true, fullName: true, email: true } } },
              },
            },
          },
        },
      }),
      this.db.plan.count({
        where: {
          year,
          ...ownerFilter,
          status: midyear ? "UNLOCKED" : { in: ["REVIEW_OPEN", "IN_REVIEW"] },
        },
      }),
      this.db.plan.count({
        where: { year, ...ownerFilter, status: { in: ["DRAFT", "FINALIZED"] } },
      }),
    ]);

    await this.db.$transaction(async (tx) => {
      for (const plan of plans) {
        const next = applyTransition(plan.status, midyear ? "UNLOCK_WHOLE" : "OPEN_REVIEW");
        await tx.plan.update({ where: { id: plan.id }, data: { status: next } });
        await tx.planComponent.updateMany({
          where: { planId: plan.id, enabled: true },
          data: { lockState: "UNLOCKED" },
        });
        await tx.changeLog.create({
          data: {
            planId: plan.id,
            actorId,
            action: midyear ? "MIDYEAR_REVIEW_OPENED" : "REVIEW_WINDOW_OPENED",
            metadata: { purpose },
          },
        });
      }
      await tx.reviewCycle.update({
        where: { id: cycle.id },
        data: { status: "OPEN" },
      });
    });

    const notified = { staff: 0, projectManagers: 0, lineManagers: 0 };
    if (mailer && cycle.remindOnOpen && plans.length > 0) {
      const deadline = cycle.selfAssessmentDeadline.toISOString().slice(0, 10);
      const windowLabel = midyear
        ? "Mid-year plan update window"
        : "Year-end self-assessment window";
      notified.staff = await emailDistinct(
        mailer,
        plans.map((plan) => plan.owner),
        (owner) => {
          const html = reviewWindowOpenedEmailHtml({
            firstName: firstName(owner.fullName),
            year,
            windowLabel,
            deadline,
          });
          return {
            subject: `${windowLabel} · Impact Plan ${year}`,
            html,
            text: `${windowLabel} for ${year} is now open. Sign in to Impact Plan to continue.`,
          };
        },
      );

      if (!midyear) {
        const projectManagers = plans.flatMap((plan) =>
          plan.components.flatMap((component) => component.entries.map((entry) => entry.manager)),
        );
        const lineManagers = plans.flatMap((plan) =>
          plan.owner.lineManager ? [plan.owner.lineManager] : [],
        );
        const pmDeadline = cycle.pmScoringDeadline.toISOString().slice(0, 10);
        const finalizeDeadline = cycle.finalizeDeadline.toISOString().slice(0, 10);
        notified.projectManagers = await emailDistinct(mailer, projectManagers, (manager) => ({
          subject: `Year-end scoring · Impact Plan ${year}`,
          html: reviewStepEmailHtml({
            firstName: firstName(manager.fullName),
            heading: "Year-end scoring is open",
            paragraphs: [
              `Your administrator opened the ${year} year-end review.`,
              `Score each entry where you are the tagged manager after that person submits their self-assessment. Scoring is due ${pmDeadline}.`,
            ],
          }),
          text: `Year-end scoring for Impact Plan ${year} opens after each person submits their self-assessment. Due ${pmDeadline}.`,
        }));
        notified.lineManagers = await emailDistinct(mailer, lineManagers, (manager) => ({
          subject: `Year-end final review · Impact Plan ${year}`,
          html: reviewStepEmailHtml({
            firstName: firstName(manager.fullName),
            heading: "Year-end final review is open",
            paragraphs: [
              `Your administrator opened the ${year} year-end review for your direct reports.`,
              `After someone submits their self-assessment and every tagged manager has scored their entries, add your overall comment and finalize the plan. Final review is due ${finalizeDeadline}.`,
            ],
          }),
          text: `Year-end final review for Impact Plan ${year} is open. Finalize each report after self-assessment and project manager scores. Due ${finalizeDeadline}.`,
        }));
      }
    }

    return {
      opened: plans.length,
      alreadyOpen,
      skipped,
      purpose,
      notified,
    };
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
