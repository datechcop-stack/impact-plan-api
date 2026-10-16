import type { PlanStatus } from "./lifecycle.js";

export type ReviewPurpose = "MIDYEAR_PLAN_UPDATE" | "YEAR_END_REVIEW";

/** Plans an admin (or the scheduler) can move into the active window. */
export function statusesEligibleToOpen(purpose: ReviewPurpose): PlanStatus[] {
  if (purpose === "MIDYEAR_PLAN_UPDATE") {
    return ["LOCKED", "PARTLY_UNLOCKED"];
  }
  return ["LOCKED", "PARTLY_UNLOCKED", "UNLOCKED"];
}
