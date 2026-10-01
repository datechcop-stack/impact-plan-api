import { describe, expect, it } from "vitest";
import {
  applyTransition,
  canTransition,
  IllegalPlanTransitionError,
  isImmutable,
  isOwnerEditable,
} from "../../src/domain/lifecycle.js";

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
});
