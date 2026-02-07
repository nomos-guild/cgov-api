-- AlterTable
ALTER TABLE "drep" ADD COLUMN     "active" BOOLEAN,
ADD COLUMN     "expires_epoch" INTEGER,
ADD COLUMN     "meta_hash" TEXT,
ADD COLUMN     "meta_url" TEXT,
ADD COLUMN     "registered" BOOLEAN,
ALTER COLUMN "voting_power" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "sync_status" ADD COLUMN     "backfill_completed_at" TIMESTAMP(3),
ADD COLUMN     "backfill_cursor" TEXT,
ADD COLUMN     "backfill_error_message" TEXT,
ADD COLUMN     "backfill_is_running" BOOLEAN DEFAULT false,
ADD COLUMN     "backfill_items_processed" INTEGER,
ADD COLUMN     "backfill_items_total" INTEGER,
ADD COLUMN     "backfill_started_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "epoch_totals" (
    "epoch_no" INTEGER NOT NULL,
    "circulation" BIGINT,
    "treasury" BIGINT,
    "reward" BIGINT,
    "supply" BIGINT,
    "reserves" BIGINT,
    "delegated_drep_power" BIGINT,
    "total_pool_vote_power" BIGINT,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "first_block_time" INTEGER,
    "last_block_time" INTEGER,
    "block_count" INTEGER,
    "tx_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epoch_totals_pkey" PRIMARY KEY ("epoch_no")
);

-- CreateTable
CREATE TABLE "stake_address" (
    "stake_address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stake_address_pkey" PRIMARY KEY ("stake_address")
);

-- CreateTable
CREATE TABLE "stake_delegation_state" (
    "stake_address" TEXT NOT NULL,
    "drep_id" TEXT,
    "amount" BIGINT,
    "delegated_epoch_no" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stake_delegation_state_pkey" PRIMARY KEY ("stake_address")
);

-- CreateTable
CREATE TABLE "stake_delegation_change" (
    "id" SERIAL NOT NULL,
    "stake_address" TEXT NOT NULL,
    "from_drep_id" TEXT NOT NULL DEFAULT '',
    "to_drep_id" TEXT NOT NULL DEFAULT '',
    "delegated_epoch_no" INTEGER NOT NULL DEFAULT -1,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stake_delegation_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stake_delegation_sync_state" (
    "id" TEXT NOT NULL,
    "last_processed_epoch" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stake_delegation_sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epoch_analytics_sync" (
    "epoch_no" INTEGER NOT NULL,
    "dreps_synced_at" TIMESTAMP(3),
    "drep_info_synced_at" TIMESTAMP(3),
    "totals_synced_at" TIMESTAMP(3),
    "drep_lifecycle_synced_at" TIMESTAMP(3),
    "pool_groups_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epoch_analytics_sync_pkey" PRIMARY KEY ("epoch_no")
);

-- CreateTable
CREATE TABLE "drep_lifecycle_event" (
    "id" SERIAL NOT NULL,
    "drep_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "epoch_no" INTEGER NOT NULL,
    "block_time" INTEGER,
    "tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drep_lifecycle_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_group" (
    "pool_id" TEXT NOT NULL,
    "pool_group" TEXT NOT NULL,
    "ticker" TEXT,
    "adastat_group" TEXT,
    "balanceanalytics_group" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_group_pkey" PRIMARY KEY ("pool_id")
);

-- CreateIndex
CREATE INDEX "stake_delegation_state_drep_id_idx" ON "stake_delegation_state"("drep_id");

-- CreateIndex
CREATE INDEX "stake_delegation_change_stake_address_idx" ON "stake_delegation_change"("stake_address");

-- CreateIndex
CREATE INDEX "stake_delegation_change_to_drep_id_idx" ON "stake_delegation_change"("to_drep_id");

-- CreateIndex
CREATE UNIQUE INDEX "stake_delegation_change_stake_address_from_drep_id_to_drep__key" ON "stake_delegation_change"("stake_address", "from_drep_id", "to_drep_id", "delegated_epoch_no");

-- CreateIndex
CREATE INDEX "drep_lifecycle_event_drep_id_idx" ON "drep_lifecycle_event"("drep_id");

-- CreateIndex
CREATE INDEX "drep_lifecycle_event_epoch_no_idx" ON "drep_lifecycle_event"("epoch_no");

-- CreateIndex
CREATE INDEX "drep_lifecycle_event_action_idx" ON "drep_lifecycle_event"("action");

-- CreateIndex
CREATE INDEX "pool_group_pool_group_idx" ON "pool_group"("pool_group");

-- CreateIndex
CREATE INDEX "proposal_tx_hash_idx" ON "proposal"("tx_hash");

-- AddForeignKey
ALTER TABLE "stake_delegation_state" ADD CONSTRAINT "stake_delegation_state_stake_address_fkey" FOREIGN KEY ("stake_address") REFERENCES "stake_address"("stake_address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stake_delegation_state" ADD CONSTRAINT "stake_delegation_state_drep_id_fkey" FOREIGN KEY ("drep_id") REFERENCES "drep"("drep_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stake_delegation_change" ADD CONSTRAINT "stake_delegation_change_stake_address_fkey" FOREIGN KEY ("stake_address") REFERENCES "stake_address"("stake_address") ON DELETE RESTRICT ON UPDATE CASCADE;
