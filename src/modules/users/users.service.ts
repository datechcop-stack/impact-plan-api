import type { Prisma, PrismaClient } from "@prisma/client";
import type { Env } from "../../env.js";
import { hashToken } from "../../domain/otp.js";
import { generateOpaqueToken } from "../../lib/crypto.js";
import { planComponentTemplateSchema } from "../../domain/plan-component-template.js";
import { validateWeights } from "../../domain/scoring.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { type Mailer, inviteEmailHtml, sendMail } from "../emails/mailer.js";

export class UsersService {
  constructor(
    private readonly db: PrismaClient,
    private readonly env: Env,
    private readonly mailer: Mailer,
  ) {}

  async list(query: {
    q?: string;
    status?: "ALL" | "ACTIVE" | "INVITED" | "INVITE_EXPIRED" | "DISABLED";
    page: number;
    pageSize: number;
  }) {
    const now = new Date();
    const and: Prisma.UserWhereInput[] = [];
    if (query.status && query.status !== "ALL") {
      if (query.status === "INVITE_EXPIRED") {
        and.push({
          status: "INVITED",
          invitation: { expiresAt: { lt: now }, usedAt: null },
        });
      } else if (query.status === "INVITED") {
        and.push({
          status: "INVITED",
          OR: [
            { invitation: { is: null } },
            { invitation: { expiresAt: { gte: now }, usedAt: null } },
          ],
        });
      } else {
        and.push({ status: query.status });
      }
    }
    if (query.q) {
      and.push({
        OR: [
          { fullName: { contains: query.q, mode: "insensitive" as const } },
          { email: { contains: query.q, mode: "insensitive" as const } },
        ],
      });
    }
    const where: Prisma.UserWhereInput = and.length ? { AND: and } : {};

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
      planComponents?: Array<{
        type: "PROJECTS" | "BD" | "TECH_PERSONAL" | "COP";
        enabled: boolean;
        weight: number;
      }>;
    },
  ) {
    const email = input.email.toLowerCase();
    const existing = await this.db.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.status === "DISABLED") {
        return this.reactivateDisabledUser(actorId, existing.id, input);
      }
      throw conflict("A user with this email already exists.");
    }
    if (input.lineManagerId) {
      const manager = await this.db.user.findUnique({ where: { id: input.lineManagerId } });
      if (!manager) {
        throw badRequest("Line manager not found.");
      }
    }

    let planComponentTemplate: Prisma.InputJsonValue | undefined = undefined;
    if (input.planComponents) {
      const parsed = planComponentTemplateSchema.parse(input.planComponents);
      const weightCheck = validateWeights(parsed);
      if (!weightCheck.ok) {
        throw badRequest(`Active component weights must total 100 (got ${weightCheck.total}).`);
      }
      planComponentTemplate = parsed;
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
        planComponentTemplate,
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

  async bulkInvite(
    actorId: string,
    input: {
      invites: Array<{
        fullName: string;
        email: string;
        jobTitle?: string;
        lineManagerEmail?: string;
        role: "STAFF" | "ADMIN";
      }>;
      remindCreatePlan: boolean;
    },
  ) {
    const failed: Array<{ email: string; message: string }> = [];
    let invited = 0;
    const seenEmails = new Set<string>();

    for (const row of input.invites) {
      const email = row.email.toLowerCase();
      if (seenEmails.has(email)) {
        failed.push({ email, message: "Duplicate email in this upload." });
        continue;
      }
      seenEmails.add(email);

      let lineManagerId: string | null = null;
      if (row.lineManagerEmail) {
        const managerEmail = row.lineManagerEmail.toLowerCase();
        const manager = await this.db.user.findUnique({ where: { email: managerEmail } });
        if (!manager) {
          failed.push({
            email,
            message: `Line manager not found: ${row.lineManagerEmail}`,
          });
          continue;
        }
        lineManagerId = manager.id;
      }

      try {
        await this.invite(actorId, {
          fullName: row.fullName,
          email,
          jobTitle: row.jobTitle,
          lineManagerId,
          role: row.role,
          remindCreatePlan: input.remindCreatePlan,
        });
        invited += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invite failed.";
        failed.push({ email, message });
      }
    }

    return { invited, failed };
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
    if (user.status === "DISABLED") {
      throw badRequest("This user was removed. Send a new invitation from the invite form.");
    }

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.env.INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await this.db.user.update({
      where: { id: userId },
      data: { status: "INVITED" },
    });
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

    await this.db.changeLog.create({
      data: {
        actorId,
        action: "USER_INVITE_RESENT",
        metadata: { userId, email: user.email },
      },
    });

    return { ok: true, inviteToken: this.shouldExposeSecrets() ? token : undefined };
  }

  /**
   * Cancel a pending invitation. Clears line-manager links, then hard-deletes when
   * there is no plan or audit history to retain; otherwise disables the account.
   */
  async revokeInvite(actorId: string, userId: string) {
    if (actorId === userId) {
      throw badRequest("You cannot revoke your own invitation.");
    }

    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: this.removeUserInclude(),
    });
    if (!user) {
      throw notFound("User not found.");
    }
    if (user.status !== "INVITED") {
      throw badRequest("Only pending invitations can be revoked.");
    }

    const retain = this.hasRetainableHistory(user);
    if (!retain) {
      await this.hardDeleteUser(actorId, userId, user.email, "deleted", "USER_INVITE_REVOKED");
      return { ok: true, mode: "deleted" as const };
    }

    await this.disableUser(actorId, userId, user.email, "disabled", "USER_INVITE_REVOKED");
    return { ok: true, mode: "disabled" as const };
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

  /**
   * Remove a staff member from the system.
   * Never-activated invites with no plan history are hard-deleted.
   * Otherwise the account is disabled and sessions are revoked.
   */
  async remove(actorId: string, userId: string) {
    if (actorId === userId) {
      throw badRequest("You cannot remove your own account.");
    }

    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: this.removeUserInclude(),
    });
    if (!user) {
      throw notFound("User not found.");
    }
    if (user.status === "DISABLED") {
      throw badRequest("This user is already removed.");
    }

    if (user.status === "INVITED") {
      return this.revokeInvite(actorId, userId);
    }

    if (user.role === "ADMIN" && user.status === "ACTIVE") {
      const otherActiveAdmins = await this.db.user.count({
        where: {
          id: { not: userId },
          role: "ADMIN",
          status: "ACTIVE",
        },
      });
      if (otherActiveAdmins === 0) {
        throw badRequest("Cannot remove the last active admin.");
      }
    }

    await this.disableUser(actorId, userId, user.email, "disabled", "USER_REMOVED");
    return { ok: true, mode: "disabled" as const };
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

  private async reactivateDisabledUser(
    actorId: string,
    userId: string,
    input: {
      fullName: string;
      email: string;
      jobTitle?: string;
      lineManagerId?: string | null;
      role: "STAFF" | "ADMIN";
      remindCreatePlan: boolean;
      planComponents?: Array<{
        type: "PROJECTS" | "BD" | "TECH_PERSONAL" | "COP";
        enabled: boolean;
        weight: number;
      }>;
    },
  ) {
    if (input.lineManagerId) {
      const manager = await this.db.user.findUnique({ where: { id: input.lineManagerId } });
      if (!manager) {
        throw badRequest("Line manager not found.");
      }
    }

    let planComponentTemplate: Prisma.InputJsonValue | undefined = undefined;
    if (input.planComponents) {
      const parsed = planComponentTemplateSchema.parse(input.planComponents);
      const weightCheck = validateWeights(parsed);
      if (!weightCheck.ok) {
        throw badRequest(`Active component weights must total 100 (got ${weightCheck.total}).`);
      }
      planComponentTemplate = parsed;
    }

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.env.INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const user = await this.db.user.update({
      where: { id: userId },
      data: {
        fullName: input.fullName,
        jobTitle: input.jobTitle,
        role: input.role,
        lineManagerId: input.lineManagerId ?? null,
        status: "INVITED",
        authMethod: "UNSET",
        passwordHash: null,
        activatedAt: null,
        ...(planComponentTemplate !== undefined ? { planComponentTemplate } : {}),
      },
      include: {
        lineManager: { select: { fullName: true } },
        invitation: true,
      },
    });

    await this.db.invitation.upsert({
      where: { userId },
      create: {
        userId,
        tokenHash: hashToken(token),
        expiresAt,
        invitedById: actorId,
        remindCreatePlan: input.remindCreatePlan,
      },
      update: {
        tokenHash: hashToken(token),
        expiresAt,
        usedAt: null,
        invitedById: actorId,
        remindCreatePlan: input.remindCreatePlan,
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
        action: "USER_REINVITED",
        metadata: { userId: user.id, email: user.email },
      },
    });

    return {
      user: this.serialize(user),
      inviteToken: this.shouldExposeSecrets() ? token : undefined,
    };
  }

  private removeUserInclude() {
    return {
      invitation: true,
      ownedPlans: { select: { id: true }, take: 1 },
      createdPlans: { select: { id: true }, take: 1 },
      managedEntries: { select: { id: true }, take: 1 },
      reports: { select: { id: true }, take: 1 },
      pmReviews: { select: { id: true }, take: 1 },
      editRequests: { select: { id: true }, take: 1 },
      editDecisions: { select: { id: true }, take: 1 },
      changeLogs: { select: { id: true }, take: 1 },
      invitationsSent: { select: { id: true }, take: 1 },
      reviewCycleParticipants: { select: { id: true }, take: 1 },
    } as const;
  }

  private hasRetainableHistory(user: {
    ownedPlans: { id: string }[];
    createdPlans: { id: string }[];
    managedEntries: { id: string }[];
    pmReviews: { id: string }[];
    editRequests: { id: string }[];
    editDecisions: { id: string }[];
    changeLogs: { id: string }[];
    reviewCycleParticipants: { id: string }[];
  }) {
    return (
      user.ownedPlans.length > 0 ||
      user.createdPlans.length > 0 ||
      user.managedEntries.length > 0 ||
      user.pmReviews.length > 0 ||
      user.editRequests.length > 0 ||
      user.editDecisions.length > 0 ||
      user.changeLogs.length > 0 ||
      user.reviewCycleParticipants.length > 0
    );
  }

  private async hardDeleteUser(
    actorId: string,
    userId: string,
    email: string,
    mode: "deleted",
    action: "USER_REMOVED" | "USER_INVITE_REVOKED",
  ) {
    await this.db.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { lineManagerId: userId },
        data: { lineManagerId: null },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.invitation.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
      await tx.changeLog.create({
        data: {
          actorId,
          action,
          metadata: { userId, email, mode },
        },
      });
    });
  }

  private async disableUser(
    actorId: string,
    userId: string,
    email: string,
    mode: "disabled",
    action: "USER_REMOVED" | "USER_INVITE_REVOKED",
  ) {
    await this.db.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.invitation.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          status: "DISABLED",
          passwordHash: null,
          authMethod: "UNSET",
        },
      });
      await tx.user.updateMany({
        where: { lineManagerId: userId },
        data: { lineManagerId: null },
      });
      await tx.changeLog.create({
        data: {
          actorId,
          action,
          metadata: { userId, email, mode },
        },
      });
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
      (this.env.EXPOSE_DEV_SECRETS || this.env.NODE_ENV === "test")
    );
  }
}
