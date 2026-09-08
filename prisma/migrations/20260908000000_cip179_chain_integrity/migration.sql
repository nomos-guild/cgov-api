ALTER TABLE "proposal" ADD COLUMN "meta_url" TEXT, ADD COLUMN "meta_hash" TEXT;
ALTER TABLE "cip179_transaction" ADD COLUMN "block_hash" TEXT;
ALTER TABLE "cip179_transaction" ADD COLUMN "survey_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "cip179_transaction_survey_keys_idx" ON "cip179_transaction" USING GIN ("survey_keys");
-- Cached derived tallies must be rebuilt with native metadata and lifecycle checks.
DELETE FROM "cip179_artifact";
UPDATE "sync_status" SET "last_result" = 'partial' WHERE "job_name" = 'cip179-sync';
