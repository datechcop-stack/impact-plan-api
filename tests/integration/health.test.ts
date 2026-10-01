import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadEnv } from "../../src/env.js";

describe("GET /health", () => {
  it("returns ok", async () => {
    const env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://impact:impact@localhost:5432/impact_plan_test",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      LOG_LEVEL: "error",
    });
    const app = await buildApp(env);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "impact-plan-api",
    });

    await app.close();
  });
});
