ALTER TABLE "proposal"
ADD COLUMN "linked_survey_tx_id" TEXT,
ADD COLUMN "survey_details" TEXT;

ALTER TABLE "onchain_vote"
ADD COLUMN "response_epoch" INTEGER,
ADD COLUMN "survey_response" TEXT,
ADD COLUMN "survey_response_survey_tx_id" TEXT,
ADD COLUMN "survey_response_responder_role" TEXT;
