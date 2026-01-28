-- Align epoch analytics + delegation tracking schema
-- Includes: DRep lifecycle events, Pool groups, Epoch info timestamps

-- ============================================================
-- AlterTable: drep - Add Koios /drep_info fields
-- ============================================================
ALTER TABLE "drep" ALTER COLUMN "voting_power" SET DEFAULT 0;
ALTER TABLE "drep" ADD COLUMN IF NOT EXISTS "registered" BOOLEAN;
ALTER TABLE "drep" ADD COLUMN IF NOT EXISTS "active" BOOLEAN;
ALTER TABLE "drep" ADD COLUMN IF NOT EXISTS "expires_epoch" INTEGER;
ALTER TABLE "drep" ADD COLUMN IF NOT EXISTS "meta_url" TEXT;
ALTER TABLE "drep" ADD COLUMN IF NOT EXISTS "meta_hash" TEXT;

-- ============================================================
-- AlterTable: sync_status - Add backfill tracking fields
-- ============================================================
ALTER TABLE "sync_status"
ADD COLUMN IF NOT EXISTS "backfill_cursor" TEXT,
ADD COLUMN IF NOT EXISTS "backfill_is_running" BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS "backfill_started_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "backfill_completed_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "backfill_items_processed" INTEGER,
ADD COLUMN IF NOT EXISTS "backfill_items_total" INTEGER,
ADD COLUMN IF NOT EXISTS "backfill_error_message" TEXT;

