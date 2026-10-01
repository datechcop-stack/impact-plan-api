import type { PrismaClient } from "@prisma/client";
import type { Transporter } from "nodemailer";
import { applyTransition } from "../domain/lifecycle.js";
import type { Env } from "../env.js";
import { sendMail } from "../modules/emails/mailer.js";

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
    private readonly env: Env,
    private readonly mailer: Transporter,
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
        opened += await this.openCycle(
          cycle.id,
          cycle.year,
          cycle.audience,
          cycle.participants.map((p) => p.userId),
        );
        if (cycle.remindOnOpen) {
          reminders += await this.emailStaffOnOpen(cycle.year);
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
              reminders += await this.emailDeadlineReminder(cycle.year, kind);
              await this.db.reminderLog.create({
                data: { reviewCycleId: cycle.id, kind: `DEADLINE_${kind}` },
              });
            }
          }
        }
      }
    }

    return { opened, reminders };
  }

  private async openCycle(
    cycleId: string,
    year: number,
    audience: "ALL_WITH_PLAN" | "SELECTED",
    participantIds: string[],
  ): Promise<number> {
    const plans = await this.db.plan.findMany({
      where:
        audience === "SELECTED"
          ? { year, status: "LOCKED", ownerId: { in: participantIds } }
          : { year, status: "LOCKED" },
    });

    await this.db.$transaction(async (tx) => {
      for (const plan of plans) {
        await tx.plan.update({
          where: { id: plan.id },
          data: { status: applyTransition(plan.status, "OPEN_REVIEW") },
        });
        await tx.changeLog.create({
          data: {
            planId: plan.id,
            actorId: plan.createdById,
            action: "REVIEW_WINDOW_OPENED_BY_SCHEDULER",
          },
        });
      }
      await tx.reviewCycle.update({
        where: { id: cycleId },
        data: { status: "OPEN" },
      });
    });

    return plans.length;
  }

  private async emailStaffOnOpen(year: number): Promise<number> {
    const plans = await this.db.plan.findMany({
      where: { year, status: "REVIEW_OPEN" },
      include: { owner: true },
    });
    for (const plan of plans) {
      await sendMail(this.mailer, this.env, {
        to: plan.owner.email,
        subject: `Your ${year} Impact Plan review window is open`,
        html: `<p>Hi ${plan.owner.fullName.split(" ")[0]},</p><p>Your self-assessment window is open. Please complete every entry and submit your plan.</p>`,
        text: `Your ${year} Impact Plan review window is open.`,
      });
    }
    return plans.length;
  }

  private async emailDeadlineReminder(
    year: number,
    kind: "SELF_ASSESSMENT" | "PM_SCORING" | "FINALIZE",
  ): Promise<number> {
    const subject =
      kind === "SELF_ASSESSMENT"
        ? `Reminder: self-assessment deadline in 3 days`
        : kind === "PM_SCORING"
          ? `Reminder: PM scoring deadline in 3 days`
          : `Reminder: line manager finalize deadline in 3 days`;

    const users = await this.db.user.findMany({
      where: { status: "ACTIVE", role: "STAFF" },
      take: 200,
    });
    for (const user of users) {
      await sendMail(this.mailer, this.env, {
        to: user.email,
        subject: `${subject} (${year})`,
        html: `<p>Hi ${user.fullName.split(" ")[0]},</p><p>${subject} for Impact Plan ${year}.</p>`,
        text: `${subject} for Impact Plan ${year}.`,
      });
    }
    return users.length;
  }
}
