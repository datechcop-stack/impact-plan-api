import type { Prisma } from "@prisma/client";
import { entryObjectivesInclude } from "../../domain/objectives.js";

type Tx = Prisma.TransactionClient;

/** Snapshot + delete runs many queries; allow more than Prisma's 5s default. */
export const ARCHIVE_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export type ArchiveReason = "USER_REMOVED" | "USER_INVITE_REVOKED" | "PLAN_DELETED";

/** Everything that belongs to a plan, so the archived copy is complete. */
const planSnapshotInclude = {
  owner: { select: { id: true, email: true, fullName: true, jobTitle: true } },
  createdBy: { select: { id: true, email: true, fullName: true } },
  components: {
    include: {
      entries: {
        include: {
          manager: { select: { id: true, email: true, fullName: true } },
          selfAssessment: true,
          pmReview: {
            include: { reviewer: { select: { id: true, email: true, fullName: true } } },
          },
          ...entryObjectivesInclude,
        },
        orderBy: { sortOrder: "asc" as const },
      },
    },
  },
  editRequests: true,
  changeLogs: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.PlanInclude;

/** Dates become ISO strings and Decimals become strings, so the snapshot is valid JSON. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function actorSummary(tx: Tx, actorId: string) {
  const actor = await tx.user.findUnique({
    where: { id: actorId },
    select: { fullName: true, email: true },
  });
  return actor ? `${actor.fullName} <${actor.email}>` : null;
}

/** Snapshot a plan into DeletedRecord. Call inside the transaction that deletes it. */
export async function archivePlan(tx: Tx, actorId: string, planId: string, reason: ArchiveReason) {
  const plan = await tx.plan.findUnique({ where: { id: planId }, include: planSnapshotInclude });
  if (!plan) return null;

  return tx.deletedRecord.create({
    data: {
      entityType: "PLAN",
      entityId: plan.id,
      label: `${plan.owner.fullName} · ${plan.year}`,
      reason,
      data: toJson({ archiveVersion: 1, plan }),
      deletedById: actorId,
      deletedByName: await actorSummary(tx, actorId),
    },
  });
}

/**
 * Snapshot a user, their owned plans, and every link that will be cleared or reassigned
 * when the live rows are removed. Call inside the transaction that deletes them.
 */
export async function archiveUser(tx: Tx, actorId: string, userId: string, reason: ArchiveReason) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      jobTitle: true,
      role: true,
      authMethod: true,
      status: true,
      lineManagerId: true,
      lineManager: { select: { id: true, email: true, fullName: true } },
      planComponentTemplate: true,
      activatedAt: true,
      createdAt: true,
      updatedAt: true,
      invitation: {
        select: {
          expiresAt: true,
          usedAt: true,
          remindCreatePlan: true,
          invitedById: true,
          createdAt: true,
        },
      },
      reports: { select: { id: true, email: true, fullName: true } },
      ownedPlans: { include: planSnapshotInclude },
      createdPlans: { where: { ownerId: { not: userId } }, select: { id: true } },
      managedEntries: {
        where: { component: { plan: { ownerId: { not: userId } } } },
        select: { id: true, title: true, component: { select: { planId: true } } },
      },
      pmReviews: {
        where: { entry: { component: { plan: { ownerId: { not: userId } } } } },
      },
      editRequests: { where: { plan: { ownerId: { not: userId } } } },
      editDecisions: { select: { id: true, planId: true } },
      changeLogs: { orderBy: { createdAt: "asc" } },
      invitationsSent: { select: { id: true, userId: true } },
      reviewCycleParticipants: { select: { reviewCycleId: true } },
    },
  });
  if (!user) return null;

  return tx.deletedRecord.create({
    data: {
      entityType: "USER",
      entityId: user.id,
      label: `${user.fullName} <${user.email}>`,
      reason,
      data: toJson({ archiveVersion: 1, user, reassignedTo: actorId }),
      deletedById: actorId,
      deletedByName: await actorSummary(tx, actorId),
    },
  });
}
