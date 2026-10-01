import "dotenv/config";
import { PrismaClient, type ComponentType } from "@prisma/client";
import { hashPassword } from "../src/lib/crypto.js";

const prisma = new PrismaClient();
const YEAR = 2026;

async function upsertUser(input: {
  email: string;
  fullName: string;
  jobTitle: string;
  role?: "ADMIN" | "STAFF";
  authMethod?: "PASSWORD" | "OTP" | "UNSET";
  password?: string;
  lineManagerEmail?: string;
  status?: "ACTIVE" | "INVITED";
}) {
  const lineManager = input.lineManagerEmail
    ? await prisma.user.findUnique({ where: { email: input.lineManagerEmail } })
    : null;
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  return prisma.user.upsert({
    where: { email: input.email },
    update: {
      fullName: input.fullName,
      jobTitle: input.jobTitle,
      role: input.role ?? "STAFF",
      authMethod: input.authMethod ?? "PASSWORD",
      passwordHash: passwordHash ?? undefined,
      lineManagerId: lineManager?.id ?? null,
      status: input.status ?? "ACTIVE",
      activatedAt: input.status === "INVITED" ? null : new Date("2026-01-05"),
    },
    create: {
      email: input.email,
      fullName: input.fullName,
      jobTitle: input.jobTitle,
      role: input.role ?? "STAFF",
      authMethod: input.authMethod ?? "PASSWORD",
      passwordHash,
      lineManagerId: lineManager?.id ?? null,
      status: input.status ?? "ACTIVE",
      activatedAt: input.status === "INVITED" ? null : new Date("2026-01-05"),
    },
  });
}

async function ensurePlan(input: {
  ownerEmail: string;
  createdByEmail: string;
  status: "LOCKED" | "IN_REVIEW" | "FINALIZED" | "REVIEW_OPEN";
  weights: Record<ComponentType, number>;
  entries: Array<{
    type: ComponentType;
    title: string;
    objective: string;
    successCriteria: string;
    managerEmail: string;
    dueDate: string;
    selfAssessment?: {
      result: "ACHIEVED" | "PARTLY" | "NOT";
      resultText: string;
      evidenceUrl?: string;
    };
    pmReview?: { score: number; comment: string; reviewerEmail: string };
  }>;
  lineManagerComment?: string;
  finalScore?: number;
}) {
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: input.ownerEmail } });
  const createdBy = await prisma.user.findUniqueOrThrow({
    where: { email: input.createdByEmail },
  });

  const existing = await prisma.plan.findUnique({
    where: { ownerId_year: { ownerId: owner.id, year: YEAR } },
  });
  if (existing) {
    await prisma.plan.delete({ where: { id: existing.id } });
  }

  const plan = await prisma.plan.create({
    data: {
      ownerId: owner.id,
      year: YEAR,
      status: input.status,
      createdById: createdBy.id,
      submittedAt:
        input.status === "IN_REVIEW" || input.status === "FINALIZED"
          ? new Date("2026-12-09")
          : null,
      finalizedAt: input.status === "FINALIZED" ? new Date("2026-12-20") : null,
      lineManagerComment: input.lineManagerComment,
      finalScore: input.finalScore,
      components: {
        create: (Object.keys(input.weights) as ComponentType[]).map((type) => ({
          type,
          enabled: true,
          weight: input.weights[type],
          lockState: "LOCKED",
        })),
      },
    },
    include: { components: true },
  });

  const byType = new Map(plan.components.map((c) => [c.type, c]));
  for (const [index, entry] of input.entries.entries()) {
    const manager = await prisma.user.findUniqueOrThrow({
      where: { email: entry.managerEmail },
    });
    const component = byType.get(entry.type)!;
    const created = await prisma.planEntry.create({
      data: {
        componentId: component.id,
        title: entry.title,
        objective: entry.objective,
        successCriteria: entry.successCriteria,
        managerId: manager.id,
        dueDate: new Date(entry.dueDate),
        sortOrder: index,
      },
    });
    if (entry.selfAssessment) {
      await prisma.selfAssessment.create({
        data: {
          entryId: created.id,
          result: entry.selfAssessment.result,
          resultText: entry.selfAssessment.resultText,
          evidenceUrl: entry.selfAssessment.evidenceUrl,
        },
      });
    }
    if (entry.pmReview) {
      const reviewer = await prisma.user.findUniqueOrThrow({
        where: { email: entry.pmReview.reviewerEmail },
      });
      await prisma.pmReview.create({
        data: {
          entryId: created.id,
          reviewerId: reviewer.id,
          score: entry.pmReview.score,
          comment: entry.pmReview.comment,
          status: "REVIEWED",
          reviewedAt: new Date("2026-12-12"),
        },
      });
    }
  }

  await prisma.changeLog.create({
    data: {
      planId: plan.id,
      actorId: createdBy.id,
      action: "PLAN_CREATED_AND_LOCKED",
      createdAt: new Date("2026-01-12"),
    },
  });
}

