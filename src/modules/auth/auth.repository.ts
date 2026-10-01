import type { AuthMethod, OtpPurpose, PrismaClient, User } from "@prisma/client";

export class AuthRepository {
  constructor(private readonly db: PrismaClient) {}

  findUserByEmail(email: string) {
    return this.db.user.findUnique({ where: { email: email.toLowerCase() } });
  }

  findUserById(id: string) {
    return this.db.user.findUnique({
      where: { id },
      include: { lineManager: { select: { id: true, fullName: true } } },
    });
  }

  findInvitationByTokenHash(tokenHash: string) {
    return this.db.invitation.findFirst({
      where: { tokenHash },
      include: {
        user: { include: { lineManager: { select: { fullName: true } } } },
        invitedBy: { select: { fullName: true } },
      },
    });
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date) {
    return this.db.session.create({
      data: { userId, tokenHash, expiresAt },
    });
  }

  findSessionByTokenHash(tokenHash: string) {
    return this.db.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  }

  async revokeSession(id: string) {
    return this.db.session.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  async activateWithPassword(userId: string, invitationId: string, passwordHash: string) {
    return this.db.$transaction([
      this.db.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          authMethod: "PASSWORD",
          status: "ACTIVE",
          activatedAt: new Date(),
        },
      }),
      this.db.invitation.update({
        where: { id: invitationId },
        data: { usedAt: new Date() },
      }),
    ]);
  }

  async activateWithOtp(userId: string, invitationId: string) {
    return this.db.$transaction([
      this.db.user.update({
        where: { id: userId },
        data: {
          authMethod: "OTP",
          status: "ACTIVE",
          activatedAt: new Date(),
        },
      }),
      this.db.invitation.update({
        where: { id: invitationId },
        data: { usedAt: new Date() },
      }),
    ]);
  }

  async setAuthMethod(userId: string, authMethod: AuthMethod) {
    return this.db.user.update({
      where: { id: userId },
      data: { authMethod },
    });
  }

  async setPassword(userId: string, passwordHash: string) {
    return this.db.user.update({
      where: { id: userId },
      data: { passwordHash, authMethod: "PASSWORD" },
    });
  }

  createOtpChallenge(input: {
    userId: string;
    purpose: OtpPurpose;
    codeHash: string;
    expiresAt: Date;
  }) {
    return this.db.otpChallenge.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
      },
    });
  }

  findLatestOtp(userId: string, purpose: OtpPurpose) {
    return this.db.otpChallenge.findFirst({
      where: { userId, purpose, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  async incrementOtpAttempts(id: string) {
    return this.db.otpChallenge.update({
      where: { id },
      data: { attemptCount: { increment: 1 } },
    });
  }

  async consumeOtp(id: string) {
    return this.db.otpChallenge.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  }

  async touchOtpSent(id: string) {
    return this.db.otpChallenge.update({
      where: { id },
      data: { lastSentAt: new Date() },
    });
  }

  publicUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      jobTitle: user.jobTitle,
      role: user.role,
      authMethod: user.authMethod,
      status: user.status,
      lineManagerId: user.lineManagerId,
    };
  }
}
