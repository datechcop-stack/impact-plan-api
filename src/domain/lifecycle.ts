export type PlanStatus =
  "DRAFT" | "LOCKED" | "PARTLY_UNLOCKED" | "UNLOCKED" | "REVIEW_OPEN" | "IN_REVIEW" | "FINALIZED";

export type PlanTransition =
  | "SAVE_DRAFT"
  | "LOCK"
  | "UNLOCK_WHOLE"
  | "UNLOCK_COMPONENT"
  | "RELOCK"
  | "OPEN_REVIEW"
  | "SUBMIT_SELF_ASSESSMENT"
  | "FINALIZE";

const transitions: Record<PlanStatus, Partial<Record<PlanTransition, PlanStatus>>> = {
  DRAFT: {
    SAVE_DRAFT: "DRAFT",
    LOCK: "LOCKED",
  },
  LOCKED: {
    UNLOCK_WHOLE: "UNLOCKED",
    UNLOCK_COMPONENT: "PARTLY_UNLOCKED",
    OPEN_REVIEW: "REVIEW_OPEN",
  },
  PARTLY_UNLOCKED: {
    RELOCK: "LOCKED",
  },
  UNLOCKED: {
    RELOCK: "LOCKED",
  },
  REVIEW_OPEN: {
    SUBMIT_SELF_ASSESSMENT: "IN_REVIEW",
  },
  IN_REVIEW: {
    FINALIZE: "FINALIZED",
  },
  FINALIZED: {},
};

export class IllegalPlanTransitionError extends Error {
  constructor(
    public readonly from: PlanStatus,
    public readonly transition: PlanTransition,
  ) {
    super(`Illegal plan transition ${transition} from ${from}`);
    this.name = "IllegalPlanTransitionError";
  }
}

export function canTransition(from: PlanStatus, transition: PlanTransition): boolean {
  return Boolean(transitions[from][transition]);
}

export function applyTransition(from: PlanStatus, transition: PlanTransition): PlanStatus {
  const next = transitions[from][transition];
  if (!next) {
    throw new IllegalPlanTransitionError(from, transition);
  }
  return next;
}

export function isImmutable(status: PlanStatus): boolean {
  return status === "FINALIZED";
}

export function isOwnerEditable(status: PlanStatus): boolean {
  return status === "PARTLY_UNLOCKED" || status === "UNLOCKED";
}

export function isSelfAssessmentOpen(status: PlanStatus): boolean {
  return status === "REVIEW_OPEN";
}

export function isPmScoringOpen(status: PlanStatus): boolean {
  return status === "IN_REVIEW";
}

export function isLineManagerFinalizeOpen(status: PlanStatus): boolean {
  return status === "IN_REVIEW";
}
