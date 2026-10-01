import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { Env } from "../../env.js";
import { hashToken } from "../../domain/otp.js";
import { unauthorized } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { createMailer } from "../emails/mailer.js";
import { AuthRepository } from "./auth.repository.js";
import {
  activatePasswordSchema,
  chooseMethodSchema,
  forgotPasswordResetSchema,
  inviteLookupSchema,
  loginPasswordSchema,
  requestOtpSchema,
  verifyOtpSchema,
} from "./auth.schemas.js";
import { AuthService } from "./auth.service.js";

const SESSION_COOKIE = "ip_session";
const CSRF_COOKIE = "ip_csrf";

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  role: "ADMIN" | "STAFF";
  authMethod: "UNSET" | "PASSWORD" | "OTP";
  status: "INVITED" | "ACTIVE" | "DISABLED";
};

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
    sessionId?: string;
  }
}

function setSessionCookie(reply: FastifyReply, env: Env, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: env.COOKIE_SECURE,
    expires: expiresAt,
  });
}

function setCsrfCookie(reply: FastifyReply, env: Env) {
  const token = randomBytes(24).toString("base64url");
  reply.setCookie(CSRF_COOKIE, token, {
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    secure: env.COOKIE_SECURE,
  });
  return token;
}

function clearAuthCookies(reply: FastifyReply, env: Env) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  reply.clearCookie(CSRF_COOKIE, { path: "/" });
  if (env.COOKIE_SECURE) {
    // no-op placeholder for typed env use
  }
}

export function createAuthService(env: Env): AuthService {
  return new AuthService(new AuthRepository(prisma), env, createMailer(env));
}

export async function authenticateRequest(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    throw unauthorized();
  }
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw unauthorized();
  }
  if (session.user.status !== "ACTIVE") {
    throw unauthorized();
  }
  request.sessionId = session.id;
  request.authUser = {
    id: session.user.id,
    email: session.user.email,
    fullName: session.user.fullName,
    role: session.user.role,
    authMethod: session.user.authMethod,
    status: session.user.status,
  };
}

export function requireCsrf(request: FastifyRequest): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return;
  }
  const cookieToken = request.cookies[CSRF_COOKIE];
  const headerToken = request.headers["x-csrf-token"];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    throw unauthorized("Invalid CSRF token.");
  }
}

export const authRoutes: FastifyPluginAsync<{ env: Env }> = async (app, opts) => {
  const service = createAuthService(opts.env);

  app.get("/auth/csrf", async (_request, reply) => {
    const token = setCsrfCookie(reply, opts.env);
    return { csrfToken: token };
  });

  app.get("/auth/invite/:token", async (request) => {
    const { token } = inviteLookupSchema.parse({
      token: (request.params as { token: string }).token,
    });
    return service.lookupInvite(token);
  });

  app.post("/auth/invite/choose-method", async (request) => {
    const body = chooseMethodSchema.parse(request.body);
    return service.chooseMethod(body.token, body.method);
  });

  app.post("/auth/activate/password", async (request, reply) => {
    const body = activatePasswordSchema.parse(request.body);
    const result = await service.activateWithPassword(
      body.token,
      body.password,
      body.confirmPassword,
    );
    setSessionCookie(reply, opts.env, result.sessionToken, result.expiresAt);
    setCsrfCookie(reply, opts.env);
    return { user: result.user };
  });

  app.post("/auth/otp/request", async (request) => {
    const body = requestOtpSchema.parse(request.body);
    return service.requestOtp(body);
  });

  app.post("/auth/otp/verify", async (request, reply) => {
    const body = verifyOtpSchema.parse(request.body);
    const result = await service.verifyOtp(body);
    if ("sessionToken" in result) {
      setSessionCookie(reply, opts.env, result.sessionToken, result.expiresAt);
      setCsrfCookie(reply, opts.env);
      return { user: result.user };
    }
    return result;
  });

  app.post("/auth/login/password", async (request, reply) => {
    const body = loginPasswordSchema.parse(request.body);
    const result = await service.loginWithPassword(body.email, body.password);
    setSessionCookie(reply, opts.env, result.sessionToken, result.expiresAt);
    setCsrfCookie(reply, opts.env);
    return { user: result.user };
  });

  app.post("/auth/forgot-password/request", async (request) => {
    const body = requestOtpSchema
      .pick({ email: true })
      .extend({ email: loginPasswordSchema.shape.email })
      .parse(request.body);
    await service.requestOtp({ purpose: "PASSWORD_RESET", email: body.email });
    return { message: service.getGenericMessage() };
  });

  app.post("/auth/forgot-password/reset", async (request) => {
    const body = forgotPasswordResetSchema.parse(request.body);
    await service.resetPassword(body.email, body.code, body.password, body.confirmPassword);
    return { message: service.getGenericMessage() };
  });

  app.get("/auth/me", { preHandler: authenticateRequest }, async (request) => {
    return service.me(request.authUser!.id);
  });

  app.post(
    "/auth/logout",
    { preHandler: [authenticateRequest, async (req) => requireCsrf(req)] },
    async (request, reply) => {
      await service.logout(request.sessionId!);
      clearAuthCookies(reply, opts.env);
      return { ok: true };
    },
  );

  if (opts.env.DEV_SHORTCUTS && opts.env.NODE_ENV !== "production") {
    app.post("/auth/dev/login-admin", async (_request, reply) => {
      const admin = await prisma.user.findFirst({
        where: { role: "ADMIN", status: "ACTIVE" },
      });
      if (!admin) {
        throw unauthorized("No admin user seeded yet.");
      }
      const result = await service.issueSession(admin.id);
      setSessionCookie(reply, opts.env, result.sessionToken, result.expiresAt);
      setCsrfCookie(reply, opts.env);
      return { user: result.user };
    });
  }
};
