-- AlterTable
ALTER TABLE "drep" ADD COLUMN     "bio" TEXT,
ADD COLUMN     "motivations" TEXT,
ADD COLUMN     "objectives" TEXT,
ADD COLUMN     "qualifications" TEXT,
ADD COLUMN     "references" TEXT;

-- AlterTable
ALTER TABLE "epoch_analytics_sync" ADD COLUMN     "drep_snapshot_synced_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "drep_epoch_snapshot" (
    "id" SERIAL NOT NULL,
    "drep_id" TEXT NOT NULL,
    "epoch_no" INTEGER NOT NULL,
    "delegator_count" INTEGER NOT NULL,
    "voting_power" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drep_epoch_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "drep_epoch_snapshot_drep_id_idx" ON "drep_epoch_snapshot"("drep_id");

-- CreateIndex
CREATE INDEX "drep_epoch_snapshot_epoch_no_idx" ON "drep_epoch_snapshot"("epoch_no");

-- CreateIndex
CREATE UNIQUE INDEX "drep_epoch_snapshot_drep_id_epoch_no_key" ON "drep_epoch_snapshot"("drep_id", "epoch_no");

-- AddForeignKey
ALTER TABLE "drep_epoch_snapshot" ADD CONSTRAINT "drep_epoch_snapshot_drep_id_fkey" FOREIGN KEY ("drep_id") REFERENCES "drep"("drep_id") ON DELETE RESTRICT ON UPDATE CASCADE;
