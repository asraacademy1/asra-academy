-- Website Announcements & Popups Module (additive migration).

-- CreateEnum
CREATE TYPE "announcement_display_type" AS ENUM ('MODAL', 'TOP_BANNER');

-- CreateEnum
CREATE TYPE "announcement_frequency" AS ENUM ('EVERY_VISIT', 'ONCE_PER_SESSION', 'ONCE_PER_VISITOR');

-- CreateEnum
CREATE TYPE "announcement_audience" AS ENUM ('ALL', 'PUBLIC_VISITORS', 'STUDENTS', 'PARENTS', 'FACULTY');

-- CreateEnum
CREATE TYPE "announcement_status" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'PAUSED', 'EXPIRED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "image_media_id" UUID,
    "display_type" "announcement_display_type" NOT NULL DEFAULT 'MODAL',
    "cta_text" VARCHAR(60),
    "redirect_url" VARCHAR(2048),
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "display_delay_seconds" INTEGER NOT NULL DEFAULT 3,
    "frequency" "announcement_frequency" NOT NULL DEFAULT 'ONCE_PER_SESSION',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "audience" "announcement_audience" NOT NULL DEFAULT 'ALL',
    "status" "announcement_status" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "paused_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_status_priority_published_at_idx" ON "announcements"("status", "priority", "published_at");

-- CreateIndex
CREATE INDEX "announcements_status_starts_at_ends_at_idx" ON "announcements"("status", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "announcements_audience_status_idx" ON "announcements"("audience", "status");

-- CreateIndex
CREATE INDEX "announcements_display_type_status_idx" ON "announcements"("display_type", "status");

-- CreateIndex
CREATE INDEX "announcements_image_media_id_idx" ON "announcements"("image_media_id");

-- CreateIndex
CREATE INDEX "announcements_created_by_id_idx" ON "announcements"("created_by_id");

-- CreateIndex
CREATE INDEX "announcements_created_at_idx" ON "announcements"("created_at");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_image_media_id_fkey" FOREIGN KEY ("image_media_id") REFERENCES "assessment_media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written CHECK constraints
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_title_not_blank"
    CHECK (length(btrim("title")) > 0);
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_priority_range"
    CHECK ("priority" BETWEEN 0 AND 1000);
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_delay_range"
    CHECK ("display_delay_seconds" BETWEEN 0 AND 300);
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_window"
    CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at");
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_cta_requires_redirect"
    CHECK ("cta_text" IS NULL OR "redirect_url" IS NOT NULL);
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_redirect_url_safe"
    CHECK ("redirect_url" IS NULL OR ("redirect_url" = '/' OR "redirect_url" ~ '^/[^/\\]' OR "redirect_url" ~* '^https://'));
