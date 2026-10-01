import type { Transporter } from "nodemailer";
import type { Env } from "../../env.js";
import {
  canResendOtp,
  generateOtpCode,
  hashOtpCode,
  hashToken,
  verifyOtpCode,
} from "../../domain/otp.js";
import { isPasswordValid, passwordsMatch } from "../../domain/passwords.js";
import { generateOpaqueToken, hashPassword, verifyPassword } from "../../lib/crypto.js";
import { badRequest, unauthorized, validationError } from "../../lib/errors.js";
import { inviteEmailHtml, otpEmailHtml, sendMail } from "../emails/mailer.js";
import { AuthRepository } from "./auth.repository.js";

const GENERIC_AUTH_MESSAGE = "If that account exists, we sent instructions.";
const SESSION_DAYS = 14;

export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly env: Env,
    private readonly mailer: Transporter,
  ) {}

  async lookupInvite(token: string) {
    const invitation = await this.repo.findInvitationByTokenHash(hashToken(token));
    if (!invitation || invitation.usedAt || invitation.expiresAt < new Date()) {
      throw badRequest("This invitation is invalid or has expired.");
    }
    const firstName = invitation.user.fullName.split(" ")[0] ?? invitation.user.fullName;
    return {
      email: invitation.user.email,
      fullName: invitation.user.fullName,
      firstName,
      authMethod: invitation.user.authMethod,
      lineManagerName: invitation.user.lineManager?.fullName ?? null,
      invitedByName: invitation.invitedBy.fullName,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async chooseMethod(token: string, method: "PASSWORD" | "OTP") {
    const invitation = await this.requireOpenInvitation(token);
    await this.repo.setAuthMethod(invitation.userId, method);
    return { method };
  }

  async activateWithPassword(token: string, password: string, confirmPassword: string) {
    if (!isPasswordValid(password)) {
      throw validationError("Password does not meet requirements.");
    }
    if (!passwordsMatch(password, confirmPassword)) {
      throw validationError("Passwords do not match.");
    }
    const invitation = await this.requireOpenInvitation(token);
    const passwordHash = await hashPassword(password);
    await this.repo.activateWithPassword(invitation.userId, invitation.id, passwordHash);
    return this.createSessionForUser(invitation.userId);
  }

  async requestOtp(input: {
    purpose: "ACTIVATION" | "LOGIN" | "PASSWORD_RESET";
    email?: string;
    token?: string;
  }) {
    const user = await this.resolveUserForOtp(input);
    // Anti-enumeration: always succeed for login/reset when user missing
    if (!user) {
      return { sent: true, retryAfterSeconds: this.env.OTP_RESEND_COOLDOWN_SECONDS };
    }

    const existing = await this.repo.findLatestOtp(user.id, input.purpose);
    const now = new Date();
    if (existing) {
      const resend = canResendOtp(existing.lastSentAt, now, this.env.OTP_RESEND_COOLDOWN_SECONDS);
      if (!resend.allowed) {
        return { sent: false, retryAfterSeconds: resend.retryAfterSeconds };
      }
    }

    const code = generateOtpCode();
    const expiresAt = new Date(now.getTime() + this.env.OTP_EXPIRY_MINUTES * 60_000);
    await this.repo.createOtpChallenge({
      userId: user.id,
      purpose: input.purpose,
      codeHash: hashOtpCode(code),
      expiresAt,
    });

    await sendMail(this.mailer, this.env, {
      to: user.email,
      subject: "Your Impact Plan one-time code",
      html: otpEmailHtml(code),
      text: `Your Impact Plan code is ${code}. It expires in ${this.env.OTP_EXPIRY_MINUTES} minutes.`,
    });

    return {
      sent: true,
      retryAfterSeconds: this.env.OTP_RESEND_COOLDOWN_SECONDS,
      ...(this.shouldExposeSecrets() ? { devCode: code } : {}),
    };
  }

  async verifyOtp(input: {
    purpose: "ACTIVATION" | "LOGIN" | "PASSWORD_RESET";
    email?: string;
    token?: string;
    code: string;
  }) {
    const user = await this.resolveUserForOtp(input);
    if (!user) {
      throw unauthorized("Invalid code.");
    }

    const challenge = await this.repo.findLatestOtp(user.id, input.purpose);
    if (!challenge) {
      throw unauthorized("Invalid code.");
    }

    const result = verifyOtpCode(challenge, input.code, new Date(), this.env.OTP_MAX_ATTEMPTS);
    if (!result.ok) {
      await this.repo.incrementOtpAttempts(challenge.id);
      throw unauthorized("Invalid code.");
    }

    await this.repo.consumeOtp(challenge.id);

    if (input.purpose === "ACTIVATION") {
      if (!input.token) {
        throw badRequest("Activation token is required.");
      }
      const invitation = await this.requireOpenInvitation(input.token);
      await this.repo.activateWithOtp(invitation.userId, invitation.id);
    }

    if (input.purpose === "PASSWORD_RESET") {
      return { verified: true, userId: user.id };
    }

    return this.createSessionForUser(user.id);
  }

  async loginWithPassword(email: string, password: string) {
    const user = await this.repo.findUserByEmail(email);
    // Constant-ish response path
    const invalid = () => unauthorized("Invalid email or password.");
    if (!user || user.status !== "ACTIVE" || user.authMethod !== "PASSWORD" || !user.passwordHash) {
      await hashPassword("dummy-password-for-timing");
      throw invalid();
    }
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      throw invalid();
    }
    return this.createSessionForUser(user.id);
  }

  async resetPassword(email: string, code: string, password: string, confirmPassword: string) {
    if (!isPasswordValid(password) || !passwordsMatch(password, confirmPassword)) {
      throw validationError("Password does not meet requirements.");
    }
    await this.verifyOtp({ purpose: "PASSWORD_RESET", email, code });
    const user = await this.repo.findUserByEmail(email);
    if (!user) {
      return { ok: true };
    }
    const passwordHash = await hashPassword(password);
    await this.repo.setPassword(user.id, passwordHash);
    return { ok: true };
  }

  async me(userId: string) {
    const user = await this.repo.findUserById(userId);
    if (!user) {
      throw unauthorized();
    }
    return this.repo.publicUser(user);
  }

  async logout(sessionId: string) {
    await this.repo.revokeSession(sessionId);
    return { ok: true };
  }

  async createInviteEmailPreview(input: {
    to: string;
    firstName: string;
    adminName: string;
    lineManagerName: string | null;
    year: number;
    token: string;
  }) {
    const activateUrl = `${this.env.APP_URL}/activate/${input.token}`;
    await sendMail(this.mailer, this.env, {
      to: input.to,
      subject: `You're invited to set up your ${input.year} Impact Plan`,
      html: inviteEmailHtml({
        firstName: input.firstName,
        adminName: input.adminName,
        lineManagerName: input.lineManagerName,
        year: input.year,
        activateUrl,
      }),
      text: `Activate your Impact Plan account: ${activateUrl}`,
    });
  }

  getGenericMessage() {
    return GENERIC_AUTH_MESSAGE;
  }

  private shouldExposeSecrets(): boolean {
    return (
      this.env.NODE_ENV !== "production" &&
      (this.env.EXPOSE_DEV_SECRETS || this.env.DEV_SHORTCUTS || this.env.NODE_ENV === "test")
    );
  }

  private async requireOpenInvitation(token: string) {
    const invitation = await this.repo.findInvitationByTokenHash(hashToken(token));
    if (!invitation || invitation.usedAt || invitation.expiresAt < new Date()) {
      throw badRequest("This invitation is invalid or has expired.");
    }
    return invitation;
  }

  private async resolveUserForOtp(input: {
    purpose: "ACTIVATION" | "LOGIN" | "PASSWORD_RESET";
    email?: string;
    token?: string;
  }) {
    if (input.purpose === "ACTIVATION") {
      if (!input.token) {
        throw badRequest("Activation token is required.");
      }
      const invitation = await this.requireOpenInvitation(input.token);
      return invitation.user;
    }
    if (!input.email) {
      throw badRequest("Email is required.");
    }
    return this.repo.findUserByEmail(input.email);
  }

  async issueSession(userId: string) {
    return this.createSessionForUser(userId);
  }

  private async createSessionForUser(userId: string) {
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    const session = await this.repo.createSession(userId, hashToken(token), expiresAt);
    const user = await this.repo.findUserById(userId);
    if (!user) {
      throw unauthorized();
    }
    return {
      sessionToken: token,
      sessionId: session.id,
      expiresAt,
      user: this.repo.publicUser(user),
    };
  }
}
