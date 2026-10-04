import type { FastifyPluginAsync } from "fastify";
import type { Env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { createMailer } from "../emails/mailer.js";
import { requireAdmin } from "../auth/require-admin.js";
import { authenticateRequest, requireCsrf } from "../auth/auth.routes.js";
import { inviteUserSchema, listUsersQuerySchema, updateUserSchema } from "./users.schemas.js";
import { UsersService } from "./users.service.js";

export const usersRoutes: FastifyPluginAsync<{ env: Env }> = async (app, opts) => {
  const service = new UsersService(prisma, opts.env, createMailer(opts.env));

  app.get("/admin/users", { preHandler: requireAdmin }, async (request) =>
    service.list(listUsersQuerySchema.parse(request.query)),
  );

  app.post(
    "/admin/users",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const body = inviteUserSchema.parse(request.body);
      return service.invite(request.authUser!.id, body);
    },
  );

  app.patch(
    "/admin/users/:id",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = updateUserSchema.parse(request.body);
      return service.update(id, body);
    },
  );

  app.post(
    "/admin/users/:id/resend-invite",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return service.resendInvite(request.authUser!.id, id);
    },
  );

  app.delete(
    "/admin/users/:id",
    {
      preHandler: [
        requireAdmin,
        async (req) => {
          requireCsrf(req);
        },
      ],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return service.remove(request.authUser!.id, id);
    },
  );

  app.get("/users/lookup", { preHandler: authenticateRequest }, async (request) => {
    const q = String((request.query as { q?: string }).q ?? "");
    return service.lookup(q);
  });
};