-- ============================================================
-- CreateTable: epoch_totals - Epoch-level denominators + timestamps for analytics
-- Includes timestamps from /epoch_info for wall-clock calculations
-- ============================================================
CREATE TABLE IF NOT EXISTS "epoch_totals" (
    "epoch_no" INTEGER NOT NULL,
    "circulation" BIGINT,
    "treasury" BIGINT,
    "reward" BIGINT,
    "supply" BIGINT,
    "reserves" BIGINT,
    "delegated_drep_power" BIGINT,
    "total_pool_vote_power" BIGINT,
    -- Epoch timestamps from /epoch_info for wall-clock calculations
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

-- Add timestamp columns to epoch_totals if table already exists
ALTER TABLE "epoch_totals"
ADD COLUMN IF NOT EXISTS "start_time" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "end_time" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "first_block_time" INTEGER,
ADD COLUMN IF NOT EXISTS "last_block_time" INTEGER,
ADD COLUMN IF NOT EXISTS "block_count" INTEGER,
ADD COLUMN IF NOT EXISTS "tx_count" INTEGER;

-- ============================================================
-- CreateTable: epoch_analytics_sync - Per-epoch sync checkpoints
-- ============================================================
CREATE TABLE IF NOT EXISTS "epoch_analytics_sync" (
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

-- Add new columns to epoch_analytics_sync if table already exists
ALTER TABLE "epoch_analytics_sync"
ADD COLUMN IF NOT EXISTS "drep_lifecycle_synced_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "pool_groups_synced_at" TIMESTAMP(3);

-- ============================================================
-- CreateTable: stake_address - Inventory for delegation tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS "stake_address" (
    "stake_address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stake_address_pkey" PRIMARY KEY ("stake_address")
);

-- ============================================================
-- CreateTable: stake_delegation_state - Current delegation per stake address
-- ============================================================
CREATE TABLE IF NOT EXISTS "stake_delegation_state" (
    "stake_address" TEXT NOT NULL,
    "drep_id" TEXT,
    "amount" BIGINT,
    "delegated_epoch_no" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stake_delegation_state_pkey" PRIMARY KEY ("stake_address")
);

-- ============================================================
-- CreateTable: stake_delegation_change - Append-only change log
-- Uses sentinel values: "" for no DRep, -1 for unknown epoch
-- ============================================================
CREATE TABLE IF NOT EXISTS "stake_delegation_change" (
    "id" SERIAL NOT NULL,
    "stake_address" TEXT NOT NULL,
    "from_drep_id" TEXT NOT NULL DEFAULT '',
    "to_drep_id" TEXT NOT NULL DEFAULT '',
    "delegated_epoch_no" INTEGER NOT NULL DEFAULT -1,
    "amount" BIGINT,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stake_delegation_change_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- CreateTable: stake_delegation_sync_state - Global sync state
-- ============================================================
CREATE TABLE IF NOT EXISTS "stake_delegation_sync_state" (
    "id" TEXT NOT NULL,
    "last_processed_epoch" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stake_delegation_sync_state_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- CreateTable: drep_lifecycle_event - DRep registration/deregistration events
-- Enables DRep Lifecycle Rate KPI
-- ============================================================
CREATE TABLE IF NOT EXISTS "drep_lifecycle_event" (
    "id" SERIAL NOT NULL,
    "drep_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "epoch_no" INTEGER NOT NULL,
    "block_time" INTEGER,
    "tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drep_lifecycle_event_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- CreateTable: pool_group - Multi-pool operator groupings
-- Enables SPO Entity Voting Power Concentration KPI
-- Each pool belongs to exactly one group; multiple pools can share a group
-- ============================================================
CREATE TABLE IF NOT EXISTS "pool_group" (
    "pool_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "group_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_group_pkey" PRIMARY KEY ("pool_id")
);

-- Note: Epoch timestamps are now stored in epoch_totals table
-- (fetched together with /totals and /drep_epoch_summary from /epoch_info)

-- ============================================================
-- CreateIndexes: stake_delegation_state
-- ============================================================
CREATE INDEX IF NOT EXISTS "stake_delegation_state_drep_id_idx" ON "stake_delegation_state"("drep_id");

-- ============================================================
-- CreateIndexes: stake_delegation_change
-- ============================================================
CREATE INDEX IF NOT EXISTS "stake_delegation_change_stake_address_idx" ON "stake_delegation_change"("stake_address");
CREATE INDEX IF NOT EXISTS "stake_delegation_change_to_drep_id_idx" ON "stake_delegation_change"("to_drep_id");

-- Unique constraint to prevent duplicate change entries on job interruption/restart
ALTER TABLE "stake_delegation_change"
ADD CONSTRAINT "stake_delegation_change_stake_address_from_drep_id_to_drep__key"
UNIQUE ("stake_address", "from_drep_id", "to_drep_id", "delegated_epoch_no");

-- ============================================================
-- CreateIndexes: drep_lifecycle_event
-- ============================================================
CREATE INDEX IF NOT EXISTS "drep_lifecycle_event_drep_id_idx" ON "drep_lifecycle_event"("drep_id");
CREATE INDEX IF NOT EXISTS "drep_lifecycle_event_epoch_no_idx" ON "drep_lifecycle_event"("epoch_no");
CREATE INDEX IF NOT EXISTS "drep_lifecycle_event_action_idx" ON "drep_lifecycle_event"("action");

-- Unique constraint to prevent duplicate lifecycle events
ALTER TABLE "drep_lifecycle_event" 
ADD CONSTRAINT "drep_lifecycle_event_drep_id_action_epoch_no_tx_hash_key" 
UNIQUE ("drep_id", "action", "epoch_no", "tx_hash");

-- ============================================================
-- CreateIndexes: pool_group
-- ============================================================
-- Note: pool_id is the primary key, so no separate unique index needed
CREATE INDEX IF NOT EXISTS "pool_group_group_id_idx" ON "pool_group"("group_id");

-- ============================================================
-- AddForeignKeys: stake_delegation_state
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'stake_delegation_state_stake_address_fkey'
    ) THEN
        ALTER TABLE "stake_delegation_state" 
        ADD CONSTRAINT "stake_delegation_state_stake_address_fkey" 
        FOREIGN KEY ("stake_address") REFERENCES "stake_address"("stake_address") 
        ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'stake_delegation_state_drep_id_fkey'
    ) THEN
        ALTER TABLE "stake_delegation_state" 
        ADD CONSTRAINT "stake_delegation_state_drep_id_fkey" 
        FOREIGN KEY ("drep_id") REFERENCES "drep"("drep_id") 
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- ============================================================
-- AddForeignKeys: stake_delegation_change
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'stake_delegation_change_stake_address_fkey'
    ) THEN
        ALTER TABLE "stake_delegation_change" 
        ADD CONSTRAINT "stake_delegation_change_stake_address_fkey" 
        FOREIGN KEY ("stake_address") REFERENCES "stake_address"("stake_address") 
        ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

