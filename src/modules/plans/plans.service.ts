import type { ComponentType, PrismaClient } from "@prisma/client";
import { applyTransition } from "../../domain/lifecycle.js";
import {
  assertObjectivesValid,
  entryObjectivesInclude,
  objectivesCreateData,
  type ObjectiveInput,
} from "../../domain/objectives.js";
import {
  assertObjectivesValidForDraft,
  componentsForOwner,
  entriesForDraftSave,
  type DraftEntryInput,
} from "../../domain/plan-component-template.js";
import { validateWeights } from "../../domain/scoring.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import type { Mailer } from "../emails/mailer.js";
import { emailDistinct, firstName, reviewStepEmailHtml } from "../emails/mailer.js";
import { enrollPlanInOpenYearEndWindow } from "../review-cycle/enroll-plan.js";

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

function validateEntriesForLock(entries: EntryInput[]) {
  if (entries.length === 0) {
    throw badRequest("Add at least one plan entry before locking.");
  }
  for (const entry of entries) {
    const objectivesError = assertObjectivesValid(entry.objectives);
    if (objectivesError) {
      throw badRequest(objectivesError);
    }
    if (
      entry.objectives.some(
        (objective) =>
          objective.text.trim() === "Draft objective" ||
          objective.successCriteria.some((c) => c.text.trim() === "To be completed"),
      )
    ) {
      throw badRequest("Complete every objective and success criterion before locking.");
    }
  }
}

