import { describe, expect, it } from "vitest";
import { canResendOtp, generateOtpCode, hashOtpCode, verifyOtpCode } from "../../src/domain/otp.js";

describe("otp", () => {
  it("generates 6-digit codes", () => {
    const code = generateOtpCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("enforces cooldown", () => {
    const lastSentAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-01T00:00:30Z");
    expect(canResendOtp(lastSentAt, now, 60)).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
    expect(canResendOtp(lastSentAt, new Date("2026-01-01T00:01:00Z"), 60).allowed).toBe(true);
  });

  it("verifies hashed codes with attempt and expiry rules", () => {
    const code = "482913";
    const challenge = {
      codeHash: hashOtpCode(code),
      expiresAt: new Date("2026-01-01T00:10:00Z"),
      consumedAt: null,
      attemptCount: 0,
      lastSentAt: new Date("2026-01-01T00:00:00Z"),
    };
    expect(verifyOtpCode(challenge, code, new Date("2026-01-01T00:05:00Z"), 5)).toEqual({
      ok: true,
    });
    expect(verifyOtpCode(challenge, "000000", new Date("2026-01-01T00:05:00Z"), 5)).toEqual({
      ok: false,
      reason: "INVALID",
    });
    expect(
      verifyOtpCode({ ...challenge, attemptCount: 5 }, code, new Date("2026-01-01T00:05:00Z"), 5),
    ).toEqual({ ok: false, reason: "MAX_ATTEMPTS" });
    expect(verifyOtpCode(challenge, code, new Date("2026-01-01T00:11:00Z"), 5)).toEqual({
      ok: false,
      reason: "EXPIRED",
    });
  });
});
