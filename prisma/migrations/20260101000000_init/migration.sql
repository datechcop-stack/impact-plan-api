-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('ADMIN', 'STAFF');

-- CreateEnum
CREATE TYPE "public"."AuthMethod" AS ENUM ('UNSET', 'PASSWORD', 'OTP');

-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "public"."PlanStatus" AS ENUM ('DRAFT', 'LOCKED', 'PARTLY_UNLOCKED', 'UNLOCKED', 'REVIEW_OPEN', 'IN_REVIEW', 'FINALIZED');

-- CreateEnum
CREATE TYPE "public"."ComponentType" AS ENUM ('PROJECTS', 'BD', 'TECH_PERSONAL', 'COP');

-- CreateEnum
CREATE TYPE "public"."ComponentLockState" AS ENUM ('LOCKED', 'UNLOCKED');

-- CreateEnum
CREATE TYPE "public"."EditRequestScope" AS ENUM ('WHOLE', 'COMPONENT');

-- CreateEnum
CREATE TYPE "public"."EditRequestStatus" AS ENUM ('PENDING', 'DECLINED', 'UNLOCKED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "public"."SelfAssessmentResult" AS ENUM ('ACHIEVED', 'PARTLY', 'NOT');

-- CreateEnum
CREATE TYPE "public"."PmReviewStatus" AS ENUM ('DRAFT', 'REVIEWED');

-- CreateEnum
CREATE TYPE "public"."OtpPurpose" AS ENUM ('ACTIVATION', 'LOGIN', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "public"."ReviewCycleAudience" AS ENUM ('ALL_WITH_PLAN', 'SELECTED');

-- CreateEnum
CREATE TYPE "public"."ReviewCycleStatus" AS ENUM ('SCHEDULED', 'OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "jobTitle" TEXT,
    "role" "public"."Role" NOT NULL DEFAULT 'STAFF',
    "authMethod" "public"."AuthMethod" NOT NULL DEFAULT 'UNSET',
    "passwordHash" TEXT,
    "lineManagerId" TEXT,
    "status" "public"."UserStatus" NOT NULL DEFAULT 'INVITED',
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Invitation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "remindCreatePlan" BOOLEAN NOT NULL DEFAULT true,
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OtpChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "public"."OtpPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Plan" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "public"."PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "lineManagerComment" TEXT,
    "submittedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "finalScore" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlanComponent" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "type" "public"."ComponentType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "lockState" "public"."ComponentLockState" NOT NULL DEFAULT 'LOCKED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlanEntry" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "successCriteria" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SelfAssessment" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "result" "public"."SelfAssessmentResult" NOT NULL,
    "resultText" TEXT NOT NULL,
    "evidenceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PmReview" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "score" INTEGER,
    "comment" TEXT,
    "status" "public"."PmReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PmReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EditRequest" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "scope" "public"."EditRequestScope" NOT NULL,
    "componentType" "public"."ComponentType",
    "changeTypes" TEXT[],
    "reason" TEXT NOT NULL,
    "status" "public"."EditRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ChangeLog" (
    "id" TEXT NOT NULL,
    "planId" TEXT,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReviewCycle" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "windowOpens" DATE NOT NULL,
    "selfAssessmentDeadline" DATE NOT NULL,
    "pmScoringDeadline" DATE NOT NULL,
    "finalizeDeadline" DATE NOT NULL,
    "audience" "public"."ReviewCycleAudience" NOT NULL DEFAULT 'ALL_WITH_PLAN',
    "remindOnOpen" BOOLEAN NOT NULL DEFAULT true,
    "remindBeforeDeadlines" BOOLEAN NOT NULL DEFAULT true,
    "weeklyLmSummary" BOOLEAN NOT NULL DEFAULT false,
    "status" "public"."ReviewCycleStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReviewCycleParticipant" (
    "id" TEXT NOT NULL,
    "reviewCycleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ReviewCycleParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReminderLog" (
    "id" TEXT NOT NULL,
    "reviewCycleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE INDEX "User_lineManagerId_idx" ON "public"."User"("lineManagerId");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "public"."User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_userId_key" ON "public"."Invitation"("userId");

-- CreateIndex
CREATE INDEX "Invitation_tokenHash_idx" ON "public"."Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_expiresAt_idx" ON "public"."Invitation"("expiresAt");

-- CreateIndex
CREATE INDEX "OtpChallenge_userId_purpose_idx" ON "public"."OtpChallenge"("userId", "purpose");

-- CreateIndex
CREATE INDEX "OtpChallenge_expiresAt_idx" ON "public"."OtpChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "public"."Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "public"."Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "public"."Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Plan_status_idx" ON "public"."Plan"("status");

-- CreateIndex
CREATE INDEX "Plan_year_idx" ON "public"."Plan"("year");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_ownerId_year_key" ON "public"."Plan"("ownerId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "PlanComponent_planId_type_key" ON "public"."PlanComponent"("planId", "type");

-- CreateIndex
CREATE INDEX "PlanEntry_managerId_idx" ON "public"."PlanEntry"("managerId");

-- CreateIndex
CREATE INDEX "PlanEntry_componentId_idx" ON "public"."PlanEntry"("componentId");

-- CreateIndex
CREATE UNIQUE INDEX "SelfAssessment_entryId_key" ON "public"."SelfAssessment"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "PmReview_entryId_key" ON "public"."PmReview"("entryId");

-- CreateIndex
CREATE INDEX "PmReview_reviewerId_idx" ON "public"."PmReview"("reviewerId");

-- CreateIndex
CREATE INDEX "PmReview_status_idx" ON "public"."PmReview"("status");

-- CreateIndex
CREATE INDEX "EditRequest_status_idx" ON "public"."EditRequest"("status");

-- CreateIndex
CREATE INDEX "EditRequest_planId_idx" ON "public"."EditRequest"("planId");

-- CreateIndex
CREATE INDEX "ChangeLog_createdAt_idx" ON "public"."ChangeLog"("createdAt");

-- CreateIndex
CREATE INDEX "ChangeLog_planId_idx" ON "public"."ChangeLog"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCycle_year_key" ON "public"."ReviewCycle"("year");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCycleParticipant_reviewCycleId_userId_key" ON "public"."ReviewCycleParticipant"("reviewCycleId", "userId");

-- CreateIndex
CREATE INDEX "ReminderLog_reviewCycleId_kind_idx" ON "public"."ReminderLog"("reviewCycleId", "kind");

-- AddForeignKey
ALTER TABLE "public"."User" ADD CONSTRAINT "User_lineManagerId_fkey" FOREIGN KEY ("lineManagerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Invitation" ADD CONSTRAINT "Invitation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OtpChallenge" ADD CONSTRAINT "OtpChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Plan" ADD CONSTRAINT "Plan_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Plan" ADD CONSTRAINT "Plan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlanComponent" ADD CONSTRAINT "PlanComponent_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlanEntry" ADD CONSTRAINT "PlanEntry_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "public"."PlanComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlanEntry" ADD CONSTRAINT "PlanEntry_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SelfAssessment" ADD CONSTRAINT "SelfAssessment_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "public"."PlanEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PmReview" ADD CONSTRAINT "PmReview_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "public"."PlanEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PmReview" ADD CONSTRAINT "PmReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EditRequest" ADD CONSTRAINT "EditRequest_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EditRequest" ADD CONSTRAINT "EditRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EditRequest" ADD CONSTRAINT "EditRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChangeLog" ADD CONSTRAINT "ChangeLog_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChangeLog" ADD CONSTRAINT "ChangeLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReviewCycleParticipant" ADD CONSTRAINT "ReviewCycleParticipant_reviewCycleId_fkey" FOREIGN KEY ("reviewCycleId") REFERENCES "public"."ReviewCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReviewCycleParticipant" ADD CONSTRAINT "ReviewCycleParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReminderLog" ADD CONSTRAINT "ReminderLog_reviewCycleId_fkey" FOREIGN KEY ("reviewCycleId") REFERENCES "public"."ReviewCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

