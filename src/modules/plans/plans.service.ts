import type { ComponentType, PrismaClient } from "@prisma/client";
import { applyTransition } from "../../domain/lifecycle.js";
import {
  assertObjectivesValid,
  entryObjectivesInclude,
  objectivesCreateData,
  type ObjectiveInput,
} from "../../domain/objectives.js";
import { validateWeights } from "../../domain/scoring.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";

type ComponentInput = {
  type: ComponentType;
  enabled: boolean;
  weight: number;
};

type EntryInput = {
  type: ComponentType;
  title: string;
  objectives: ObjectiveInput[];
  managerId: string;
  dueDate: string;
};

export class PlansService {
  constructor(private readonly db: PrismaClient) {}

  async list(query: {
    year?: number;
    q?: string;
    status?: string;
    page: number;
    pageSize: number;
  }) {
    const year = query.year ?? new Date().getFullYear();
    const where = {
      year,
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.q
        ? {
            owner: {
              OR: [
                { fullName: { contains: query.q, mode: "insensitive" as const } },
                { email: { contains: query.q, mode: "insensitive" as const } },
              ],
            },
          }
        : {}),
    };

    const [total, plans] = await Promise.all([
      this.db.plan.count({ where }),
      this.db.plan.findMany({
        where,
        include: {
          owner: { select: { id: true, fullName: true, email: true, jobTitle: true } },
          components: true,
          _count: { select: { editRequests: true } },
        },
        orderBy: { updatedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: plans.map((plan) => ({
        id: plan.id,
        year: plan.year,
        status: plan.status,
        owner: plan.owner,
        components: plan.components,
        createdAt: plan.createdAt.toISOString(),
        updatedAt: plan.updatedAt.toISOString(),
      })),
    };
  }

  async getById(id: string) {
    const plan = await this.db.plan.findUnique({
      where: { id },
      include: {
        owner: {
          select: {
            id: true,
            fullName: true,
            email: true,
            jobTitle: true,
            lineManager: { select: { fullName: true } },
          },
        },
        components: {
          include: {
            entries: {
              include: {
                manager: { select: { id: true, fullName: true } },
                selfAssessment: true,
                pmReview: true,
                ...entryObjectivesInclude,
              },
              orderBy: { sortOrder: "asc" },
            },
          },
        },
        changeLogs: {
          take: 20,
          orderBy: { createdAt: "desc" },
          include: { actor: { select: { fullName: true } } },
        },
      },
    });
    if (!plan) {
      throw notFound("Plan not found.");
    }
    return plan;
  }

  async create(
    actorId: string,
    input: {
      ownerId: string;
      year: number;
      components: ComponentInput[];
      entries: EntryInput[];
      lock: boolean;
    },
  ) {
    const weightCheck = validateWeights(input.components);
    if (!weightCheck.ok) {
      throw badRequest(`Active component weights must total 100 (got ${weightCheck.total}).`);
    }

    const owner = await this.db.user.findUnique({ where: { id: input.ownerId } });
    if (!owner) {
      throw notFound("Owner not found.");
    }

    const existing = await this.db.plan.findUnique({
      where: { ownerId_year: { ownerId: input.ownerId, year: input.year } },
    });
    if (existing) {
      throw conflict("A plan already exists for this user and year.");
    }

    for (const entry of input.entries) {
      if (entry.managerId === input.ownerId) {
        throw badRequest("Tagged manager cannot be the plan owner.");
      }
      const objectivesError = assertObjectivesValid(entry.objectives);
      if (objectivesError) {
        throw badRequest(objectivesError);
      }
    }

    const status = input.lock ? applyTransition("DRAFT", "LOCK") : "DRAFT";

    const plan = await this.db.$transaction(async (tx) => {
      const created = await tx.plan.create({
        data: {
          ownerId: input.ownerId,
          year: input.year,
          status,
          createdById: actorId,
          components: {
            create: input.components.map((component) => ({
              type: component.type,
              enabled: component.enabled,
              weight: component.enabled ? component.weight : 0,
              lockState: "LOCKED",
            })),
          },
        },
        include: { components: true },
      });

      const componentByType = new Map(created.components.map((c) => [c.type, c]));
      for (const [index, entry] of input.entries.entries()) {
        const component = componentByType.get(entry.type);
        if (!component || !component.enabled) {
          throw badRequest(`Component ${entry.type} is not enabled.`);
        }
        await tx.planEntry.create({
          data: {
            componentId: component.id,
            title: entry.title,
            managerId: entry.managerId,
            dueDate: new Date(entry.dueDate),
            sortOrder: index,
            objectives: objectivesCreateData(entry.objectives),
          },
        });
      }

      await tx.changeLog.create({
        data: {
          planId: created.id,
          actorId,
          action: input.lock ? "PLAN_CREATED_AND_LOCKED" : "PLAN_DRAFT_CREATED",
          metadata: { ownerId: input.ownerId, year: input.year },
        },
      });

      return created;
    });

    return this.getById(plan.id);
  }

  async updateDraft(
    actorId: string,
    planId: string,
    input: { components?: ComponentInput[]; entries?: EntryInput[] },
  ) {
    const plan = await this.db.plan.findUnique({
      where: { id: planId },
      include: { components: true },
    });
    if (!plan) {
      throw notFound("Plan not found.");
    }
    if (plan.status !== "DRAFT") {
      throw badRequest("Only draft plans can be edited in the wizard.");
    }

    if (input.components) {
      const weightCheck = validateWeights(input.components);
      if (!weightCheck.ok) {
        throw badRequest(`Active component weights must total 100 (got ${weightCheck.total}).`);
      }
    }

    await this.db.$transaction(async (tx) => {
      if (input.components) {
        for (const component of input.components) {
          await tx.planComponent.update({
            where: { planId_type: { planId, type: component.type } },
            data: {
              enabled: component.enabled,
              weight: component.enabled ? component.weight : 0,
            },
          });
        }
      }

      if (input.entries) {
        const components = await tx.planComponent.findMany({ where: { planId } });
        await tx.planEntry.deleteMany({
          where: { componentId: { in: components.map((c) => c.id) } },
        });
        const byType = new Map(components.map((c) => [c.type, c]));
        for (const [index, entry] of input.entries.entries()) {
          if (entry.managerId === plan.ownerId) {
            throw badRequest("Tagged manager cannot be the plan owner.");
          }
          const objectivesError = assertObjectivesValid(entry.objectives);
          if (objectivesError) {
            throw badRequest(objectivesError);
          }
          const component = byType.get(entry.type);
          if (!component?.enabled) {
            throw badRequest(`Component ${entry.type} is not enabled.`);
          }
          await tx.planEntry.create({
            data: {
              componentId: component.id,
              title: entry.title,
              managerId: entry.managerId,
              dueDate: new Date(entry.dueDate),
              sortOrder: index,
              objectives: objectivesCreateData(entry.objectives),
            },
          });
        }
      }

      await tx.changeLog.create({
        data: {
          planId,
          actorId,
          action: "PLAN_DRAFT_UPDATED",
        },
      });
    });

    return this.getById(planId);
  }

  async lock(actorId: string, planId: string) {
    const plan = await this.db.plan.findUnique({ where: { id: planId } });
    if (!plan) {
      throw notFound("Plan not found.");
    }
    const next = applyTransition(plan.status, "LOCK");
    await this.db.$transaction([
      this.db.plan.update({ where: { id: planId }, data: { status: next } }),
      this.db.changeLog.create({
        data: { planId, actorId, action: "PLAN_LOCKED" },
      }),
    ]);
    return this.getById(planId);
  }

  async previousYearTemplate(ownerId: string, year: number) {
    const previous = await this.db.plan.findUnique({
      where: { ownerId_year: { ownerId, year: year - 1 } },
      include: { components: true },
    });
    if (!previous) {
      return null;
    }
    return previous.components.map((c) => ({
      type: c.type,
      enabled: c.enabled,
      weight: c.weight,
    }));
  }
}
