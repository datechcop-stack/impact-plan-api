import type { FastifyReply, FastifyRequest } from "fastify";
import { forbidden } from "../../lib/errors.js";
import { authenticateRequest } from "../auth/auth.routes.js";

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticateRequest(request, reply);
  if (request.authUser?.role !== "ADMIN") {
    throw forbidden("Admin access required.");
  }
}
