import { describe, expect, it } from "vitest";
import {
  applyTransition,
  canTransition,
  IllegalPlanTransitionError,
  isImmutable,
  isOwnerEditable,
  isPmScoreComplete,
} from "../../src/domain/lifecycle.js";
import { statusesEligibleToOpen } from "../../src/domain/review-window.js";

describe("plan lifecycle", () => {
  it("allows DRAFT -> LOCKED -> REVIEW_OPEN -> IN_REVIEW -> FINALIZED", () => {
    let status = applyTransition("DRAFT", "LOCK");
    expect(status).toBe("LOCKED");
    status = applyTransition(status, "OPEN_REVIEW");
    expect(status).toBe("REVIEW_OPEN");
    status = applyTransition(status, "SUBMIT_SELF_ASSESSMENT");
    expect(status).toBe("IN_REVIEW");
    status = applyTransition(status, "FINALIZE");
    expect(status).toBe("FINALIZED");
    expect(isImmutable(status)).toBe(true);
  });

  it("supports component unlock and relock", () => {
    expect(canTransition("LOCKED", "UNLOCK_COMPONENT")).toBe(true);
    const unlocked = applyTransition("LOCKED", "UNLOCK_COMPONENT");
    expect(unlocked).toBe("PARTLY_UNLOCKED");
    expect(isOwnerEditable(unlocked)).toBe(true);
    expect(applyTransition(unlocked, "RELOCK")).toBe("LOCKED");
  });

  it("rejects illegal transitions", () => {
    expect(() => applyTransition("FINALIZED", "LOCK")).toThrow(IllegalPlanTransitionError);
    expect(canTransition("DRAFT", "FINALIZE")).toBe(false);
  });

  it("opens year-end review from locked and unlocked plans", () => {
    expect(applyTransition("UNLOCKED", "OPEN_REVIEW")).toBe("REVIEW_OPEN");
    expect(applyTransition("PARTLY_UNLOCKED", "OPEN_REVIEW")).toBe("REVIEW_OPEN");
    expect(applyTransition("PARTLY_UNLOCKED", "UNLOCK_WHOLE")).toBe("UNLOCKED");
    expect(statusesEligibleToOpen("YEAR_END_REVIEW")).toEqual([
      "LOCKED",
      "PARTLY_UNLOCKED",
      "UNLOCKED",
    ]);
  });

  it("reopens a finalized plan for rescoring", () => {
    expect(applyTransition("FINALIZED", "REOPEN")).toBe("IN_REVIEW");
    expect(canTransition("IN_REVIEW", "REOPEN")).toBe(false);
  });

  it("treats a goal review without a score as unfinished year-end scoring", () => {
    expect(isPmScoreComplete(null)).toBe(false);
    expect(isPmScoreComplete({ status: "REVIEWED", score: null })).toBe(false);
    expect(isPmScoreComplete({ status: "DRAFT", score: 80 })).toBe(false);
    expect(isPmScoreComplete({ status: "REVIEWED", score: 80 })).toBe(true);
  });
});
