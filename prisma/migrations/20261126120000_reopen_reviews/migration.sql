-- AlterTable
ALTER TABLE "public"."Plan" ADD COLUMN "lmCommentReopenedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."PmReview" ADD COLUMN "reopenedAt" TIMESTAMP(3);
