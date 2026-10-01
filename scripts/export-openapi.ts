import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

async function exportOpenApi(): Promise<void> {
  const env = loadEnv({
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ?? "postgresql://impact:impact@localhost:5432/impact_plan",
    SESSION_SECRET: process.env.SESSION_SECRET ?? "dev-session-secret-at-least-32-characters-long",
  });
  const app = await buildApp(env);
  await app.ready();
  const spec = app.swagger();
  const outPath = resolve(process.cwd(), "openapi.json");
  writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  await app.close();
  console.log(`Wrote ${outPath}`);
}

void exportOpenApi();
