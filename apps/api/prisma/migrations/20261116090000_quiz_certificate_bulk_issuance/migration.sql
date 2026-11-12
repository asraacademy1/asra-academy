-- Additive migration for Academy Quiz Certificate Generation & Bulk Issuance.
-- Zero destructive statements; safe on existing databases and preserves all existing records.

-- CreateEnum
CREATE TYPE "quiz_certificate_category" AS ENUM ('PARTICIPATION', 'RANK');

-- CreateEnum
CREATE TYPE "quiz_certificate_recipient_mode" AS ENUM ('ALL_PARTICIPANTS', 'RANKERS_ONLY', 'SELECTED_RANKS', 'INDIVIDUAL_PARTICIPANTS');

-- CreateEnum
CREATE TYPE "quiz_certificate_format" AS ENUM ('PDF', 'PNG', 'BOTH');

-- CreateEnum
CREATE TYPE "quiz_certificate_batch_status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

-- CreateEnum
CREATE TYPE "quiz_certificate_generation_status" AS ENUM ('PENDING', 'PROCESSING', 'GENERATED', 'FAILED');

-- CreateEnum
CREATE TYPE "quiz_certificate_email_status" AS ENUM ('NOT_REQUESTED', 'PENDING', 'SENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "certificates" ADD COLUMN     "certificate_category" VARCHAR(30),
ADD COLUMN     "issued_formats" TEXT[] DEFAULT ARRAY['PDF', 'PNG']::TEXT[],
ADD COLUMN     "quiz_attempt_id" UUID,
ADD COLUMN     "quiz_rank" INTEGER,
ADD COLUMN     "visible_in_student_dashboard" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "quiz_certificate_issuance_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "quiz_id" UUID NOT NULL,
    "initiated_by_id" UUID,
    "recipient_mode" "quiz_certificate_recipient_mode" NOT NULL,
    "format" "quiz_certificate_format" NOT NULL DEFAULT 'BOTH',
    "send_email" BOOLEAN NOT NULL DEFAULT true,
    "show_in_student_dashboard" BOOLEAN NOT NULL DEFAULT true,
    "template_config" JSONB NOT NULL DEFAULT '{}',
    "status" "quiz_certificate_batch_status" NOT NULL DEFAULT 'PENDING',
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "excluded_duplicates" INTEGER NOT NULL DEFAULT 0,
    "total_queued" INTEGER NOT NULL DEFAULT 0,
    "generated_count" INTEGER NOT NULL DEFAULT 0,
    "generation_failed_count" INTEGER NOT NULL DEFAULT 0,
    "emails_sent_count" INTEGER NOT NULL DEFAULT 0,
    "emails_failed_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_certificate_issuance_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_certificate_issuance_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "quiz_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "category" "quiz_certificate_category" NOT NULL,
    "rank" INTEGER,
    "score" DECIMAL(8,2),
    "percent" DECIMAL(5,2),
    "recipient_name" VARCHAR(150) NOT NULL,
    "recipient_email" VARCHAR(320) NOT NULL,
    "certificate_id" UUID,
    "certificate_number" VARCHAR(50),
    "pdf_reference" VARCHAR(255),
    "png_reference" VARCHAR(255),
    "generation_status" "quiz_certificate_generation_status" NOT NULL DEFAULT 'PENDING',
    "generation_attempts" INTEGER NOT NULL DEFAULT 0,
    "generation_error" VARCHAR(500),
    "claimed_at" TIMESTAMPTZ(3),
    "email_status" "quiz_certificate_email_status" NOT NULL DEFAULT 'NOT_REQUESTED',
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "email_error" VARCHAR(500),
    "email_claimed_at" TIMESTAMPTZ(3),
    "email_provider_message_id" VARCHAR(120),
    "email_sent_at" TIMESTAMPTZ(3),
    "issued_by_id" UUID,
    "issued_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_certificate_issuance_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quiz_certificate_issuance_batches_quiz_id_created_at_idx" ON "quiz_certificate_issuance_batches"("quiz_id", "created_at");

-- CreateIndex
CREATE INDEX "quiz_certificate_issuance_batches_status_created_at_idx" ON "quiz_certificate_issuance_batches"("status", "created_at");

-- CreateIndex
CREATE INDEX "quiz_certificate_issuance_batches_initiated_by_id_idx" ON "quiz_certificate_issuance_batches"("initiated_by_id");

-- CreateIndex
CREATE INDEX "quiz_certificate_issuance_items_batch_id_generation_status_idx" ON "quiz_certificate_issuance_items"("batch_id", "generation_status");

-- CreateIndex
CREATE INDEX "quiz_certificate_issuance_items_batch_id_email_status_idx" ON "quiz_certificate_issuance_items"("batch_id", "email_status");

-- CreateIndex
CREATE INDEX "quiz_certificate_issuance_items_quiz_id_user_id_category_idx" ON "quiz_certificate_issuance_items"("quiz_id", "user_id", "category");

-- CreateIndex
CREATE INDEX "quiz_certificate_issuance_items_generation_status_claimed_a_idx" ON "quiz_certificate_issuance_items"("generation_status", "claimed_at");

-- CreateIndex
CREATE INDEX "quiz_certificate_issuance_items_email_status_email_claimed__idx" ON "quiz_certificate_issuance_items"("email_status", "email_claimed_at");

-- CreateIndex
CREATE INDEX "quiz_certificate_issuance_items_certificate_id_idx" ON "quiz_certificate_issuance_items"("certificate_id");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_certificate_issuance_items_batch_id_user_id_category_key" ON "quiz_certificate_issuance_items"("batch_id", "user_id", "category");

-- Partial unique index: at most one active ISSUED certificate per student, quiz, and category.
CREATE UNIQUE INDEX "certificates_active_quiz_user_category_key"
  ON "certificates" ("academy_quiz_id", "user_id", "certificate_category")
  WHERE "status" = 'ISSUED' AND "academy_quiz_id" IS NOT NULL AND "user_id" IS NOT NULL AND "certificate_category" IS NOT NULL;

-- Partial unique index: at most one in-flight (PENDING/PROCESSING) issuance item per student, quiz, and category.
CREATE UNIQUE INDEX "quiz_certificate_items_inflight_quiz_user_category_key"
  ON "quiz_certificate_issuance_items" ("quiz_id", "user_id", "category")
  WHERE "generation_status" IN ('PENDING', 'PROCESSING');

-- AddForeignKey
ALTER TABLE "quiz_certificate_issuance_batches" ADD CONSTRAINT "quiz_certificate_issuance_batches_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "academy_quizzes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_certificate_issuance_batches" ADD CONSTRAINT "quiz_certificate_issuance_batches_initiated_by_id_fkey" FOREIGN KEY ("initiated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_certificate_issuance_items" ADD CONSTRAINT "quiz_certificate_issuance_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "quiz_certificate_issuance_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_certificate_issuance_items" ADD CONSTRAINT "quiz_certificate_issuance_items_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "academy_quizzes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_certificate_issuance_items" ADD CONSTRAINT "quiz_certificate_issuance_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_certificate_issuance_items" ADD CONSTRAINT "quiz_certificate_issuance_items_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "assessment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_certificate_issuance_items" ADD CONSTRAINT "quiz_certificate_issuance_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "certificate_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_certificate_issuance_items" ADD CONSTRAINT "quiz_certificate_issuance_items_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_certificate_issuance_items" ADD CONSTRAINT "quiz_certificate_issuance_items_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
