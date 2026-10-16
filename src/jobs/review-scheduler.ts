import type { PrismaClient } from "@prisma/client";
import { isPmScoreComplete } from "../domain/lifecycle.js";
import type { Env } from "../env.js";
import { firstName, reviewStepEmailHtml, sendMail, type Mailer } from "../modules/emails/mailer.js";
import { ReviewCycleService } from "../modules/review-cycle/review-cycle.service.js";

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysUntil(target: Date, now: Date): number {
  const ms = startOfDay(target).getTime() - startOfDay(now).getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

export class ReviewScheduler {
  constructor(
    private readonly db: PrismaClient,
    _env: Env,
    private readonly mailer: Mailer,
  ) {}

  async runDaily(now = new Date()): Promise<{ opened: number; reminders: number }> {
    let opened = 0;
    let reminders = 0;

    const cycles = await this.db.reviewCycle.findMany({
      where: { status: { in: ["SCHEDULED", "OPEN"] } },
      include: { participants: true },
    });

    for (const cycle of cycles) {
      if (cycle.status === "SCHEDULED" && daysUntil(cycle.windowOpens, now) <= 0) {
        const actor = await this.db.user.findFirst({
          where: { role: "ADMIN" },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });
        if (actor) {
          const result = await new ReviewCycleService(this.db).openNow(
            actor.id,
            cycle.year,
            this.mailer,
          );
          opened += result.opened;
          reminders +=
            result.notified.staff + result.notified.projectManagers + result.notified.lineManagers;
        }
      }

      if (cycle.remindBeforeDeadlines) {
        for (const [kind, deadline] of [
          ["SELF_ASSESSMENT", cycle.selfAssessmentDeadline],
          ["PM_SCORING", cycle.pmScoringDeadline],
          ["FINALIZE", cycle.finalizeDeadline],
        ] as const) {
          if (daysUntil(deadline, now) === 3) {
            const already = await this.db.reminderLog.findFirst({
              where: { reviewCycleId: cycle.id, kind: `DEADLINE_${kind}` },
            });
            if (!already) {
              reminders += await this.emailDeadlineReminder(cycle.year, cycle.purpose, kind);
              await this.db.reminderLog.create({
                data: { reviewCycleId: cycle.id, kind: `DEADLINE_${kind}` },
              });
            }
          }
        }
      }

      if (cycle.weeklyLmSummary && now.getUTCDay() === 1 && cycle.purpose === "YEAR_END_REVIEW") {
        const kind = `WEEKLY_LM_${startOfDay(now).toISOString().slice(0, 10)}`;
        const already = await this.db.reminderLog.findFirst({
          where: { reviewCycleId: cycle.id, kind },
        });
        if (!already) {
          reminders += await this.emailWeeklyLineManagerSummary(cycle.year);
          await this.db.reminderLog.create({
            data: { reviewCycleId: cycle.id, kind },
          });
        }
      }
    }

    return { opened, reminders };
  }

  private async emailDeadlineReminder(
    year: number,
    purpose: "MIDYEAR_PLAN_UPDATE" | "YEAR_END_REVIEW",
    kind: "SELF_ASSESSMENT" | "PM_SCORING" | "FINALIZE",
  ): Promise<number> {
    if (kind === "SELF_ASSESSMENT") {
      const plans = await this.db.plan.findMany({
        where: {
          year,
          status:
            purpose === "MIDYEAR_PLAN_UPDATE"
              ? { in: ["UNLOCKED", "PARTLY_UNLOCKED"] }
              : "REVIEW_OPEN",
        },
        include: { owner: true },
      });
      for (const plan of plans) {
        const subject =
          purpose === "MIDYEAR_PLAN_UPDATE"
            ? `Reminder: mid-year plan update deadline in 3 days`
            : `Reminder: self-assessment deadline in 3 days`;
        await sendMail(this.mailer, {
          to: plan.owner.email,
          subject: `${subject} (${year})`,
          html: reviewStepEmailHtml({
            firstName: firstName(plan.owner.fullName),
            heading: subject,
            paragraphs: [
              purpose === "MIDYEAR_PLAN_UPDATE"
                ? `Update your Impact Plan for ${year} and save your changes before the deadline.`
                : `Complete your self-assessment for every entry and submit your Impact Plan for ${year}.`,
            ],
          }),
          text: `${subject} for Impact Plan ${year}.`,
        });
      }
      return plans.length;
    }

    if (kind === "PM_SCORING") {
      const entries = await this.db.planEntry.findMany({
        where: {
          component: {
            enabled: true,
            plan: { year, status: "IN_REVIEW", submittedAt: { not: null } },
          },
        },
        include: { pmReview: true, manager: true },
      });
      const pending = new Map<string, { fullName: string; email: string }>();
      for (const entry of entries) {
        if (!isPmScoreComplete(entry.pmReview)) {
          pending.set(entry.manager.id, entry.manager);
        }
      }
      const subject = `Reminder: PM scoring deadline in 3 days`;
      for (const manager of pending.values()) {
        await sendMail(this.mailer, {
          to: manager.email,
          subject: `${subject} (${year})`,
          html: reviewStepEmailHtml({
            firstName: firstName(manager.fullName),
            heading: subject,
            paragraphs: [
              `Score the Impact Plan ${year} entries waiting on you. Each score needs a comment.`,
            ],
          }),
          text: `${subject} for Impact Plan ${year}.`,
        });
      }
      return pending.size;
    }

    const plans = await this.db.plan.findMany({
      where: { year, status: "IN_REVIEW" },
      include: { owner: { include: { lineManager: true } } },
    });
    const managers = new Map<string, { fullName: string; email: string }>();
    for (const plan of plans) {
      if (plan.owner.lineManager) {
        managers.set(plan.owner.lineManager.id, plan.owner.lineManager);
      }
    }
    const subject = `Reminder: line manager finalize deadline in 3 days`;
    for (const manager of managers.values()) {
      await sendMail(this.mailer, {
        to: manager.email,
        subject: `${subject} (${year})`,
        html: reviewStepEmailHtml({
          firstName: firstName(manager.fullName),
          heading: subject,
          paragraphs: [
            `Finalize Impact Plan ${year} for each direct report once their self-assessment is submitted and every entry has a project manager score.`,
          ],
        }),
        text: `${subject} for Impact Plan ${year}.`,
      });
    }
    return managers.size;
  }

  private async emailWeeklyLineManagerSummary(year: number): Promise<number> {
    const plans = await this.db.plan.findMany({
      where: { year, status: { in: ["REVIEW_OPEN", "IN_REVIEW"] } },
      include: {
        owner: { include: { lineManager: true } },
        components: {
          where: { enabled: true },
          include: { entries: { include: { pmReview: true } } },
        },
      },
    });
    const byManager = new Map<
      string,
      { fullName: string; email: string; selfAssessment: number; scoring: number; ready: number }
    >();
    for (const plan of plans) {
      const manager = plan.owner.lineManager;
      if (!manager) continue;
      const row = byManager.get(manager.id) ?? {
        fullName: manager.fullName,
        email: manager.email,
        selfAssessment: 0,
        scoring: 0,
        ready: 0,
      };
      if (plan.status === "REVIEW_OPEN") row.selfAssessment += 1;
      else {
        const entries = plan.components.flatMap((component) => component.entries);
        const ready =
          entries.length > 0 && entries.every((entry) => isPmScoreComplete(entry.pmReview));
        if (ready) row.ready += 1;
        else row.scoring += 1;
      }
      byManager.set(manager.id, row);
    }
    for (const manager of byManager.values()) {
      await sendMail(this.mailer, {
        to: manager.email,
        subject: `Year-end review summary · Impact Plan ${year}`,
        html: reviewStepEmailHtml({
          firstName: firstName(manager.fullName),
          heading: `Year-end progress for ${year}`,
          paragraphs: [
            `${manager.selfAssessment} report(s) are still in self-assessment, ${manager.scoring} are waiting on project manager scores, and ${manager.ready} are ready for your final review.`,
          ],
        }),
        text: `Self-assessment ${manager.selfAssessment}, PM scoring ${manager.scoring}, ready to finalize ${manager.ready}.`,
      });
    }
    return byManager.size;
  }
}
