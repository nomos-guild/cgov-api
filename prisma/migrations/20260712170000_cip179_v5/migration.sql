ALTER TABLE "proposal"
ADD COLUMN "linked_survey_index" INTEGER;

-- Remove the incompatible draft-format storage used by the pre-v5 implementation.
ALTER TABLE "proposal"
DROP COLUMN "survey_details";

ALTER TABLE "onchain_vote"
DROP COLUMN "response_epoch",
DROP COLUMN "survey_response",
DROP COLUMN "survey_response_survey_tx_id",
DROP COLUMN "survey_response_responder_role";

CREATE TABLE "cip179_transaction" (
  "tx_hash" TEXT NOT NULL,
  "absolute_slot" BIGINT NOT NULL,
  "epoch_no" INTEGER NOT NULL,
  "tx_block_index" INTEGER,
  "payload" TEXT NOT NULL,
  "proof" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cip179_transaction_pkey" PRIMARY KEY ("tx_hash")
);

CREATE INDEX "cip179_transaction_absolute_slot_idx"
ON "cip179_transaction"("absolute_slot");

CREATE INDEX "cip179_transaction_epoch_no_idx"
ON "cip179_transaction"("epoch_no");

CREATE TABLE "cip179_artifact" (
  "survey_key" TEXT NOT NULL,
  "survey_tx_id" TEXT NOT NULL,
  "survey_index" INTEGER NOT NULL,
  "end_epoch" INTEGER NOT NULL,
  "artifact_hash" TEXT NOT NULL,
  "artifact" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cip179_artifact_pkey" PRIMARY KEY ("survey_key")
);

CREATE UNIQUE INDEX "cip179_artifact_artifact_hash_key"
ON "cip179_artifact"("artifact_hash");

CREATE INDEX "cip179_artifact_end_epoch_idx"
ON "cip179_artifact"("end_epoch");
