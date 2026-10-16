import type { PrismaClient } from "@prisma/client";
import { isPmGoalReviewOpen, isPmScoreComplete, isPmScoringOpen } from "../../domain/lifecycle.js";
import { entryObjectivesInclude } from "../../domain/objectives.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import type { Mailer } from "../emails/mailer.js";
import { emailDistinct, firstName, reviewStepEmailHtml } from "../emails/mailer.js";

export class PmService {
  constructor(private readonly db: PrismaClient) {}

  async list(
    reviewerId: string,
    query: {
      q?: string;
      component: "PROJECTS" | "BD" | "TECH_PERSONAL" | "COP" | "ALL";
      status: "ALL" | "AWAITING" | "NOT_SUBMITTED" | "REVIEWED";
      year?: number;
    },
  ) {
    const year = query.year ?? new Date().getFullYear();
    const entries = await this.db.planEntry.findMany({
      where: {
        managerId: reviewerId,
        component: {
          enabled: true,
          ...(query.component !== "ALL" ? { type: query.component } : {}),
          plan: { year },
        },
        ...(query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: "insensitive" } },
                {
                  component: {
                    plan: {
                      owner: {
                        OR: [
                          { fullName: { contains: query.q, mode: "insensitive" } },
                          { email: { contains: query.q, mode: "insensitive" } },
                        ],
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        manager: { select: { id: true, fullName: true } },
        selfAssessment: true,
        pmReview: true,
        component: {
          include: {
            plan: {
              include: {
                owner: {
                  select: { id: true, fullName: true, jobTitle: true, email: true },
                },
              },
            },
          },
        },
      },
      orderBy: [{ component: { plan: { owner: { fullName: "asc" } } } }, { sortOrder: "asc" }],
    });

    const decorated = entries.map((entry) => {
      const planStatus = entry.component.plan.status;
      const goalReview = isPmGoalReviewOpen(planStatus as never);
      const scoringReview = isPmScoringOpen(planStatus as never) || planStatus === "FINALIZED";
      const selfAssessmentSubmitted = Boolean(entry.component.plan.submittedAt);
      const scored = isPmScoreComplete(entry.pmReview);
      const goalReviewed = entry.pmReview?.status === "REVIEWED";
      const revisionOpen = Boolean(entry.component.plan.revisionOpen) && planStatus === "IN_REVIEW";
      let bucket: "AWAITING" | "NOT_SUBMITTED" | "REVIEWED" = "NOT_SUBMITTED";
      let reviewPhase: "GOAL" | "SCORING" | null = null;
      if (scoringReview && (selfAssessmentSubmitted || planStatus === "FINALIZED")) {
        reviewPhase = "SCORING";
        bucket = revisionOpen || !scored ? "AWAITING" : "REVIEWED";
      } else if (goalReview) {
        reviewPhase = "GOAL";
        bucket = goalReviewed ? "REVIEWED" : "AWAITING";
      }
      return { entry, bucket, reviewPhase, reviewed: bucket === "REVIEWED" };
    });

    const filtered =
      query.status === "ALL" ? decorated : decorated.filter((item) => item.bucket === query.status);

    const stats = {
      tagged: decorated.length,
      awaiting: decorated.filter((i) => i.bucket === "AWAITING").length,
      notSubmitted: decorated.filter((i) => i.bucket === "NOT_SUBMITTED").length,
      reviewed: decorated.filter((i) => i.bucket === "REVIEWED").length,
    };

    const byOwner = new Map<
      string,
      {
        owner: (typeof entries)[number]["component"]["plan"]["owner"];
        submittedAt: string | null;
        items: typeof filtered;
      }
    >();

    for (const item of filtered) {
      const owner = item.entry.component.plan.owner;
      const group = byOwner.get(owner.id) ?? {
        owner,
        submittedAt: item.entry.component.plan.submittedAt?.toISOString() ?? null,
        items: [],
      };
      group.items.push(item);
      byOwner.set(owner.id, group);
    }

    const reviewCycle = await this.db.reviewCycle.findUnique({
      where: { year },
      select: {
        status: true,
        purpose: true,
        selfAssessmentDeadline: true,
        pmScoringDeadline: true,
        finalizeDeadline: true,
      },
    });

    return {
      reviewCycle,
      stats,
      groups: [...byOwner.values()].map((group) => ({
        owner: group.owner,
        submittedAt: group.submittedAt,
        awaiting: group.items.filter((i) => i.bucket === "AWAITING").length,
        reviewed: group.items.filter((i) => i.bucket === "REVIEWED").length,
        notSubmitted: group.items.every((i) => i.bucket === "NOT_SUBMITTED"),
        planStatus: group.items[0]?.entry.component.plan.status ?? "DRAFT",
        revisionOpen: Boolean(group.items[0]?.entry.component.plan.revisionOpen),
        entries: group.items.map((i) => ({
          id: i.entry.id,
          title: i.entry.title,
          componentType: i.entry.component.type,
          weight: i.entry.component.weight,
          status: i.bucket,
          reviewPhase: i.reviewPhase,
          score: i.entry.pmReview?.score ?? null,
          dueDate: i.entry.dueDate.toISOString().slice(0, 10),
        })),
      })),
    };
  }

  async getEntry(reviewerId: string, entryId: string) {
    const entry = await this.requireTaggedEntry(reviewerId, entryId);
    const ownerEntries = await this.db.planEntry.findMany({
      where: {
        managerId: reviewerId,
        component: {
          planId: entry.component.planId,
          enabled: true,
        },
      },
      include: {
        pmReview: true,
        component: { include: { plan: true } },
      },
      orderBy: { sortOrder: "asc" },
    });
    const awaiting = ownerEntries.filter((item) => {
      const status = item.component.plan.status as never;
      if (isPmGoalReviewOpen(status)) return item.pmReview?.status !== "REVIEWED";
      if (
        isPmScoringOpen(status) &&
        item.component.plan.revisionOpen &&
        Boolean(item.component.plan.submittedAt)
      ) {
        return true;
      }
      if (
        (isPmScoringOpen(status) || status === "FINALIZED") &&
        Boolean(item.component.plan.submittedAt)
      ) {
        return !isPmScoreComplete(item.pmReview);
      }
      return false;
    });
    return {
      entry: {
        id: entry.id,
        title: entry.title,
        objectives: entry.objectives,
        dueDate: entry.dueDate.toISOString().slice(0, 10),
        componentType: entry.component.type,
        weight: entry.component.weight,
        owner: entry.component.plan.owner,
        planStatus: entry.component.plan.status,
        revisionOpen: entry.component.plan.revisionOpen,
        submittedAt: entry.component.plan.submittedAt?.toISOString() ?? null,
        selfAssessment: entry.selfAssessment,
        pmReview: entry.pmReview,
      },
      queue: {
        awaitingCount: awaiting.length,
        awaitingIds: awaiting.map((item) => item.id),
      },
    };
  }

  async saveDraft(reviewerId: string, entryId: string, input: { score?: number; comment: string }) {
    const entry = await this.requireTaggedEntry(reviewerId, entryId);
    this.assertReviewAllowed(entry);
    const goalPhase = isPmGoalReviewOpen(entry.component.plan.status as never);
    const score = goalPhase ? null : (input.score ?? null);
    if (!goalPhase && score == null) {
      throw badRequest("A score is required during year-end PM scoring.");
    }
    await this.db.pmReview.upsert({
      where: { entryId },
      create: {
        entryId,
        reviewerId,
        score,
        comment: input.comment,
        status: "DRAFT",
      },
      update: {
        score,
        comment: input.comment,
        status: "DRAFT",
        reviewerId,
      },
    });
    return this.getEntry(reviewerId, entryId);
  }

  async markReviewed(
    reviewerId: string,
    entryId: string,
    input: { score?: number; comment: string; decision?: "ACCEPT" | "REJECT" },
    mailer?: Mailer,
  ) {
    const entry = await this.requireTaggedEntry(reviewerId, entryId);
    this.assertReviewAllowed(entry);
    const goalPhase = isPmGoalReviewOpen(entry.component.plan.status as never);
    const wasComplete = goalPhase ? true : await this.planScoringComplete(entry.component.planId);
    const comment = input.comment.trim();
    if (goalPhase) {
      const decision = input.decision ?? "ACCEPT";
      if (decision === "REJECT" && !comment) {
        throw badRequest("Add a comment explaining what needs to change before rejecting.");
      }
    } else if (!comment) {
      throw badRequest("A PM comment is required.");
    }
    const score = goalPhase ? null : (input.score ?? null);
    if (!goalPhase && score == null) {
      throw badRequest("A score is required during year-end PM scoring.");
    }
    await this.db.pmReview.upsert({
      where: { entryId },
      create: {
        entryId,
        reviewerId,
        score,
        comment,
        status: "REVIEWED",
        reviewedAt: new Date(),
      },
      update: {
        score,
        comment,
        status: "REVIEWED",
        reviewedAt: new Date(),
        reviewerId,
      },
    });
    await this.db.changeLog.create({
      data: {
        planId: entry.component.planId,
        actorId: reviewerId,
        action: goalPhase
          ? input.decision === "REJECT"
            ? "PM_GOALS_REJECTED"
            : "PM_GOALS_ACCEPTED"
          : "PM_REVIEWED_ENTRY",
        metadata: { entryId, score, goalPhase, decision: input.decision ?? null },
      },
    });
    if (
      mailer &&
      !goalPhase &&
      !wasComplete &&
      (await this.planScoringComplete(entry.component.planId))
    ) {
      await this.notifyLineManagerReady(
        entry.component.plan.owner.id,
        entry.component.plan.year,
        mailer,
      );
    }
    return this.getEntry(reviewerId, entryId);
  }

  private async planScoringComplete(planId: string): Promise<boolean> {
    const entries = await this.db.planEntry.findMany({
      where: { component: { planId, enabled: true } },
      include: { pmReview: true },
    });
    return entries.length > 0 && entries.every((entry) => isPmScoreComplete(entry.pmReview));
  }

  private async notifyLineManagerReady(ownerId: string, year: number, mailer: Mailer) {
    const owner = await this.db.user.findUnique({
      where: { id: ownerId },
      select: {
        fullName: true,
        lineManager: { select: { fullName: true, email: true } },
      },
    });
    if (!owner?.lineManager) return;
    const manager = owner.lineManager;
    await emailDistinct(mailer, [manager], () => ({
      subject: `${owner.fullName} is ready for final review · Impact Plan ${year}`,
      html: reviewStepEmailHtml({
        firstName: firstName(manager.fullName),
        heading: "Final review is ready",
        paragraphs: [
          `Every entry on ${owner.fullName}'s Impact Plan ${year} now has a project manager score.`,
          "Sign in to add your overall comment and finalize the plan.",
        ],
      }),
      text: `${owner.fullName}'s Impact Plan ${year} is ready for your final review.`,
    }));
  }

  private assertReviewAllowed(entry: {
    component: { plan: { status: string; submittedAt: Date | null } };
  }) {
    const status = entry.component.plan.status as never;
    if (isPmScoringOpen(status) || isPmGoalReviewOpen(status)) {
      return;
    }
    throw forbidden("PM review is not open for this plan yet.");
  }

  private async requireTaggedEntry(reviewerId: string, entryId: string) {
    const entry = await this.db.planEntry.findUnique({
      where: { id: entryId },
      include: {
        selfAssessment: true,
        pmReview: true,
        ...entryObjectivesInclude,
        component: {
          include: {
            plan: {
              include: {
                owner: {
                  select: { id: true, fullName: true, jobTitle: true, email: true },
                },
              },
            },
          },
        },
      },
    });
    if (!entry || entry.managerId !== reviewerId) {
      throw notFound("Entry not found.");
    }
    return entry;
  }
}
