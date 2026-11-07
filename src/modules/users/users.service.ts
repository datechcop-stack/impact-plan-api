import type { Prisma, PrismaClient } from "@prisma/client";
import type { Env } from "../../env.js";
import { hashToken } from "../../domain/otp.js";
import { generateOpaqueToken } from "../../lib/crypto.js";
import { planComponentTemplateSchema } from "../../domain/plan-component-template.js";
import { validateWeights } from "../../domain/scoring.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { ARCHIVE_TX_OPTIONS, archiveUser } from "../archive/archive.js";
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
    const statusWhere = (
      status: "ACTIVE" | "INVITED" | "INVITE_EXPIRED" | "DISABLED",
    ): Prisma.UserWhereInput => {
      if (status === "INVITE_EXPIRED") {
        return { status: "INVITED", invitation: { expiresAt: { lt: now }, usedAt: null } };
      }
      if (status === "INVITED") {
        return {
          status: "INVITED",
          OR: [
            { invitation: { is: null } },
            { invitation: { expiresAt: { gte: now }, usedAt: null } },
          ],
        };
      }
      return { status };
    };
    const searchWhere: Prisma.UserWhereInput = query.q
      ? {
          OR: [
            { fullName: { contains: query.q, mode: "insensitive" as const } },
            { email: { contains: query.q, mode: "insensitive" as const } },
          ],
        }
      : {};
    const where: Prisma.UserWhereInput =
      query.status && query.status !== "ALL"
        ? { AND: [searchWhere, statusWhere(query.status)] }
        : searchWhere;
    const countFor = (status: "ACTIVE" | "INVITED" | "INVITE_EXPIRED" | "DISABLED") =>
      this.db.user.count({ where: { AND: [searchWhere, statusWhere(status)] } });

    const [all, active, invited, inviteExpired, disabled] = await Promise.all([
      this.db.user.count({ where: searchWhere }),
      countFor("ACTIVE"),
      countFor("INVITED"),
      countFor("INVITE_EXPIRED"),
      countFor("DISABLED"),
    ]);

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
      counts: { all, active, invited, inviteExpired, disabled },
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
   * Cancel a pending invitation. The invited user is archived, then removed from the app.
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

    await this.purgeUserCompletely(actorId, userId, user.email, "USER_INVITE_REVOKED");
    return { ok: true, mode: "deleted" as const };
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
   * Delete a user and their owned impact plans from the app. A full copy is kept in
   * DeletedRecord, so the record is still available for audit or restore.
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

    await this.purgeUserCompletely(actorId, userId, user.email, "USER_REMOVED");
    return { ok: true, mode: "deleted" as const };
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

  /** Archive the user, then remove them and everything they own from the live tables. */
  private async purgeUserCompletely(
    actorId: string,
    userId: string,
    email: string,
    action: "USER_REMOVED" | "USER_INVITE_REVOKED",
  ) {
    await this.db.$transaction(async (tx) => {
      const archived = await archiveUser(tx, actorId, userId, action);

      await tx.user.updateMany({
        where: { lineManagerId: userId },
        data: { lineManagerId: null },
      });

      await tx.plan.deleteMany({ where: { ownerId: userId } });

      await tx.plan.updateMany({
        where: { createdById: userId },
        data: { createdById: actorId },
      });
      await tx.planEntry.updateMany({
        where: { managerId: userId },
        data: { managerId: actorId },
      });
      await tx.pmReview.updateMany({
        where: { reviewerId: userId },
        data: { reviewerId: actorId },
      });
      await tx.editRequest.deleteMany({ where: { requesterId: userId } });
      await tx.editRequest.updateMany({
        where: { decidedById: userId },
        data: { decidedById: null },
      });
      await tx.changeLog.deleteMany({ where: { actorId: userId } });
      await tx.invitation.updateMany({
        where: { invitedById: userId },
        data: { invitedById: actorId },
      });
      await tx.invitation.deleteMany({ where: { userId } });

      await tx.user.delete({ where: { id: userId } });

      await tx.changeLog.create({
        data: {
          actorId,
          action,
          metadata: { userId, email, mode: "archived", archiveId: archived?.id ?? null },
        },
      });
    }, ARCHIVE_TX_OPTIONS);
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
