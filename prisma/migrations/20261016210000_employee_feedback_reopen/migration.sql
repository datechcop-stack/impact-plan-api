-- AlterTable
ALTER TABLE "public"."Plan" ADD COLUMN "employeeFeedback" TEXT;
ALTER TABLE "public"."Plan" ADD COLUMN "employeeFeedbackAt" TIMESTAMP(3);
ALTER TABLE "public"."Plan" ADD COLUMN "revisionOpen" BOOLEAN NOT NULL DEFAULT false;
