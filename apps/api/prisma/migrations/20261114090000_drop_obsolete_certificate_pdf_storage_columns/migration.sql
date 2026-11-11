-- Forward-only cleanup for databases migrated prior to commit 3a8433b, when
-- Phase 17 finalized the data-only certificate architecture (in-memory PDF/PNG
-- rendering via pdfkit/sharp with no persisted generated certificate files).
-- DROP COLUMN IF EXISTS is a safe no-op on fresh databases and on databases
-- where only the committed Phase 17 migration was applied.

ALTER TABLE "certificates"
  DROP COLUMN IF EXISTS "pdf_storage_key",
  DROP COLUMN IF EXISTS "pdf_storage_provider",
  DROP COLUMN IF EXISTS "pdf_url";
