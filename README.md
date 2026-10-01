# Impact Plan API

Backend for Dev-Afrique Impact Plan — annual goal-setting and year-end review.

## Stack

- Node 20 + TypeScript
- Fastify
- PostgreSQL + Prisma
- Zod
- Vitest + Supertest
- Docker Compose (Postgres + Mailpit)

## Quickstart

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- API: http://localhost:4000
- Swagger: http://localhost:4000/docs
- Mailpit: http://localhost:8025

## Scripts

| Script                             | Description                             |
| ---------------------------------- | --------------------------------------- |
| `pnpm dev`                         | Start API in watch mode                 |
| `pnpm build`                       | Compile TypeScript                      |
| `pnpm lint` / `typecheck` / `test` | Quality gates                           |
| `pnpm openapi:export`              | Write `openapi.json` for the web client |

Full architecture, ERD, and permissions matrix land in P7.
