-- AlterTable
ALTER TABLE "drep" ALTER COLUMN "voting_power" SET DEFAULT 0;
ALTER TABLE "drep" ADD COLUMN     "registered" BOOLEAN;
ALTER TABLE "drep" ADD COLUMN     "active" BOOLEAN;
ALTER TABLE "drep" ADD COLUMN     "expires_epoch" INTEGER;
ALTER TABLE "drep" ADD COLUMN     "meta_url" TEXT;
ALTER TABLE "drep" ADD COLUMN     "meta_hash" TEXT;

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
CREATE TABLE "drep_delegator_snapshot" (
    "id" SERIAL NOT NULL,
    "epoch_no" INTEGER NOT NULL,
    "drep_id" TEXT NOT NULL,
    "stake_address" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drep_delegator_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drep_delegator_snapshot_epoch_no_drep_id_stake_address_key" ON "drep_delegator_snapshot"("epoch_no", "drep_id", "stake_address");

-- CreateIndex
CREATE INDEX "drep_delegator_snapshot_epoch_no_drep_id_idx" ON "drep_delegator_snapshot"("epoch_no", "drep_id");

-- AddForeignKey
ALTER TABLE "drep_delegator_snapshot" ADD CONSTRAINT "drep_delegator_snapshot_drep_id_fkey" FOREIGN KEY ("drep_id") REFERENCES "drep"("drep_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "epoch_analytics_sync" (
    "epoch_no" INTEGER NOT NULL,
    "dreps_synced_at" TIMESTAMP(3),
    "totals_synced_at" TIMESTAMP(3),
    "delegators_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epoch_analytics_sync_pkey" PRIMARY KEY ("epoch_no")
);

