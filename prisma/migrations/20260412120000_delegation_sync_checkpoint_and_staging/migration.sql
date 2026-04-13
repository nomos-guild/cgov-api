-- CreateTable
CREATE TABLE "delegation_sync_checkpoint" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "account_info_stake_cursor" TEXT,
    "drep_shard_index" INTEGER NOT NULL DEFAULT 0,
    "last_full_all_dreps_scan_at" TIMESTAMP(3),
    "phase3_checkpoint_json" TEXT,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delegation_sync_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stake_delegation_staging" (
    "id" BIGSERIAL NOT NULL,
    "run_id" TEXT NOT NULL,
    "stake_address" TEXT NOT NULL,
    "drep_id" TEXT,
    "amount" TEXT,
    "delegated_epoch_no" INTEGER,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stake_delegation_staging_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stake_delegation_staging_run_id_idx" ON "stake_delegation_staging"("run_id");

-- CreateIndex
CREATE INDEX "stake_delegation_staging_stake_address_idx" ON "stake_delegation_staging"("stake_address");
