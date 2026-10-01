import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { healthRoutes } from "../../src/modules/health/health.routes.js";

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = Fastify({ logger: false });
    await app.register(healthRoutes);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "impact-plan-api",
    });

    await app.close();
  });
});
