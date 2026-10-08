import type { PrismaClient } from "@prisma/client";
import { isPmGoalReviewOpen, isPmScoringOpen } from "../../domain/lifecycle.js";
import { entryObjectivesInclude } from "../../domain/objectives.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";

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
      const submitted =
        Boolean(entry.component.plan.submittedAt) ||
        planStatus === "IN_REVIEW" ||
        planStatus === "FINALIZED";
      const reviewed = entry.pmReview?.status === "REVIEWED";
      let bucket: "AWAITING" | "NOT_SUBMITTED" | "REVIEWED" = "NOT_SUBMITTED";
      if (reviewed) bucket = "REVIEWED";
      else if (submitted || goalReview) bucket = "AWAITING";
      return { entry, bucket, submitted, reviewed };
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

    return {
      stats,
      groups: [...byOwner.values()].map((group) => ({
        owner: group.owner,
        submittedAt: group.submittedAt,
        awaiting: group.items.filter((i) => i.bucket === "AWAITING").length,
        reviewed: group.items.filter((i) => i.bucket === "REVIEWED").length,
        notSubmitted: group.items.every((i) => i.bucket === "NOT_SUBMITTED"),
        entries: group.items.map((i) => ({
          id: i.entry.id,
          title: i.entry.title,
          componentType: i.entry.component.type,
          weight: i.entry.component.weight,
          status: i.bucket,
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
    const awaiting = ownerEntries.filter(
      (item) =>
        (item.component.plan.status === "IN_REVIEW" ||
          item.component.plan.status === "FINALIZED") &&
        item.pmReview?.status !== "REVIEWED",
    );
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
    input: { score?: number; comment: string },
  ) {
    const entry = await this.requireTaggedEntry(reviewerId, entryId);
    this.assertReviewAllowed(entry);
    if (!input.comment.trim()) {
      throw badRequest("A PM comment is required.");
    }
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
        status: "REVIEWED",
        reviewedAt: new Date(),
      },
      update: {
        score,
        comment: input.comment,
        status: "REVIEWED",
        reviewedAt: new Date(),
        reviewerId,
      },
    });
    await this.db.changeLog.create({
      data: {
        planId: entry.component.planId,
        actorId: reviewerId,
        action: "PM_REVIEWED_ENTRY",
        metadata: { entryId, score, goalPhase },
      },
    });
    return this.getEntry(reviewerId, entryId);
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
