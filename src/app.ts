import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Env } from "./env.js";
import { AppError, toErrorEnvelope } from "./lib/errors.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { adminOverviewRoutes } from "./modules/admin/overview.routes.js";
import { plansRoutes } from "./modules/plans/plans.routes.js";
import { editRequestsRoutes } from "./modules/edit-requests/edit-requests.routes.js";
import { reviewCycleRoutes } from "./modules/review-cycle/review-cycle.routes.js";
import { staffPlanRoutes } from "./modules/staff-plan/staff-plan.routes.js";
import { pmRoutes } from "./modules/pm/pm.routes.js";
import { lineManagerRoutes } from "./modules/line-manager/lm.routes.js";
import { jobsRoutes } from "./modules/admin/jobs.routes.js";
import { navRoutes } from "./modules/nav/nav.routes.js";

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "development"
          ? {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "HH:MM:ss" },
            }
          : undefined,
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
    credentials: true,
  });
  await app.register(helmet, { global: true });
  await app.register(cookie, {
    secret: env.SESSION_SECRET,
  });
  await app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Impact Plan API",
        description: "Annual goal-setting and year-end review API",
        version: "0.1.0",
      },
      servers: [{ url: env.API_URL }],
      tags: [
        { name: "Health" },
        { name: "Auth" },
        { name: "Admin" },
        { name: "Plans" },
        { name: "PM" },
        { name: "LineManager" },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(toErrorEnvelope(error));
    }

    if (error instanceof ZodError) {
      return reply
        .status(422)
        .send(
          toErrorEnvelope(
            new AppError("VALIDATION_ERROR", "Validation failed", 422, error.flatten()),
          ),
        );
    }

    app.log.error(error);
    return reply
      .status(500)
      .send(toErrorEnvelope(new AppError("INTERNAL", "Internal server error", 500)));
  });

  // Ops / DX stay unversioned; product routes live under /v1.
  // Also mount /api/v1 so misconfigured clients that keep the web proxy
  // prefix still hit the same handlers (avoids POST:/api/v1/... 404s).
  await app.register(healthRoutes);

  const registerV1Routes = async (v1: FastifyInstance) => {
    await v1.register(authRoutes, { env });
    await v1.register(usersRoutes, { env });
    await v1.register(adminOverviewRoutes, { env });
    await v1.register(plansRoutes, { env });
    await v1.register(editRequestsRoutes, { env });
    await v1.register(reviewCycleRoutes, { env });
    await v1.register(staffPlanRoutes, { env });
    await v1.register(pmRoutes, { env });
    await v1.register(lineManagerRoutes, { env });
    await v1.register(jobsRoutes, { env });
    await v1.register(navRoutes, { env });
  };

  await app.register(registerV1Routes, { prefix: "/v1" });
  await app.register(registerV1Routes, { prefix: "/api/v1" });

  app.get("/openapi.json", async () => app.swagger());

  return app;
}
