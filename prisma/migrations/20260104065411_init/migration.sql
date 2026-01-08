-- CreateEnum
CREATE TYPE "governance_type" AS ENUM ('INFO_ACTION', 'TREASURY_WITHDRAWALS', 'NEW_CONSTITUTION', 'HARD_FORK_INITIATION', 'PROTOCOL_PARAMETER_CHANGE', 'NO_CONFIDENCE', 'UPDATE_COMMITTEE');

-- CreateEnum
CREATE TYPE "proposal_status" AS ENUM ('ACTIVE', 'RATIFIED', 'ENACTED', 'EXPIRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "vote_type" AS ENUM ('YES', 'NO', 'ABSTAIN');

-- CreateEnum
CREATE TYPE "voter_type" AS ENUM ('DREP', 'SPO', 'CC');

-- CreateTable
CREATE TABLE "cc" (
    "cc_id" TEXT NOT NULL,
    "user_id" TEXT,
    "member_name" TEXT,
    "hot_credential" TEXT,
    "cold_credential" TEXT,
    "status" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "cc_pkey" PRIMARY KEY ("cc_id")
);

-- CreateTable
CREATE TABLE "crowdfunding_campaign" (
    "id" SERIAL NOT NULL,
    "proposal_draft_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "crowdfunding_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drep" (
    "drep_id" TEXT NOT NULL,
    "user_id" TEXT,
    "name" TEXT,
    "payment_addr" TEXT,
    "icon_url" TEXT,
    "do_not_list" BOOLEAN,
    "voting_power" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "drep_pkey" PRIMARY KEY ("drep_id")
);

-- CreateTable
CREATE TABLE "sync_status" (
    "job_name" TEXT NOT NULL,
    "display_name" TEXT,
    "is_running" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "last_result" TEXT,
    "error_message" TEXT,
    "items_processed" INTEGER,
    "locked_by" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_status_pkey" PRIMARY KEY ("job_name")
);

-- CreateTable
CREATE TABLE "ncl" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "epoch" INTEGER NOT NULL,
    "current" BIGINT NOT NULL DEFAULT 0,
    "limit" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ncl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onchain_vote" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "vote" "vote_type",
    "voter_type" "voter_type" NOT NULL,
    "voting_power" BIGINT,
    "anchor_url" TEXT,
    "anchor_hash" TEXT,
    "rationale" TEXT,
    "voted_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "drep_id" TEXT,
    "spo_id" TEXT,
    "cc_id" TEXT,

    CONSTRAINT "onchain_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal" (
    "id" SERIAL NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "cert_index" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "rationale" TEXT,
    "governance_action_type" "governance_type",
    "status" "proposal_status" NOT NULL DEFAULT 'ACTIVE',
    "submission_epoch" INTEGER,
    "ratified_epoch" INTEGER,
    "enacted_epoch" INTEGER,
    "dropped_epoch" INTEGER,
    "expired_epoch" INTEGER,
    "expiration_epoch" INTEGER,
    "drep_total_vote_power" BIGINT,
    "drep_active_yes_vote_power" BIGINT,
    "drep_active_no_vote_power" BIGINT,
    "drep_active_abstain_vote_power" BIGINT,
    "drep_always_abstain_vote_power" BIGINT,
    "drep_always_no_confidence_power" BIGINT,
    "drep_inactive_vote_power" BIGINT,
    "spo_total_vote_power" BIGINT,
    "spo_active_yes_vote_power" BIGINT,
    "spo_active_no_vote_power" BIGINT,
    "spo_active_abstain_vote_power" BIGINT,
    "spo_always_abstain_vote_power" BIGINT,
    "spo_always_no_confidence_power" BIGINT,
    "metadata" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_draft" (
    "id" SERIAL NOT NULL,
    "governance_action_type" "governance_type" NOT NULL,
    "title" TEXT NOT NULL,
    "abstract" TEXT,
    "motivation" TEXT,
    "rationale" TEXT,
    "comment" TEXT,
    "references" TEXT,
    "external_updates" TEXT,
    "metadata" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "proposal_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spo" (
    "pool_id" TEXT NOT NULL,
    "user_id" TEXT,
    "pool_name" TEXT,
    "ticker" TEXT,
    "icon_url" TEXT,
    "voting_power" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "spo_pkey" PRIMARY KEY ("pool_id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "wallet_address" TEXT,
    "stake_key_lovelace" DOUBLE PRECISION,
    "jwt" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cc_user_id_key" ON "cc"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "crowdfunding_campaign_proposal_draft_id_key" ON "crowdfunding_campaign"("proposal_draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "drep_user_id_key" ON "drep"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ncl_year_key" ON "ncl"("year");

-- CreateIndex
CREATE UNIQUE INDEX "onchain_vote_tx_hash_proposal_id_voter_type_drep_id_spo_id__key" ON "onchain_vote"("tx_hash", "proposal_id", "voter_type", "drep_id", "spo_id", "cc_id");

-- CreateIndex
CREATE UNIQUE INDEX "proposal_proposal_id_key" ON "proposal"("proposal_id");

-- CreateIndex
CREATE UNIQUE INDEX "proposal_tx_hash_cert_index_key" ON "proposal"("tx_hash", "cert_index");

-- CreateIndex
CREATE UNIQUE INDEX "spo_user_id_key" ON "spo"("user_id");

-- AddForeignKey
ALTER TABLE "cc" ADD CONSTRAINT "cc_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crowdfunding_campaign" ADD CONSTRAINT "crowdfunding_campaign_proposal_draft_id_fkey" FOREIGN KEY ("proposal_draft_id") REFERENCES "proposal_draft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drep" ADD CONSTRAINT "drep_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onchain_vote" ADD CONSTRAINT "onchain_vote_cc_id_fkey" FOREIGN KEY ("cc_id") REFERENCES "cc"("cc_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onchain_vote" ADD CONSTRAINT "onchain_vote_drep_id_fkey" FOREIGN KEY ("drep_id") REFERENCES "drep"("drep_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onchain_vote" ADD CONSTRAINT "onchain_vote_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("proposal_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onchain_vote" ADD CONSTRAINT "onchain_vote_spo_id_fkey" FOREIGN KEY ("spo_id") REFERENCES "spo"("pool_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spo" ADD CONSTRAINT "spo_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
