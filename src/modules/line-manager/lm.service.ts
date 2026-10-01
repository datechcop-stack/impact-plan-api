import type { PrismaClient } from "@prisma/client";
import { applyTransition, isLineManagerFinalizeOpen } from "../../domain/lifecycle.js";
import { computePlanScore, roundDisplay } from "../../domain/scoring.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";

export class LineManagerService {
  constructor(private readonly db: PrismaClient) {}

  async listPeople(
    managerId: string,
    query: {
      status: "ALL" | "DRAFT" | "LOCKED" | "IN_REVIEW" | "FINALIZED";
      year?: number;
    },
  ) {
    const year = query.year ?? new Date().getFullYear();
    const reports = await this.db.user.findMany({
      where: { lineManagerId: managerId, status: { in: ["ACTIVE", "INVITED"] } },
      include: {
        ownedPlans: {
          where: { year },
          include: {
            components: {
              include: {
                entries: { include: { pmReview: true, selfAssessment: true } },
              },
            },
          },
        },
      },
      orderBy: { fullName: "asc" },
    });

    const items = reports.map((person) => {
      const plan = person.ownedPlans[0] ?? null;
      const entries = plan?.components.filter((c) => c.enabled).flatMap((c) => c.entries) ?? [];
      const pmReviewed = entries.filter((e) => e.pmReview?.status === "REVIEWED").length;
      const score = plan
        ? computePlanScore(
            plan.components.map((c) => ({
              type: c.type,
              weight: c.weight,
              enabled: c.enabled,
            })),
            entries
              .filter((e) => e.pmReview?.status === "REVIEWED" && e.pmReview.score != null)
              .map((e) => ({
                componentType: plan.components.find((c) =>
                  c.entries.some((entry) => entry.id === e.id),
                )!.type,
                score: e.pmReview!.score!,
              })),
          )
        : null;

      let uiStatus: "DRAFT" | "LOCKED" | "IN_REVIEW" | "FINALIZED" | "NONE";
      if (!plan) uiStatus = "NONE";
      else if (plan.status === "DRAFT") uiStatus = "DRAFT";
      else if (plan.status === "FINALIZED") uiStatus = "FINALIZED";
      else if (plan.status === "IN_REVIEW" || plan.status === "REVIEW_OPEN") uiStatus = "IN_REVIEW";
      else uiStatus = "LOCKED";

      return {
        id: person.id,
        fullName: person.fullName,
        jobTitle: person.jobTitle,
        planId: plan?.id ?? null,
        planStatus: plan?.status ?? null,
        uiStatus,
        selfAssessment:
          plan?.submittedAt != null
            ? `Submitted ${plan.submittedAt.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
            : "Not submitted",
        pmReviews: {
          done: pmReviewed,
          total: entries.length,
          ready: Boolean(
            plan &&
            plan.status === "IN_REVIEW" &&
            pmReviewed === entries.length &&
            entries.length > 0,
          ),
        },
        weightedScore:
          score?.isComplete && score.finalScore != null ? roundDisplay(score.finalScore) : null,
      };
    });

    const filtered =
      query.status === "ALL"
        ? items.filter((i) => i.uiStatus !== "NONE")
        : items.filter((i) => i.uiStatus === query.status);

    const counts = {
      all: items.filter((i) => i.uiStatus !== "NONE").length,
      draft: items.filter((i) => i.uiStatus === "DRAFT").length,
      locked: items.filter((i) => i.uiStatus === "LOCKED").length,
      inReview: items.filter((i) => i.uiStatus === "IN_REVIEW").length,
      finalized: items.filter((i) => i.uiStatus === "FINALIZED").length,
    };

    return {
      counts,
      yearEndProgress: {
        finalized: counts.finalized,
        total: counts.all,
      },
      items: filtered,
    };
  }

  async getPersonPlan(managerId: string, userId: string, year = new Date().getFullYear()) {
    const person = await this.db.user.findFirst({
      where: { id: userId, lineManagerId: managerId },
    });
    if (!person) {
      throw forbidden("Not your direct report.");
    }

    const plan = await this.db.plan.findUnique({
      where: { ownerId_year: { ownerId: userId, year } },
      include: {
        owner: {
          select: {
            id: true,
            fullName: true,
            jobTitle: true,
            lineManager: { select: { fullName: true } },
          },
        },
        components: {
          include: {
            entries: {
              include: {
                manager: { select: { id: true, fullName: true } },
                selfAssessment: true,
                pmReview: {
                  include: { reviewer: { select: { fullName: true } } },
                },
              },
              orderBy: { sortOrder: "asc" },
            },
          },
        },
      },
    });
    if (!plan) {
      throw notFound("Plan not found.");
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

    const entries = plan.components.filter((c) => c.enabled).flatMap((c) => c.entries);
    const pmDone = entries.filter((e) => e.pmReview?.status === "REVIEWED").length;

    return {
      plan,
      score,
      checklist: {
        selfAssessmentSubmitted: Boolean(plan.submittedAt),
        pmReviewed: pmDone === entries.length && entries.length > 0,
        pmDone,
        pmTotal: entries.length,
        commentAdded: Boolean(plan.lineManagerComment?.trim()),
      },
    };
  }

  async saveComment(managerId: string, userId: string, comment: string) {
    const data = await this.getPersonPlan(managerId, userId);
    if (!isLineManagerFinalizeOpen(data.plan.status)) {
      throw forbidden("Plan is not ready for line-manager comment.");
    }
    await this.db.plan.update({
      where: { id: data.plan.id },
      data: { lineManagerComment: comment },
    });
    return this.getPersonPlan(managerId, userId);
  }

  async finalize(managerId: string, userId: string, comment?: string) {
    const data = await this.getPersonPlan(managerId, userId);
    if (!isLineManagerFinalizeOpen(data.plan.status)) {
      throw forbidden("Plan cannot be finalized in its current state.");
    }
    const finalComment = (comment ?? data.plan.lineManagerComment ?? "").trim();
    if (!finalComment) {
      throw badRequest("An overall comment is required to finalize.");
    }
    if (!data.checklist.selfAssessmentSubmitted || !data.checklist.pmReviewed) {
      throw badRequest("Self-assessment and all PM reviews are required before finalizing.");
    }
    if (!data.score.isComplete || data.score.finalScore == null) {
      throw badRequest("Final score is incomplete.");
    }

    const next = applyTransition(data.plan.status, "FINALIZE");
    await this.db.$transaction([
      this.db.plan.update({
        where: { id: data.plan.id },
        data: {
          status: next,
          lineManagerComment: finalComment,
          finalizedAt: new Date(),
          finalScore: data.score.finalScore,
        },
      }),
      this.db.changeLog.create({
        data: {
          planId: data.plan.id,
          actorId: managerId,
          action: "PLAN_FINALIZED",
          metadata: { finalScore: data.score.finalScore },
        },
      }),
    ]);

    return this.getPersonPlan(managerId, userId);
  }

  async sendReminder(managerId: string, userId: string) {
    const person = await this.db.user.findFirst({
      where: { id: userId, lineManagerId: managerId },
    });
    if (!person) {
      throw forbidden("Not your direct report.");
    }
    await this.db.changeLog.create({
      data: {
        actorId: managerId,
        action: "LM_REMINDER_SENT",
        metadata: { userId },
      },
    });
    return { ok: true };
  }
}
