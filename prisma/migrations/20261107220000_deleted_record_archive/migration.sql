-- CreateEnum
CREATE TYPE "public"."DeletedEntityType" AS ENUM ('USER', 'PLAN');

-- CreateTable
CREATE TABLE "public"."DeletedRecord" (
    "id" TEXT NOT NULL,
    "entityType" "public"."DeletedEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "deletedById" TEXT,
    "deletedByName" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeletedRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeletedRecord_entityType_entityId_idx" ON "public"."DeletedRecord"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "DeletedRecord_deletedAt_idx" ON "public"."DeletedRecord"("deletedAt");
