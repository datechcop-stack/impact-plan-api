import type { PrismaClient } from "@prisma/client";
import { applyTransition } from "../../domain/lifecycle.js";
import { statusesEligibleToOpen } from "../../domain/review-window.js";

/**
 * If the year-end window is already open, a newly locked plan joins self-assessment
 * instead of waiting for the admin to open the window again.
 */
export async function enrollPlanInOpenYearEndWindow(
  db: PrismaClient,
  planId: string,
  actorId: string,
): Promise<boolean> {
  const plan = await db.plan.findUnique({ where: { id: planId } });
  if (!plan) return false;

  const cycle = await db.reviewCycle.findUnique({
    where: { year: plan.year },
    include: { participants: { select: { userId: true } } },
  });
  if (!cycle || cycle.status !== "OPEN" || cycle.purpose !== "YEAR_END_REVIEW") {
    return false;
  }
  if (
    cycle.audience === "SELECTED" &&
    !cycle.participants.some((participant) => participant.userId === plan.ownerId)
  ) {
    return false;
  }
  if (!statusesEligibleToOpen(cycle.purpose).includes(plan.status)) {
    return false;
  }

  const next = applyTransition(plan.status, "OPEN_REVIEW");
  await db.$transaction([
    db.plan.update({ where: { id: plan.id }, data: { status: next } }),
    db.planComponent.updateMany({
      where: { planId: plan.id, enabled: true },
      data: { lockState: "UNLOCKED" },
    }),
    db.changeLog.create({
      data: {
        planId: plan.id,
        actorId,
        action: "REVIEW_WINDOW_OPENED",
        metadata: { purpose: cycle.purpose, enrolledAfterLock: true },
      },
    }),
  ]);
  return true;
}