async function main(): Promise<void> {
  const admin = await upsertUser({
    email: "admin@devafrique.com",
    fullName: "Ada Okonkwo",
    jobTitle: "People & Operations",
    role: "ADMIN",
    password: "AdminPass1!",
  });

  await upsertUser({
    email: "n.eze@devafrique.com",
    fullName: "Ngozi Eze",
    jobTitle: "Director of Programmes",
    password: "StaffPass1!",
  });

  await upsertUser({
    email: "t.bello@devafrique.com",
    fullName: "Tunde Bello",
    jobTitle: "Senior Programme Manager",
    password: "StaffPass1!",
    lineManagerEmail: "n.eze@devafrique.com",
  });

  await upsertUser({
    email: "c.okafor@devafrique.com",
    fullName: "Chidi Okafor",
    jobTitle: "Product Lead",
    password: "StaffPass1!",
    lineManagerEmail: "n.eze@devafrique.com",
  });
  await upsertUser({
    email: "f.musa@devafrique.com",
    fullName: "Fatima Musa",
    jobTitle: "GIS Lead",
    password: "StaffPass1!",
    lineManagerEmail: "n.eze@devafrique.com",
  });
  await upsertUser({
    email: "k.adeyemi@devafrique.com",
    fullName: "Kemi Adeyemi",
    jobTitle: "Learning Lead",
    password: "StaffPass1!",
    lineManagerEmail: "n.eze@devafrique.com",
  });

  await upsertUser({
    email: "a.obi@devafrique.com",
    fullName: "Amaka Obi",
    jobTitle: "Programme Associate",
    password: "StaffPass1!",
    authMethod: "OTP",
    lineManagerEmail: "t.bello@devafrique.com",
  });
  await upsertUser({
    email: "s.ajayi@devafrique.com",
    fullName: "Seun Ajayi",
    jobTitle: "GIS Analyst",
    password: "StaffPass1!",
    lineManagerEmail: "t.bello@devafrique.com",
  });
  await upsertUser({
    email: "i.nwosu@devafrique.com",
    fullName: "Ifeoma Nwosu",
    jobTitle: "M&E Officer",
    authMethod: "UNSET",
    status: "INVITED",
    lineManagerEmail: "t.bello@devafrique.com",
  });
  await upsertUser({
    email: "m.garba@devafrique.com",
    fullName: "Musa Garba",
    jobTitle: "Research Assistant",
    password: "StaffPass1!",
    authMethod: "OTP",
    lineManagerEmail: "t.bello@devafrique.com",
  });
  await upsertUser({
    email: "h.yusuf@devafrique.com",
    fullName: "Halima Yusuf",
    jobTitle: "Research Officer",
    authMethod: "UNSET",
    status: "INVITED",
    lineManagerEmail: "n.eze@devafrique.com",
  });

  await prisma.reviewCycle.upsert({
    where: { year: YEAR },
    update: {
      windowOpens: new Date("2026-12-01"),
      selfAssessmentDeadline: new Date("2026-12-15"),
      pmScoringDeadline: new Date("2026-12-22"),
      finalizeDeadline: new Date("2026-12-31"),
      remindOnOpen: true,
      remindBeforeDeadlines: true,
      weeklyLmSummary: false,
      status: "SCHEDULED",
    },
    create: {
      year: YEAR,
      windowOpens: new Date("2026-12-01"),
      selfAssessmentDeadline: new Date("2026-12-15"),
      pmScoringDeadline: new Date("2026-12-22"),
      finalizeDeadline: new Date("2026-12-31"),
      audience: "ALL_WITH_PLAN",
      remindOnOpen: true,
      remindBeforeDeadlines: true,
      weeklyLmSummary: false,
      status: "SCHEDULED",
    },
  });

  await ensurePlan({
    ownerEmail: "t.bello@devafrique.com",
    createdByEmail: admin.email,
    status: "LOCKED",
    weights: { PROJECTS: 50, BD: 20, TECH_PERSONAL: 20, COP: 10 },
    entries: [
      {
        type: "PROJECTS",
        title: "Policy Vault: onboard 3 new countries",
        objective: "Expand Policy Vault coverage to Ghana, Kenya and Zambia.",
        successCriteria: "300+ policies uploaded and verified per country by Q4.",
        managerEmail: "c.okafor@devafrique.com",
        dueDate: "2026-11-30",
      },
      {
        type: "PROJECTS",
        title: "Kaduna WASH geospatial mapping",
        objective: "Map water points across 5 LGAs to guide partner investment.",
        successCriteria: "Validated dataset and dashboard handed over to the state ministry.",
        managerEmail: "f.musa@devafrique.com",
        dueDate: "2026-09-15",
      },
      {
        type: "BD",
        title: "Secure two new donor partnerships",
        objective: "Grow funding for climate and agriculture work in the North.",
        successCriteria: "Two signed agreements, combined value of NGN 150m.",
        managerEmail: "n.eze@devafrique.com",
        dueDate: "2026-10-31",
      },
      {
        type: "TECH_PERSONAL",
        title: "Complete advanced GIS certification",
        objective: "Strengthen geospatial analysis skills for programme design.",
        successCriteria: "Certificate earned and one internal knowledge session delivered.",
        managerEmail: "n.eze@devafrique.com",
        dueDate: "2026-06-30",
      },
      {
        type: "COP",
        title: "Lead the M&E Community of Practice",
        objective: "Run regular peer-learning sessions for M&E staff.",
        successCriteria: "6 sessions held with an average of 20 attendees.",
        managerEmail: "k.adeyemi@devafrique.com",
        dueDate: "2026-12-15",
      },
    ],
  });

  await ensurePlan({
    ownerEmail: "a.obi@devafrique.com",
    createdByEmail: admin.email,
    status: "IN_REVIEW",
    weights: { PROJECTS: 40, BD: 10, TECH_PERSONAL: 30, COP: 20 },
    entries: [
      {
        type: "PROJECTS",
        title: "Policy Vault user research, Ghana",
        objective:
          "Understand how Ghanaian civil servants search for policy documents, to shape the Ghana launch.",
        successCriteria:
          "15 user interviews completed and a findings report adopted by the product team.",
        managerEmail: "t.bello@devafrique.com",
        dueDate: "2026-08-31",
        selfAssessment: {
          result: "ACHIEVED",
          resultText:
            "Completed 18 interviews across Accra and Kumasi. Four recommendations are in the Ghana launch backlog.",
          evidenceUrl: "https://example.com/ghana-research",
        },
        pmReview: {
          score: 85,
          comment: "Exceeded the interview target; involve product earlier.",
          reviewerEmail: "t.bello@devafrique.com",
        },
      },
      {
        type: "PROJECTS",
        title: "Kaduna data collection coordination",
        objective: "Coordinate enumerators across 5 LGAs on schedule.",
        successCriteria: "Validated field dataset delivered.",
        managerEmail: "t.bello@devafrique.com",
        dueDate: "2026-09-30",
        selfAssessment: {
          result: "ACHIEVED",
          resultText: "Coordinated 12 enumerators across 5 LGAs, on schedule.",
        },
        pmReview: {
          score: 90,
          comment: "Excellent field coordination and data quality.",
          reviewerEmail: "t.bello@devafrique.com",
        },
      },
      {
        type: "BD",
        title: "Draft 2 concept notes for WASH funders",
        objective: "Grow WASH funding pipeline.",
        successCriteria: "Two concept notes submitted.",
        managerEmail: "t.bello@devafrique.com",
        dueDate: "2026-10-15",
        selfAssessment: {
          result: "PARTLY",
          resultText: "One concept note submitted; the second is in draft.",
        },
        pmReview: {
          score: 60,
          comment: "Good first note; plan earlier for deadlines.",
          reviewerEmail: "t.bello@devafrique.com",
        },
      },
      {
        type: "TECH_PERSONAL",
        title: "Complete M&E fundamentals course",
        objective: "Build core M&E skills.",
        successCriteria: "Course completed and applied on a live project.",
        managerEmail: "k.adeyemi@devafrique.com",
        dueDate: "2026-07-31",
        selfAssessment: {
          result: "ACHIEVED",
          resultText: "Course completed in July; applied the logframe method on Kaduna.",
        },
        pmReview: {
          score: 80,
          comment: "Clear use of new skills in live project work.",
          reviewerEmail: "k.adeyemi@devafrique.com",
        },
      },
      {
        type: "COP",
        title: "Contribute to the Policy CoP",
        objective: "Share learning with peers.",
        successCriteria: "Present at planned CoP sessions.",
        managerEmail: "k.adeyemi@devafrique.com",
        dueDate: "2026-12-01",
        selfAssessment: {
          result: "PARTLY",
          resultText: "Presented at 2 of 4 planned sessions.",
        },
        pmReview: {
          score: 65,
          comment: "Valuable when present; aim for all sessions.",
          reviewerEmail: "k.adeyemi@devafrique.com",
        },
      },
    ],
  });

  await ensurePlan({
    ownerEmail: "m.garba@devafrique.com",
    createdByEmail: admin.email,
    status: "FINALIZED",
    weights: { PROJECTS: 40, BD: 20, TECH_PERSONAL: 20, COP: 20 },
    finalScore: 82,
    lineManagerComment: "Strong delivery across research and CoP contributions.",
    entries: [
      {
        type: "PROJECTS",
        title: "Literature review on climate adaptation",
        objective: "Synthesize evidence for programme design.",
        successCriteria: "Review memo adopted by programme team.",
        managerEmail: "t.bello@devafrique.com",
        dueDate: "2026-06-30",
        selfAssessment: {
          result: "ACHIEVED",
          resultText: "Memo adopted and used in two proposals.",
        },
        pmReview: {
          score: 85,
          comment: "Clear synthesis and timely delivery.",
          reviewerEmail: "t.bello@devafrique.com",
        },
      },
      {
        type: "BD",
        title: "Support two proposal annexes",
        objective: "Strengthen BD packaging.",
        successCriteria: "Two annexes submitted with proposals.",
        managerEmail: "t.bello@devafrique.com",
        dueDate: "2026-09-30",
        selfAssessment: {
          result: "ACHIEVED",
          resultText: "Delivered annexes for climate and WASH proposals.",
        },
        pmReview: {
          score: 80,
          comment: "Reliable support under tight deadlines.",
          reviewerEmail: "t.bello@devafrique.com",
        },
      },
      {
        type: "TECH_PERSONAL",
        title: "Complete research methods workshop",
        objective: "Improve qualitative methods.",
        successCriteria: "Workshop certificate and applied notes.",
        managerEmail: "k.adeyemi@devafrique.com",
        dueDate: "2026-05-31",
        selfAssessment: {
          result: "ACHIEVED",
          resultText: "Completed workshop and applied coding framework.",
        },
        pmReview: {
          score: 82,
          comment: "Good application of methods.",
          reviewerEmail: "k.adeyemi@devafrique.com",
        },
      },
      {
        type: "COP",
        title: "Co-host research reading group",
        objective: "Build peer learning habit.",
        successCriteria: "Four sessions hosted.",
        managerEmail: "k.adeyemi@devafrique.com",
        dueDate: "2026-11-30",
        selfAssessment: {
          result: "PARTLY",
          resultText: "Hosted three of four planned sessions.",
        },
        pmReview: {
          score: 78,
          comment: "Strong facilitation; protect the schedule.",
          reviewerEmail: "k.adeyemi@devafrique.com",
        },
      },
    ],
  });

  console.log("Seed complete.");
  console.log("Admin: admin@devafrique.com / AdminPass1!");
  console.log("Staff (password): t.bello@devafrique.com / StaffPass1!");
  console.log("OTP users need an OTP at sign-in (a.obi@devafrique.com, m.garba@devafrique.com).");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
