import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        tags: ["Health"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              service: { type: "string" },
              timestamp: { type: "string" },
            },
            required: ["status", "service", "timestamp"],
          },
        },
      },
    },
    async () => ({
      status: "ok",
      service: "impact-plan-api",
      timestamp: new Date().toISOString(),
    }),
  );
};
