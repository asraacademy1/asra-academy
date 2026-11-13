-- Additive migration: ASRA QUIZORA 2026 "Certificate of Participation" artwork template style.
-- Zero destructive statements. Existing templates, issued certificates, template/signature
-- snapshots, verification records and audit history are untouched. Retiring the three legacy
-- templates (is_active = false, never deleted) is performed idempotently by the application
-- bootstrap (ensureCertificateDefaults) and is fully audit-logged.

-- AlterEnum
ALTER TYPE "certificate_template_style" ADD VALUE IF NOT EXISTS 'QUIZORA_PARTICIPATION';
