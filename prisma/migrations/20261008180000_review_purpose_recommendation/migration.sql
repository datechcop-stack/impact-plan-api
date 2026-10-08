-- CreateEnum
CREATE TYPE "public"."ReviewWindowPurpose" AS ENUM ('MIDYEAR_PLAN_UPDATE', 'YEAR_END_REVIEW');

-- AlterTable
ALTER TABLE "public"."ReviewCycle" ADD COLUMN "purpose" "public"."ReviewWindowPurpose" NOT NULL DEFAULT 'YEAR_END_REVIEW';

-- AlterTable
ALTER TABLE "public"."Plan" ADD COLUMN "recommendation" TEXT;
