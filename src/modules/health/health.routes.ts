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
              apiVersion: { type: "integer" },
              timestamp: { type: "string" },
            },
            required: ["status", "service", "apiVersion", "timestamp"],
          },
        },
      },
    },
    async () => ({
      status: "ok",
      service: "impact-plan-api",
      /** Bumped when breaking route layout changes (e.g. /v1 prefix). */
      apiVersion: 2,
      timestamp: new Date().toISOString(),
    }),
  );
};