function validateEntriesForDraft(entries: EntryInput[], strictObjectives: boolean) {
  for (const entry of entries) {
    if (strictObjectives) {
      const objectivesError = assertObjectivesValid(entry.objectives);
      if (objectivesError) {
        throw badRequest(objectivesError);
      }
      continue;
    }
    const objectivesError = assertObjectivesValidForDraft(entry.objectives);
    if (objectivesError) {
      throw badRequest(objectivesError);
    }
  }
}

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
      components?: ComponentInput[];
      entries: DraftEntryInput[] | EntryInput[];
      lock: boolean;
    },
  ) {
    const owner = await this.db.user.findUnique({ where: { id: input.ownerId } });
    if (!owner) {
      throw notFound("Owner not found.");
    }

    const components = componentsForOwner(owner.planComponentTemplate, input.components);
    const weightCheck = validateWeights(components);
    if (!weightCheck.ok) {
      throw badRequest(`Active component weights must total 100 (got ${weightCheck.total}).`);
    }

    const normalizedEntries = entriesForDraftSave(
      input.entries as DraftEntryInput[],
      input.year,
      input.ownerId,
    );

    const existing = await this.db.plan.findUnique({
      where: { ownerId_year: { ownerId: input.ownerId, year: input.year } },
    });
    if (existing) {
      throw conflict("A plan already exists for this user and year.");
    }

    for (const entry of normalizedEntries) {
      if (entry.managerId === input.ownerId) {
        throw badRequest("Tagged manager cannot be the plan owner.");
      }
    }
    if (input.lock) {
      validateEntriesForLock(normalizedEntries);
    } else {
      validateEntriesForDraft(normalizedEntries, false);
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
            create: components.map((component) => ({
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
      for (const [index, entry] of normalizedEntries.entries()) {
        const component = componentByType.get(entry.type);
        if (!component || !component.enabled) {
          throw badRequest(`Component ${entry.type} is not enabled.`);
        }
        const objectives = input.lock
          ? entry.objectives
          : entry.objectives.length > 0 &&
              assertObjectivesValidForDraft(entry.objectives) === null &&
              entry.objectives.some((o) => o.text.trim())
            ? entry.objectives.filter((o) => o.text.trim())
            : [{ text: "Draft objective", successCriteria: [{ text: "To be completed" }] }];
        await tx.planEntry.create({
          data: {
            componentId: component.id,
            title: entry.title,
            managerId: entry.managerId,
            dueDate: new Date(entry.dueDate),
            sortOrder: index,
            objectives: objectivesCreateData(objectives),
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

    if (input.lock) {
      await enrollPlanInOpenYearEndWindow(this.db, plan.id, actorId);
    }

    return this.getById(plan.id);
  }

  async updateDraft(
    actorId: string,
    planId: string,
    input: { components?: ComponentInput[]; entries?: DraftEntryInput[] },
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
        const normalizedEntries = entriesForDraftSave(input.entries, plan.year, plan.ownerId);
        validateEntriesForDraft(normalizedEntries, false);
        const components = await tx.planComponent.findMany({ where: { planId } });
        await tx.planEntry.deleteMany({
          where: { componentId: { in: components.map((c) => c.id) } },
        });
        const byType = new Map(components.map((c) => [c.type, c]));
        for (const [index, entry] of normalizedEntries.entries()) {
          if (entry.managerId === plan.ownerId) {
            throw badRequest("Tagged manager cannot be the plan owner.");
          }
          const component = byType.get(entry.type);
          if (!component?.enabled) {
            throw badRequest(`Component ${entry.type} is not enabled.`);
          }
          const objectives =
            entry.objectives.length > 0 &&
            assertObjectivesValidForDraft(entry.objectives) === null &&
            entry.objectives.some((o) => o.text.trim())
              ? entry.objectives.filter((o) => o.text.trim())
              : [{ text: "Draft objective", successCriteria: [{ text: "To be completed" }] }];
          await tx.planEntry.create({
            data: {
              componentId: component.id,
              title: entry.title,
              managerId: entry.managerId,
              dueDate: new Date(entry.dueDate),
              sortOrder: index,
              objectives: objectivesCreateData(objectives as ObjectiveInput[]),
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

  async reassignEntryManager(actorId: string, planId: string, entryId: string, managerId: string) {
    const plan = await this.db.plan.findUnique({ where: { id: planId } });
    if (!plan) {
      throw notFound("Plan not found.");
    }
    if (managerId === plan.ownerId) {
      throw badRequest("Tagged manager cannot be the plan owner.");
    }
    const manager = await this.db.user.findUnique({ where: { id: managerId } });
    if (!manager || manager.status === "DISABLED") {
      throw badRequest("Manager not found.");
    }
    const entry = await this.db.planEntry.findFirst({
      where: { id: entryId, component: { planId } },
    });
    if (!entry) {
      throw notFound("Entry not found.");
    }
    await this.db.$transaction([
      this.db.planEntry.update({
        where: { id: entryId },
        data: { managerId },
      }),
      this.db.changeLog.create({
        data: {
          planId,
          actorId,
          action: "ENTRY_MANAGER_REASSIGNED",
          metadata: { entryId, managerId },
        },
      }),
    ]);
    return this.getById(planId);
  }

  async lock(actorId: string, planId: string) {
    const plan = await this.db.plan.findUnique({
      where: { id: planId },
      include: {
        components: {
          include: {
            entries: {
              include: {
                objectives: { include: { successCriteria: true } },
              },
            },
          },
        },
      },
    });
    if (!plan) {
      throw notFound("Plan not found.");
    }
    const lockEntries = plan.components
      .filter((c) => c.enabled)
      .flatMap((c) =>
        c.entries.map((entry) => ({
          type: c.type,
          title: entry.title,
          managerId: entry.managerId,
          dueDate: entry.dueDate.toISOString().slice(0, 10),
          objectives: entry.objectives.map((objective) => ({
            text: objective.text,
            successCriteria: objective.successCriteria.map((criterion) => ({
              text: criterion.text,
            })),
          })),
        })),
      );
    validateEntriesForLock(lockEntries);
    const next = applyTransition(plan.status, "LOCK");
    await this.db.$transaction([
      this.db.plan.update({ where: { id: planId }, data: { status: next } }),
      this.db.changeLog.create({
        data: { planId, actorId, action: "PLAN_LOCKED" },
      }),
    ]);
    await enrollPlanInOpenYearEndWindow(this.db, planId, actorId);
    return this.getById(planId);
  }

  async reopen(actorId: string, planId: string, mailer?: Mailer) {
    const plan = await this.db.plan.findUnique({
      where: { id: planId },
      include: {
        owner: {
          select: {
            fullName: true,
            email: true,
            lineManager: { select: { fullName: true, email: true } },
          },
        },
        components: {
          where: { enabled: true },
          include: {
            entries: {
              include: { manager: { select: { fullName: true, email: true } } },
            },
          },
        },
      },
    });
    if (!plan) {
      throw notFound("Plan not found.");
    }
    if (plan.status !== "FINALIZED") {
      throw badRequest("Only a finalized plan can be reopened for review.");
    }

    const next = applyTransition(plan.status, "REOPEN");
    await this.db.$transaction([
      this.db.plan.update({
        where: { id: plan.id },
        data: {
          status: next,
          revisionOpen: true,
          employeeFeedbackAt: null,
        },
      }),
      this.db.changeLog.create({
        data: {
          planId: plan.id,
          actorId,
          action: "PLAN_REOPENED",
          metadata: { year: plan.year },
        },
      }),
    ]);

    if (mailer) {
      const managers = plan.components.flatMap((component) =>
        component.entries.map((entry) => entry.manager),
      );
      await emailDistinct(mailer, managers, (manager) => ({
        subject: `Update scores · ${plan.owner.fullName} · Impact Plan ${plan.year}`,
        html: reviewStepEmailHtml({
          firstName: firstName(manager.fullName),
          heading: "A finalized plan was reopened",
          paragraphs: [
            `An administrator reopened ${plan.owner.fullName}'s Impact Plan ${plan.year} for review.`,
            "You can update your scores and comments on the entries where you are the tagged manager.",
          ],
        }),
        text: `${plan.owner.fullName}'s Impact Plan ${plan.year} was reopened. Update your scores and comments.`,
      }));
      if (plan.owner.lineManager) {
        const lineManager = plan.owner.lineManager;
        await emailDistinct(mailer, [lineManager], () => ({
          subject: `Update final review · ${plan.owner.fullName} · Impact Plan ${plan.year}`,
          html: reviewStepEmailHtml({
            firstName: firstName(lineManager.fullName),
            heading: "A finalized plan was reopened",
            paragraphs: [
              `An administrator reopened ${plan.owner.fullName}'s Impact Plan ${plan.year} for review.`,
              "You can update the overall comment and recommendation, then finalize again.",
            ],
          }),
          text: `${plan.owner.fullName}'s Impact Plan ${plan.year} was reopened. Update your comment and recommendation, then finalize again.`,
        }));
      }
    }

    return this.getById(planId);
  }

  async exportYearCsv(year: number): Promise<string> {
    const plans = await this.db.plan.findMany({
      where: { year },
      include: {
        owner: { select: { fullName: true, email: true, jobTitle: true } },
        components: {
          include: {
            entries: {
              include: {
                manager: { select: { fullName: true } },
                selfAssessment: true,
                pmReview: true,
                objectives: { include: { successCriteria: true } },
              },
            },
          },
        },
      },
      orderBy: { owner: { fullName: "asc" } },
    });

    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [
      [
        "Staff",
        "Email",
        "Job title",
        "Plan status",
        "Final score",
        "Line manager comment",
        "Recommendation",
        "Component",
        "Entry title",
        "PM",
        "PM score",
        "PM comment",
        "Self-assessment result",
      ].join(","),
    ];

    for (const plan of plans) {
      for (const component of plan.components.filter((c) => c.enabled)) {
        for (const entry of component.entries) {
          rows.push(
            [
              escape(plan.owner.fullName),
              escape(plan.owner.email),
              escape(plan.owner.jobTitle ?? ""),
              plan.status,
              plan.finalScore?.toString() ?? "",
              escape(plan.lineManagerComment ?? ""),
              escape(plan.recommendation ?? ""),
              component.type,
              escape(entry.title),
              escape(entry.manager.fullName),
              entry.pmReview?.score?.toString() ?? "",
              escape(entry.pmReview?.comment ?? ""),
              entry.selfAssessment?.result ?? "",
            ].join(","),
          );
        }
      }
    }

    return rows.join("\n");
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
