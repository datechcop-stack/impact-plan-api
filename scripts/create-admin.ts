import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { isPasswordValid } from "../src/domain/passwords.js";
import { hashPassword } from "../src/lib/crypto.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const email = arg("email") ?? process.env.ADMIN_EMAIL;
  const password = arg("password") ?? process.env.ADMIN_PASSWORD;
  const fullName = arg("name") ?? process.env.ADMIN_NAME ?? "Impact Plan Admin";
  const jobTitle = arg("title") ?? process.env.ADMIN_JOB_TITLE ?? "Administrator";

  if (!email || !password) {
    console.error(`Usage:
  pnpm create-admin --email you@org.com --password 'YourPass1!' --name 'Ada Okonkwo'

Or set ADMIN_EMAIL / ADMIN_PASSWORD (/ ADMIN_NAME) in the environment.`);
    process.exit(1);
  }

  if (!isPasswordValid(password)) {
    console.error("Password must be at least 10 characters and include a number and a symbol.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {
      fullName,
      jobTitle,
      role: "ADMIN",
      authMethod: "PASSWORD",
      passwordHash,
      status: "ACTIVE",
      activatedAt: new Date(),
    },
    create: {
      email: email.toLowerCase(),
      fullName,
      jobTitle,
      role: "ADMIN",
      authMethod: "PASSWORD",
      passwordHash,
      status: "ACTIVE",
      activatedAt: new Date(),
    },
  });

  console.log(`Admin ready: ${user.email} (${user.fullName})`);
  console.log("Sign in at /sign-in — you will be sent to /admin.");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
