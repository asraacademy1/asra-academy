-- PHASE 17 — Generic Certificate Management Module (additive migration)
-- Preserves all existing Phase 13 certificate records, verification codes, and URLs.

-- CreateEnum
CREATE TYPE "certificate_source_type" AS ENUM ('COURSE', 'ACADEMY_QUIZ', 'COMPETITION', 'EXAM', 'EVENT', 'WORKSHOP', 'TRAINING', 'MANUAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "certificate_template_style" AS ENUM ('CLASSIC_INSTITUTIONAL', 'MODERN_MINIMAL', 'PREMIUM_ACHIEVEMENT');

-- AlterTable
ALTER TABLE "certificates" ADD COLUMN     "academy_quiz_id" UUID,
ADD COLUMN     "achievement_details" VARCHAR(500),
ADD COLUMN     "certificate_title" VARCHAR(160) NOT NULL DEFAULT 'Certificate of Completion',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "examination_id" UUID,
ADD COLUMN     "idempotency_key" VARCHAR(180),
ADD COLUMN     "recipient_email" VARCHAR(320),
ADD COLUMN     "recipient_student_code" VARCHAR(50),
ADD COLUMN     "reissued_from_id" UUID,
ADD COLUMN     "revoked_by_id" UUID,
ADD COLUMN     "signature_snapshots" JSONB,
ADD COLUMN     "source_label" VARCHAR(120),
ADD COLUMN     "source_reference_id" VARCHAR(120),
ADD COLUMN     "source_type" "certificate_source_type" NOT NULL DEFAULT 'COURSE',
ADD COLUMN     "template_id" UUID,
ADD COLUMN     "template_snapshot" JSONB,
ALTER COLUMN "enrollment_id" DROP NOT NULL,
ALTER COLUMN "user_id" DROP NOT NULL,
ALTER COLUMN "course_id" DROP NOT NULL,
ALTER COLUMN "completed_at" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "certificate_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(60) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "style" "certificate_template_style" NOT NULL,
    "description" VARCHAR(500),
    "default_title" VARCHAR(160) NOT NULL,
    "default_subtitle" VARCHAR(200),
    "default_body_text" VARCHAR(1000) NOT NULL,
    "issuing_authority" VARCHAR(160) NOT NULL DEFAULT 'ASRA Academy',
    "config" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_signatures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "full_name" VARCHAR(150) NOT NULL,
    "designation" VARCHAR(150) NOT NULL,
    "department" VARCHAR(150),
    "storage_provider" VARCHAR(30) NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "image_url" VARCHAR(2048),
    "mime_type" VARCHAR(50) NOT NULL DEFAULT 'image/png',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "has_transparency" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_template_signatures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "position_label" VARCHAR(40) NOT NULL,
    "show_name" BOOLEAN NOT NULL DEFAULT true,
    "show_designation" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_template_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_settings" (
    "id" VARCHAR(32) NOT NULL DEFAULT 'default',
    "academy_name" VARCHAR(160) NOT NULL DEFAULT 'ASRA Academy',
    "academy_tagline" VARCHAR(220) NOT NULL DEFAULT 'Academy of Islamic & Contemporary Studies',
    "default_template_id" UUID,
    "verification_notice" VARCHAR(500) NOT NULL DEFAULT 'Tamper-resistant credential registered in ASRA Academy central database.',
    "show_qr_on_certificates" BOOLEAN NOT NULL DEFAULT true,
    "auto_issue_on_course_completion" BOOLEAN NOT NULL DEFAULT true,
    "auto_issue_on_quiz_completion" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "certificate_id" UUID NOT NULL,
    "verification_code" VARCHAR(50) NOT NULL,
    "qr_payload_url" VARCHAR(500) NOT NULL,
    "verified_count" INTEGER NOT NULL DEFAULT 0,
    "last_verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action" VARCHAR(80) NOT NULL,
    "actor_id" UUID,
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "certificate_id" UUID,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "certificate_templates_key_key" ON "certificate_templates"("key");

-- CreateIndex
CREATE INDEX "certificate_templates_is_active_is_default_idx" ON "certificate_templates"("is_active", "is_default");

-- CreateIndex
CREATE INDEX "certificate_templates_created_by_id_idx" ON "certificate_templates"("created_by_id");

-- CreateIndex
CREATE INDEX "certificate_templates_updated_by_id_idx" ON "certificate_templates"("updated_by_id");

-- CreateIndex
CREATE INDEX "certificate_signatures_is_active_created_at_idx" ON "certificate_signatures"("is_active", "created_at");

-- CreateIndex
CREATE INDEX "certificate_signatures_created_by_id_idx" ON "certificate_signatures"("created_by_id");

-- CreateIndex
CREATE INDEX "certificate_signatures_updated_by_id_idx" ON "certificate_signatures"("updated_by_id");

-- CreateIndex
CREATE INDEX "certificate_template_signatures_signature_id_idx" ON "certificate_template_signatures"("signature_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_template_signatures_template_id_signature_id_key" ON "certificate_template_signatures"("template_id", "signature_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_template_signatures_template_id_sort_order_key" ON "certificate_template_signatures"("template_id", "sort_order");

-- CreateIndex
CREATE INDEX "certificate_settings_default_template_id_idx" ON "certificate_settings"("default_template_id");

-- CreateIndex
CREATE INDEX "certificate_settings_updated_by_id_idx" ON "certificate_settings"("updated_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_verifications_certificate_id_key" ON "certificate_verifications"("certificate_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_verifications_verification_code_key" ON "certificate_verifications"("verification_code");

-- CreateIndex
CREATE INDEX "certificate_audit_logs_entity_type_entity_id_created_at_idx" ON "certificate_audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "certificate_audit_logs_certificate_id_created_at_idx" ON "certificate_audit_logs"("certificate_id", "created_at");

-- CreateIndex
CREATE INDEX "certificate_audit_logs_actor_id_idx" ON "certificate_audit_logs"("actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_idempotency_key_key" ON "certificates"("idempotency_key");

-- CreateIndex
CREATE INDEX "certificates_academy_quiz_id_status_idx" ON "certificates"("academy_quiz_id", "status");

-- CreateIndex
CREATE INDEX "certificates_examination_id_status_idx" ON "certificates"("examination_id", "status");

-- CreateIndex
CREATE INDEX "certificates_source_type_status_issued_at_idx" ON "certificates"("source_type", "status", "issued_at");

-- CreateIndex
CREATE INDEX "certificates_template_id_idx" ON "certificates"("template_id");

-- CreateIndex
CREATE INDEX "certificates_revoked_by_id_idx" ON "certificates"("revoked_by_id");

-- CreateIndex
CREATE INDEX "certificates_reissued_from_id_idx" ON "certificates"("reissued_from_id");

-- AddForeignKey
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_signatures" ADD CONSTRAINT "certificate_signatures_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_signatures" ADD CONSTRAINT "certificate_signatures_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_template_signatures" ADD CONSTRAINT "certificate_template_signatures_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "certificate_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_template_signatures" ADD CONSTRAINT "certificate_template_signatures_signature_id_fkey" FOREIGN KEY ("signature_id") REFERENCES "certificate_signatures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_settings" ADD CONSTRAINT "certificate_settings_default_template_id_fkey" FOREIGN KEY ("default_template_id") REFERENCES "certificate_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_settings" ADD CONSTRAINT "certificate_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_academy_quiz_id_fkey" FOREIGN KEY ("academy_quiz_id") REFERENCES "academy_quizzes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_examination_id_fkey" FOREIGN KEY ("examination_id") REFERENCES "examinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "certificate_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_reissued_from_id_fkey" FOREIGN KEY ("reissued_from_id") REFERENCES "certificates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_verifications" ADD CONSTRAINT "certificate_verifications_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_audit_logs" ADD CONSTRAINT "certificate_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_audit_logs" ADD CONSTRAINT "certificate_audit_logs_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- PHASE 17 CHECK constraints & non-destructive backfill for existing records
-- =============================================================================

ALTER TABLE "certificate_template_signatures" ADD CONSTRAINT "certificate_template_signatures_sort_order_range"
    CHECK ("sort_order" BETWEEN 0 AND 3);

ALTER TABLE "certificate_signatures" ADD CONSTRAINT "certificate_signatures_dimensions_positive"
    CHECK ("width" > 0 AND "height" > 0 AND "bytes" > 0);

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_enrollment_requires_course_and_user"
    CHECK ("enrollment_id" IS NULL OR ("course_id" IS NOT NULL AND "user_id" IS NOT NULL));

-- Backfill existing Phase 13 course certificates safely
UPDATE "certificates"
   SET "source_reference_id" = COALESCE("source_reference_id", "course_id"::text),
       "source_label" = COALESCE("source_label", 'Course'),
       "idempotency_key" = COALESCE("idempotency_key", 'COURSE:' || "enrollment_id"::text)
 WHERE "enrollment_id" IS NOT NULL;
