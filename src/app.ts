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

  await app.register(healthRoutes);
  await app.register(authRoutes, { env });
  await app.register(usersRoutes, { env });
  await app.register(adminOverviewRoutes, { env });
  await app.register(plansRoutes, { env });
  await app.register(editRequestsRoutes, { env });
  await app.register(reviewCycleRoutes, { env });
  await app.register(staffPlanRoutes, { env });
  await app.register(pmRoutes, { env });

  app.get("/openapi.json", async () => app.swagger());

  return app;
}
