-- Academy Quizzes + shared question/option images (Phase 2). Purely ADDITIVE:
-- new enums/tables, nullable columns or columns with constant defaults (no table rewrite on
-- PostgreSQL ≥ 11), new indexes, and the two "single owner" CHECKs widened from 2 to 3 owners
-- (added NOT VALID, validated without blocking writes, then the old CHECK dropped).
-- Existing course quizzes, examinations, attempts and snapshots are untouched.

-- CreateEnum
CREATE TYPE "academy_quiz_timer_mode" AS ENUM ('OVERALL', 'PER_QUESTION');

-- CreateEnum
CREATE TYPE "question_navigation" AS ENUM ('FREE', 'LINEAR');

-- CreateEnum
CREATE TYPE "question_selection" AS ENUM ('ALL', 'RANDOM', 'BY_DIFFICULTY');

-- CreateEnum
CREATE TYPE "question_difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "result_release" AS ENUM ('IMMEDIATE', 'SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "leaderboard_visibility" AS ENUM ('HIDDEN', 'SIGNED_IN', 'PUBLIC');

-- CreateEnum
CREATE TYPE "attempt_counting" AS ENUM ('BEST', 'FIRST');

-- CreateEnum
CREATE TYPE "ranking_tie_break" AS ENUM ('TIME_TAKEN', 'SUBMITTED_AT');

-- CreateEnum
CREATE TYPE "media_status" AS ENUM ('ACTIVE', 'DELETING');

-- AlterTable
ALTER TABLE "assessment_attempts" ADD COLUMN     "academy_quiz_id" UUID,
ADD COLUMN     "current_position" INTEGER,
ADD COLUMN     "current_question_deadline_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "assessment_question_options" ADD COLUMN     "image_id" UUID;

-- AlterTable
ALTER TABLE "assessment_questions" ADD COLUMN     "academy_quiz_id" UUID,
ADD COLUMN     "difficulty" "question_difficulty",
ADD COLUMN     "image_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- AlterTable
ALTER TABLE "attempt_questions" ADD COLUMN     "media_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "assessment_media" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "public_id" VARCHAR(255) NOT NULL,
    "uploaded_by_id" UUID,
    "format" VARCHAR(10) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "status" "media_status" NOT NULL DEFAULT 'ACTIVE',
    "delete_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assessment_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy_quizzes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(120) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(500),
    "description" TEXT,
    "instructions" TEXT,
    "banner_media_id" UUID,
    "prizes" JSONB NOT NULL DEFAULT '[]',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "results_at" TIMESTAMPTZ(3),
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    "timer_mode" "academy_quiz_timer_mode" NOT NULL DEFAULT 'OVERALL',
    "duration_minutes" INTEGER,
    "question_time_seconds" INTEGER,
    "navigation" "question_navigation" NOT NULL DEFAULT 'FREE',
    "require_answer_to_advance" BOOLEAN NOT NULL DEFAULT false,
    "selection" "question_selection" NOT NULL DEFAULT 'ALL',
    "questions_per_attempt" INTEGER,
    "easy_count" INTEGER,
    "medium_count" INTEGER,
    "hard_count" INTEGER,
    "shuffle_questions" BOOLEAN NOT NULL DEFAULT false,
    "shuffle_options" BOOLEAN NOT NULL DEFAULT false,
    "negative_marking" BOOLEAN NOT NULL DEFAULT false,
    "pass_percent" INTEGER NOT NULL DEFAULT 40,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "eligible_class_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "eligible_stream_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "result_release" "result_release" NOT NULL DEFAULT 'IMMEDIATE',
    "answer_reveal" "answer_reveal" NOT NULL DEFAULT 'AFTER_CLOSE',
    "results_published_at" TIMESTAMPTZ(3),
    "leaderboard_visibility" "leaderboard_visibility" NOT NULL DEFAULT 'SIGNED_IN',
    "mask_names" BOOLEAN NOT NULL DEFAULT false,
    "attempt_counting" "attempt_counting" NOT NULL DEFAULT 'BEST',
    "tie_break" "ranking_tie_break" NOT NULL DEFAULT 'TIME_TAKEN',
    "status" "assessment_status" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "academy_quizzes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assessment_media_public_id_key" ON "assessment_media"("public_id");

