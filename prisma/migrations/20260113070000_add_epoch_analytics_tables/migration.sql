-- Align epoch analytics + delegation tracking schema

-- AlterTable
ALTER TABLE "drep" ALTER COLUMN "voting_power" SET DEFAULT 0;
ALTER TABLE "drep" ADD COLUMN     "registered" BOOLEAN;
ALTER TABLE "drep" ADD COLUMN     "active" BOOLEAN;
ALTER TABLE "drep" ADD COLUMN     "expires_epoch" INTEGER;
ALTER TABLE "drep" ADD COLUMN     "meta_url" TEXT;
ALTER TABLE "drep" ADD COLUMN     "meta_hash" TEXT;

-- AlterTable
ALTER TABLE "sync_status"
ADD COLUMN     "backfill_cursor" TEXT,
ADD COLUMN     "backfill_is_running" BOOLEAN DEFAULT false,
ADD COLUMN     "backfill_started_at" TIMESTAMP(3),
ADD COLUMN     "backfill_completed_at" TIMESTAMP(3),
ADD COLUMN     "backfill_items_processed" INTEGER,
ADD COLUMN     "backfill_items_total" INTEGER,
ADD COLUMN     "backfill_error_message" TEXT;

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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epoch_totals_pkey" PRIMARY KEY ("epoch_no")
);

-- CreateTable
CREATE TABLE "epoch_analytics_sync" (
    "epoch_no" INTEGER NOT NULL,
    "dreps_synced_at" TIMESTAMP(3),
    "drep_info_synced_at" TIMESTAMP(3),
    "totals_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epoch_analytics_sync_pkey" PRIMARY KEY ("epoch_no")
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
    "from_drep_id" TEXT,
    "to_drep_id" TEXT,
    "delegated_epoch_no" INTEGER,
    "amount" BIGINT,
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

-- CreateIndex
CREATE INDEX "stake_delegation_state_drep_id_idx" ON "stake_delegation_state"("drep_id");

-- CreateIndex
CREATE INDEX "stake_delegation_change_stake_address_idx" ON "stake_delegation_change"("stake_address");

-- CreateIndex
CREATE INDEX "stake_delegation_change_to_drep_id_idx" ON "stake_delegation_change"("to_drep_id");

-- CreateIndex (unique constraint to prevent duplicate change entries on job interruption/restart)
-- Uses COALESCE to handle NULLs since PostgreSQL treats NULLs as distinct in unique indexes
CREATE UNIQUE INDEX "stake_delegation_change_unique_change_idx" 
ON "stake_delegation_change"(
    "stake_address", 
    COALESCE("from_drep_id", ''), 
    COALESCE("to_drep_id", ''), 
    COALESCE("delegated_epoch_no", -1)
);

-- AddForeignKey
ALTER TABLE "stake_delegation_state" ADD CONSTRAINT "stake_delegation_state_stake_address_fkey" FOREIGN KEY ("stake_address") REFERENCES "stake_address"("stake_address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stake_delegation_state" ADD CONSTRAINT "stake_delegation_state_drep_id_fkey" FOREIGN KEY ("drep_id") REFERENCES "drep"("drep_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stake_delegation_change" ADD CONSTRAINT "stake_delegation_change_stake_address_fkey" FOREIGN KEY ("stake_address") REFERENCES "stake_address"("stake_address") ON DELETE RESTRICT ON UPDATE CASCADE;

