import type { PrismaClient } from "@prisma/client";
import type { Env } from "../../env.js";
import { hashToken } from "../../domain/otp.js";
import { generateOpaqueToken } from "../../lib/crypto.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { type Mailer, inviteEmailHtml, sendMail } from "../emails/mailer.js";

export class UsersService {
  constructor(
    private readonly db: PrismaClient,
    private readonly env: Env,
    private readonly mailer: Mailer,
  ) {}

  async list(query: { q?: string; page: number; pageSize: number }) {
    const where = query.q
      ? {
          OR: [
            { fullName: { contains: query.q, mode: "insensitive" as const } },
            { email: { contains: query.q, mode: "insensitive" as const } },
          ],
        }
      : {};

    const [total, users] = await Promise.all([
      this.db.user.count({ where }),
      this.db.user.findMany({
        where,
        include: {
          lineManager: { select: { id: true, fullName: true } },
          invitation: true,
        },
        orderBy: { fullName: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: users.map((user) => this.serialize(user)),
    };
  }

  async invite(
    actorId: string,
    input: {
      fullName: string;
      email: string;
      jobTitle?: string;
      lineManagerId?: string | null;
      role: "STAFF" | "ADMIN";
      remindCreatePlan: boolean;
    },
  ) {
    const email = input.email.toLowerCase();
    const existing = await this.db.user.findUnique({ where: { email } });
    if (existing) {
      throw conflict("A user with this email already exists.");
    }
    if (input.lineManagerId) {
      const manager = await this.db.user.findUnique({ where: { id: input.lineManagerId } });
      if (!manager) {
        throw badRequest("Line manager not found.");
      }
    }

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.env.INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const user = await this.db.user.create({
      data: {
        email,
        fullName: input.fullName,
        jobTitle: input.jobTitle,
        role: input.role,
        lineManagerId: input.lineManagerId ?? null,
        status: "INVITED",
        invitation: {
          create: {
            tokenHash: hashToken(token),
            expiresAt,
            remindCreatePlan: input.remindCreatePlan,
            invitedById: actorId,
          },
        },
      },
      include: {
        lineManager: { select: { fullName: true } },
        invitation: true,
      },
    });

    const admin = await this.db.user.findUniqueOrThrow({ where: { id: actorId } });
    const year = new Date().getFullYear();
    const activateUrl = `${this.env.APP_URL}/activate/${token}`;
    await sendMail(this.mailer, {
      to: user.email,
      subject: `You're invited to set up your ${year} Impact Plan`,
      html: inviteEmailHtml({
        firstName: user.fullName.split(" ")[0] ?? user.fullName,
        adminName: admin.fullName,
        lineManagerName: user.lineManager?.fullName ?? null,
        year,
        activateUrl,
      }),
      text: `Activate your Impact Plan account: ${activateUrl}`,
    });

    await this.db.changeLog.create({
      data: {
        actorId,
        action: "USER_INVITED",
        metadata: { userId: user.id, email: user.email },
      },
    });

    return {
      user: this.serialize(user),
      inviteToken: this.shouldExposeSecrets() ? token : undefined,
    };
  }

  async resendInvite(actorId: string, userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: { invitation: true, lineManager: { select: { fullName: true } } },
    });
    if (!user) {
      throw notFound("User not found.");
    }
    if (user.status === "ACTIVE") {
      throw badRequest("User is already active.");
    }

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.env.INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await this.db.invitation.upsert({
      where: { userId },
      create: {
        userId,
        tokenHash: hashToken(token),
        expiresAt,
        invitedById: actorId,
        remindCreatePlan: true,
      },
      update: {
        tokenHash: hashToken(token),
        expiresAt,
        usedAt: null,
        invitedById: actorId,
      },
    });

    const admin = await this.db.user.findUniqueOrThrow({ where: { id: actorId } });
    const year = new Date().getFullYear();
    const activateUrl = `${this.env.APP_URL}/activate/${token}`;
    await sendMail(this.mailer, {
      to: user.email,
      subject: `You're invited to set up your ${year} Impact Plan`,
      html: inviteEmailHtml({
        firstName: user.fullName.split(" ")[0] ?? user.fullName,
        adminName: admin.fullName,
        lineManagerName: user.lineManager?.fullName ?? null,
        year,
        activateUrl,
      }),
      text: `Activate your Impact Plan account: ${activateUrl}`,
    });

    return { ok: true, inviteToken: this.shouldExposeSecrets() ? token : undefined };
  }

  async update(
    userId: string,
    input: {
      fullName?: string;
      jobTitle?: string | null;
      lineManagerId?: string | null;
      role?: "STAFF" | "ADMIN";
      authMethod?: "PASSWORD" | "OTP" | "UNSET";
      status?: "INVITED" | "ACTIVE" | "DISABLED";
    },
  ) {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw notFound("User not found.");
    }
    const updated = await this.db.user.update({
      where: { id: userId },
      data: input,
      include: {
        lineManager: { select: { id: true, fullName: true } },
        invitation: true,
      },
    });
    return this.serialize(updated);
  }

  async lookup(q: string) {
    return this.db.user.findMany({
      where: {
        status: { in: ["ACTIVE", "INVITED"] },
        OR: [
          { fullName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { id: true, fullName: true, email: true, jobTitle: true },
      take: 20,
      orderBy: { fullName: "asc" },
    });
  }

  private serialize(user: {
    id: string;
    email: string;
    fullName: string;
    jobTitle: string | null;
    role: string;
    authMethod: string;
    status: string;
    lineManagerId: string | null;
    lineManager?: { id?: string; fullName: string } | null;
    invitation?: { expiresAt: Date; usedAt: Date | null } | null;
    activatedAt?: Date | null;
  }) {
    let inviteStatus: string | null = null;
    if (user.status === "INVITED" && user.invitation) {
      inviteStatus = user.invitation.expiresAt < new Date() ? "EXPIRED" : "PENDING";
    }
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      jobTitle: user.jobTitle,
      role: user.role,
      authMethod: user.authMethod,
      status: user.status,
      lineManagerId: user.lineManagerId,
      lineManagerName: user.lineManager?.fullName ?? null,
      inviteStatus,
      inviteExpiresAt: user.invitation?.expiresAt?.toISOString() ?? null,
      activatedAt: user.activatedAt?.toISOString() ?? null,
    };
  }

  private shouldExposeSecrets(): boolean {
    return (
      this.env.NODE_ENV !== "production" &&
      (this.env.EXPOSE_DEV_SECRETS || this.env.DEV_SHORTCUTS || this.env.NODE_ENV === "test")
    );
  }
}