-- CreateIndex
CREATE INDEX "assessment_media_status_created_at_idx" ON "assessment_media"("status", "created_at");

-- CreateIndex
CREATE INDEX "assessment_media_uploaded_by_id_created_at_idx" ON "assessment_media"("uploaded_by_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "academy_quizzes_slug_key" ON "academy_quizzes"("slug");

-- CreateIndex
CREATE INDEX "academy_quizzes_status_starts_at_idx" ON "academy_quizzes"("status", "starts_at");

-- CreateIndex
CREATE INDEX "academy_quizzes_status_ends_at_idx" ON "academy_quizzes"("status", "ends_at");

-- CreateIndex
CREATE INDEX "academy_quizzes_created_by_id_idx" ON "academy_quizzes"("created_by_id");

-- CreateIndex
CREATE INDEX "academy_quizzes_banner_media_id_idx" ON "academy_quizzes"("banner_media_id");

-- CreateIndex
CREATE INDEX "assessment_attempts_academy_quiz_id_status_idx" ON "assessment_attempts"("academy_quiz_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_attempts_academy_quiz_id_user_id_attempt_number_key" ON "assessment_attempts"("academy_quiz_id", "user_id", "attempt_number");

-- CreateIndex
CREATE INDEX "assessment_question_options_image_id_idx" ON "assessment_question_options"("image_id");

-- CreateIndex
CREATE INDEX "assessment_questions_academy_quiz_id_position_idx" ON "assessment_questions"("academy_quiz_id", "position");

-- CreateIndex
CREATE INDEX "assessment_questions_image_ids_idx" ON "assessment_questions" USING GIN ("image_ids");

-- CreateIndex
CREATE INDEX "attempt_questions_media_ids_idx" ON "attempt_questions" USING GIN ("media_ids");

-- AddForeignKey
ALTER TABLE "assessment_questions" ADD CONSTRAINT "assessment_questions_academy_quiz_id_fkey" FOREIGN KEY ("academy_quiz_id") REFERENCES "academy_quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_question_options" ADD CONSTRAINT "assessment_question_options_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "assessment_media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_media" ADD CONSTRAINT "assessment_media_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_academy_quiz_id_fkey" FOREIGN KEY ("academy_quiz_id") REFERENCES "academy_quizzes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_banner_media_id_fkey" FOREIGN KEY ("banner_media_id") REFERENCES "assessment_media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================
-- Hand-written CHECK constraints (Prisma schema cannot express them).
-- =============================================================================

-- Owners: exactly one of quiz / examination / academy quiz. The new constraint is added
-- NOT VALID (no scan), validated (SHARE UPDATE EXCLUSIVE: reads and writes continue), and only
-- then is the old two-owner constraint dropped, so rows are never unprotected.
ALTER TABLE "assessment_questions" ADD CONSTRAINT "assessment_questions_one_owner"
    CHECK (num_nonnulls("quiz_id", "examination_id", "academy_quiz_id") = 1) NOT VALID;
ALTER TABLE "assessment_questions" VALIDATE CONSTRAINT "assessment_questions_one_owner";
ALTER TABLE "assessment_questions" DROP CONSTRAINT "assessment_questions_single_owner";

ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_one_owner"
    CHECK (num_nonnulls("quiz_id", "examination_id", "academy_quiz_id") = 1) NOT VALID;
ALTER TABLE "assessment_attempts" VALIDATE CONSTRAINT "assessment_attempts_one_owner";
ALTER TABLE "assessment_attempts" DROP CONSTRAINT "assessment_attempts_single_owner";

-- Question images: never NULL (Prisma lists are nullable columns), at most 3.
ALTER TABLE "assessment_questions" ADD CONSTRAINT "assessment_questions_image_ids_range"
    CHECK ("image_ids" IS NOT NULL AND cardinality("image_ids") <= 3);
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_media_ids_not_null"
    CHECK ("media_ids" IS NOT NULL);

-- Linear-navigation state of an attempt.
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_current_position_non_negative"
    CHECK ("current_position" IS NULL OR "current_position" >= 0);
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_question_deadline_within_attempt"
    CHECK ("current_question_deadline_at" IS NULL
       OR ("deadline_at" IS NOT NULL AND "current_question_deadline_at" <= "deadline_at"));

-- Media ledger: only optimized raster formats within the strict 100 KB limit.
ALTER TABLE "assessment_media" ADD CONSTRAINT "assessment_media_format"
    CHECK ("format" IN ('webp', 'jpg', 'png'));
ALTER TABLE "assessment_media" ADD CONSTRAINT "assessment_media_bytes_range"
    CHECK ("bytes" BETWEEN 1 AND 102400);
ALTER TABLE "assessment_media" ADD CONSTRAINT "assessment_media_dimensions_range"
    CHECK ("width" BETWEEN 1 AND 2048 AND "height" BETWEEN 1 AND 2048);
ALTER TABLE "assessment_media" ADD CONSTRAINT "assessment_media_delete_attempts_non_negative"
    CHECK ("delete_attempts" >= 0);

-- Academy quizzes.
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_slug_format"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_title_not_blank"
    CHECK (length(btrim("title")) > 0);
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_window"
    CHECK ("ends_at" > "starts_at");
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_timer_consistent"
    CHECK (("timer_mode" = 'OVERALL'
              AND "duration_minutes" BETWEEN 1 AND 600 AND "question_time_seconds" IS NULL)
        OR ("timer_mode" = 'PER_QUESTION'
              AND "question_time_seconds" BETWEEN 10 AND 600 AND "duration_minutes" IS NULL
              AND "navigation" = 'LINEAR'));
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_advance_rule_linear_only"
    CHECK (NOT "require_answer_to_advance" OR "navigation" = 'LINEAR');
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_selection_consistent"
    CHECK (("selection" = 'ALL'
              AND "questions_per_attempt" IS NULL
              AND num_nonnulls("easy_count", "medium_count", "hard_count") = 0)
        OR ("selection" = 'RANDOM'
              AND "questions_per_attempt" >= 1
              AND num_nonnulls("easy_count", "medium_count", "hard_count") = 0)
        OR ("selection" = 'BY_DIFFICULTY'
              AND "questions_per_attempt" IS NULL
              AND num_nonnulls("easy_count", "medium_count", "hard_count") = 3
              AND "easy_count" >= 0 AND "medium_count" >= 0 AND "hard_count" >= 0
              AND "easy_count" + "medium_count" + "hard_count" >= 1));
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_results_at_iff_scheduled"
    CHECK (("result_release" = 'SCHEDULED') = ("results_at" IS NOT NULL));
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_max_attempts_range"
    CHECK ("max_attempts" BETWEEN 1 AND 5);
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_pass_percent_range"
    CHECK ("pass_percent" BETWEEN 0 AND 100);
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_eligibility_not_null"
    CHECK ("eligible_class_ids" IS NOT NULL AND "eligible_stream_ids" IS NOT NULL);
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_prizes_array"
    CHECK (jsonb_typeof("prizes") = 'array');
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_time_zone_not_blank"
    CHECK (length(btrim("time_zone")) > 0);
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_published_has_date"
    CHECK ("status" = 'DRAFT' OR "published_at" IS NOT NULL);
ALTER TABLE "academy_quizzes" ADD CONSTRAINT "academy_quizzes_closed_consistent"
    CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL));
