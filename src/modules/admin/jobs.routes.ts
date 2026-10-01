import type { FastifyPluginAsync } from "fastify";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { createMailer } from "../emails/mailer.js";
import { requireAdmin } from "../auth/require-admin.js";
import { requireCsrf } from "../auth/auth.routes.js";
import { ReviewScheduler } from "../../jobs/review-scheduler.js";

export const jobsRoutes: FastifyPluginAsync<{ env: Env }> = async (app, opts) => {
  const scheduler = new ReviewScheduler(prisma, opts.env, createMailer(opts.env));

  app.post(
    "/admin/jobs/run-daily",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async () => scheduler.runDaily(),
  );
};
