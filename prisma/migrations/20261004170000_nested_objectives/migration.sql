-- CreateTable
CREATE TABLE "public"."PlanObjective" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanObjective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlanSuccessCriterion" (
    "id" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanSuccessCriterion_pkey" PRIMARY KEY ("id")
);

-- Migrate existing flat objective/successCriteria into nested rows
INSERT INTO "public"."PlanObjective" ("id", "entryId", "text", "sortOrder", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  pe.id,
  pe."objective",
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "public"."PlanEntry" pe;

INSERT INTO "public"."PlanSuccessCriterion" ("id", "objectiveId", "text", "sortOrder", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  po.id,
  pe."successCriteria",
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "public"."PlanObjective" po
INNER JOIN "public"."PlanEntry" pe ON pe.id = po."entryId";

-- DropIndex / DropColumn
ALTER TABLE "public"."PlanEntry" DROP COLUMN "objective",
DROP COLUMN "successCriteria";

-- CreateIndex
CREATE INDEX "PlanObjective_entryId_idx" ON "public"."PlanObjective"("entryId");

-- CreateIndex
CREATE INDEX "PlanSuccessCriterion_objectiveId_idx" ON "public"."PlanSuccessCriterion"("objectiveId");

-- AddForeignKey
ALTER TABLE "public"."PlanObjective" ADD CONSTRAINT "PlanObjective_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "public"."PlanEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlanSuccessCriterion" ADD CONSTRAINT "PlanSuccessCriterion_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "public"."PlanObjective"("id") ON DELETE CASCADE ON UPDATE CASCADE;
