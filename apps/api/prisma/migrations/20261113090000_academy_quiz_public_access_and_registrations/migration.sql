-- Academy Quiz public access & verified registration (additive migration).
-- Adds public/private visibility (defaults to PUBLIC for existing published quizzes)
-- and an explicit academy_quiz_registrations table separate from assessment attempts.

-- CreateEnum
CREATE TYPE "academy_quiz_visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- AlterTable
ALTER TABLE "academy_quizzes" ADD COLUMN "visibility" "academy_quiz_visibility" NOT NULL DEFAULT 'PUBLIC';

-- CreateTable
CREATE TABLE "academy_quiz_registrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "quiz_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academy_quiz_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "academy_quizzes_status_visibility_starts_at_idx" ON "academy_quizzes"("status", "visibility", "starts_at");

-- CreateIndex
CREATE INDEX "academy_quizzes_status_visibility_ends_at_idx" ON "academy_quizzes"("status", "visibility", "ends_at");

-- CreateIndex
CREATE INDEX "academy_quiz_registrations_user_id_registered_at_idx" ON "academy_quiz_registrations"("user_id", "registered_at");

-- CreateIndex
CREATE INDEX "academy_quiz_registrations_quiz_id_registered_at_idx" ON "academy_quiz_registrations"("quiz_id", "registered_at");

-- CreateIndex
CREATE UNIQUE INDEX "academy_quiz_registrations_quiz_id_user_id_key" ON "academy_quiz_registrations"("quiz_id", "user_id");

-- AddForeignKey
ALTER TABLE "academy_quiz_registrations" ADD CONSTRAINT "academy_quiz_registrations_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "academy_quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_quiz_registrations" ADD CONSTRAINT "academy_quiz_registrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
