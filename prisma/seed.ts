import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/crypto.js";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const adminEmail = "admin@devafrique.com";
  const passwordHash = await hashPassword("AdminPass1!");

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      fullName: "Ada Okonkwo",
      jobTitle: "People & Operations",
      role: "ADMIN",
      authMethod: "PASSWORD",
      status: "ACTIVE",
      passwordHash,
      activatedAt: new Date(),
    },
    create: {
      email: adminEmail,
      fullName: "Ada Okonkwo",
      jobTitle: "People & Operations",
      role: "ADMIN",
      authMethod: "PASSWORD",
      status: "ACTIVE",
      passwordHash,
      activatedAt: new Date(),
    },
  });

  const year = 2026;
  await prisma.reviewCycle.upsert({
    where: { year },
    update: {},
    create: {
      year,
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

  console.log(`Seeded admin ${admin.email} / AdminPass1!`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
