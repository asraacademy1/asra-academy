-- Additive migration: ASRA QUIZORA 2026 "Certificate of Participation (Design 2)" artwork style.
-- Zero destructive statements. Template 1 (QUIZORA_PARTICIPATION), all other templates, issued
-- certificates, snapshots, verification records and audit history are untouched. The Design 2
-- template row is seeded idempotently by the application bootstrap (never as the default).

-- AlterEnum
ALTER TYPE "certificate_template_style" ADD VALUE IF NOT EXISTS 'QUIZORA_PARTICIPATION_DESIGN_2';
