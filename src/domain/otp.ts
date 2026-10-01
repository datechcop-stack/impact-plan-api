import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokensEqual(plain: string, hash: string): boolean {
  const left = Buffer.from(hashToken(plain), "hex");
  const right = Buffer.from(hash, "hex");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function generateOtpCode(length = 6): string {
  const max = 10 ** length;
  return String(randomInt(0, max)).padStart(length, "0");
}

export function hashOtpCode(code: string): string {
  return hashToken(code);
}

export type OtpChallengeState = {
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attemptCount: number;
  lastSentAt: Date;
};

export type VerifyOtpResult =
  { ok: true } | { ok: false; reason: "EXPIRED" | "CONSUMED" | "MAX_ATTEMPTS" | "INVALID" };

export function canResendOtp(
  lastSentAt: Date,
  now: Date,
  cooldownSeconds: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const elapsedMs = now.getTime() - lastSentAt.getTime();
  const cooldownMs = cooldownSeconds * 1000;
  if (elapsedMs >= cooldownMs) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((cooldownMs - elapsedMs) / 1000),
  };
}

export function verifyOtpCode(
  challenge: OtpChallengeState,
  code: string,
  now: Date,
  maxAttempts: number,
): VerifyOtpResult {
  if (challenge.consumedAt) {
    return { ok: false, reason: "CONSUMED" };
  }
  if (challenge.attemptCount >= maxAttempts) {
    return { ok: false, reason: "MAX_ATTEMPTS" };
  }
  if (now.getTime() > challenge.expiresAt.getTime()) {
    return { ok: false, reason: "EXPIRED" };
  }
  if (!tokensEqual(code, challenge.codeHash)) {
    return { ok: false, reason: "INVALID" };
  }
  return { ok: true };
}
